// Verificador de precios - servidor web
// - Con DATABASE_URL usa PostgreSQL (Render / Neon / etc.)
// - Sin DATABASE_URL guarda en data/productos.json (para probar en tu compu)

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠  ADMIN_PASSWORD no está configurada: usando "admin123". Cambiala en Render.');
}

// ---------- Utilidades ----------
// Acepta "1500", "1500,50", "1.500", "1.500,50", "$ 1500"
function parsePrecio(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').replace(/[$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}

// Divide una línea CSV respetando comillas
function dividirLinea(linea, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (q) {
      if (ch === '"') { if (linea[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function validarProducto(p) {
  const codigo = String(p.codigo ?? '').trim();
  const nombre = String(p.nombre ?? '').trim();
  const precio = parsePrecio(p.precio);
  if (!codigo) throw new Error('Falta el código');
  if (!nombre) throw new Error('Falta el nombre');
  if (!Number.isFinite(precio) || precio < 0) throw new Error('Precio inválido');
  return { codigo, nombre, precio: Math.round(precio * 100) / 100 };
}

// Algunos lectores agregan o sacan ceros adelante (UPC-A vs EAN-13):
// se compara primero exacto y después ignorando los ceros iniciales
const sinCeros = c => String(c).trim().replace(/^0+/, '');

// ---------- Almacenamiento: PostgreSQL ----------
function crearStorePostgres() {
  const { Pool } = require('pg');
  const host = (() => { try { return new URL(DATABASE_URL).hostname; } catch { return ''; } })();
  // Hosts internos de Render (sin punto) y localhost no usan SSL; los externos sí
  const usarSSL = process.env.DATABASE_SSL
    ? process.env.DATABASE_SSL === 'true'
    : host.includes('.') && host !== '127.0.0.1';
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: usarSSL ? { rejectUnauthorized: false } : false,
    max: 5
  });
  const fila = r => ({ codigo: r.codigo, nombre: r.nombre, precio: Number(r.precio) });

  async function subirVersion(client) {
    await (client || pool).query(`UPDATE meta SET valor = valor + 1 WHERE clave = 'version'`);
  }

  return {
    tipo: 'PostgreSQL',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS productos (
          codigo      TEXT PRIMARY KEY,
          nombre      TEXT NOT NULL,
          precio      NUMERIC(14,2) NOT NULL,
          actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS meta (
          clave TEXT PRIMARY KEY,
          valor BIGINT NOT NULL
        );
        INSERT INTO meta (clave, valor) VALUES ('version', 1) ON CONFLICT (clave) DO NOTHING;
      `);
    },
    async version() {
      const r = await pool.query(`SELECT valor FROM meta WHERE clave = 'version'`);
      return String(r.rows[0]?.valor ?? 1);
    },
    async listar() {
      const r = await pool.query(`SELECT codigo, nombre, precio FROM productos ORDER BY nombre`);
      return r.rows.map(fila);
    },
    async buscar(codigo) {
      const c = String(codigo).trim();
      const r = await pool.query(
        `SELECT codigo, nombre, precio FROM productos
         WHERE codigo = $1 OR ltrim(codigo, '0') = $2
         ORDER BY (codigo = $1) DESC LIMIT 1`,
        [c, sinCeros(c)]
      );
      return r.rows[0] ? fila(r.rows[0]) : null;
    },
    async guardar(p) {
      await pool.query(
        `INSERT INTO productos (codigo, nombre, precio) VALUES ($1, $2, $3)
         ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre, precio = EXCLUDED.precio, actualizado = now()`,
        [p.codigo, p.nombre, p.precio]
      );
      await subirVersion();
      return p;
    },
    async eliminar(codigo) {
      await pool.query(`DELETE FROM productos WHERE codigo = $1`, [String(codigo).trim()]);
      await subirVersion();
    },
    async guardarVarios(lista) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const p of lista) {
          await client.query(
            `INSERT INTO productos (codigo, nombre, precio) VALUES ($1, $2, $3)
             ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre, precio = EXCLUDED.precio, actualizado = now()`,
            [p.codigo, p.nombre, p.precio]
          );
        }
        await subirVersion(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  };
}

// ---------- Almacenamiento: archivo JSON (solo para pruebas locales) ----------
function crearStoreJSON() {
  const dir = path.join(__dirname, 'data');
  const archivo = path.join(dir, 'productos.json');
  let db = { version: 1, productos: {} };

  function guardarArchivo() {
    const tmp = archivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, archivo);
  }

  return {
    tipo: 'archivo JSON local (data/productos.json)',
    async init() {
      fs.mkdirSync(dir, { recursive: true });
      try { db = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { guardarArchivo(); }
    },
    async version() { return String(db.version); },
    async listar() {
      return Object.values(db.productos).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    },
    async buscar(codigo) {
      const c = String(codigo).trim();
      if (db.productos[c]) return db.productos[c];
      const s = sinCeros(c);
      return Object.values(db.productos).find(p => sinCeros(p.codigo) === s) || null;
    },
    async guardar(p) { db.productos[p.codigo] = p; db.version++; guardarArchivo(); return p; },
    async eliminar(codigo) { delete db.productos[String(codigo).trim()]; db.version++; guardarArchivo(); },
    async guardarVarios(lista) {
      for (const p of lista) db.productos[p.codigo] = p;
      db.version++; guardarArchivo();
    }
  };
}

const store = DATABASE_URL ? crearStorePostgres() : crearStoreJSON();

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

// Comparación de contraseña a tiempo constante
function claveOK(clave) {
  const a = Buffer.from(String(clave || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function soloAdmin(req, res, next) {
  if (claveOK(req.get('x-admin-key'))) return next();
  res.status(401).json({ error: 'Contraseña incorrecta' });
}

const envolver = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(err => {
    console.error(err);
    res.status(400).json({ error: err.message || 'Error' });
  });

// Estado (sirve también para que Render sepa que está vivo)
app.get('/api/salud', envolver(async (_req, res) => {
  res.json({ ok: true, almacenamiento: store.tipo, version: await store.version() });
}));

// Catálogo completo para el verificador (lo guarda en la compu y busca local, instantáneo)
// ?v=<version> → si no cambió devuelve { sinCambios: true } y no manda todo de nuevo
app.get('/api/catalogo', envolver(async (req, res) => {
  const version = await store.version();
  res.set('Cache-Control', 'no-store');
  if (req.query.v && req.query.v === version) return res.json({ version, sinCambios: true });
  res.json({ version, productos: await store.listar() });
}));

app.get('/api/buscar/:codigo', envolver(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ producto: await store.buscar(req.params.codigo) });
}));

// ---- Admin ----
app.post('/api/login', (req, res) => {
  if (claveOK(req.body?.clave)) return res.json({ ok: true });
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.get('/api/productos', soloAdmin, envolver(async (_req, res) => {
  res.json(await store.listar());
}));

app.post('/api/productos', soloAdmin, envolver(async (req, res) => {
  res.json(await store.guardar(validarProducto(req.body || {})));
}));

app.delete('/api/productos/:codigo', soloAdmin, envolver(async (req, res) => {
  await store.eliminar(req.params.codigo);
  res.json({ ok: true });
}));

// Importar CSV: codigo;nombre;precio (con o sin encabezado, separador ; , o tab)
app.post('/api/importar', soloAdmin, envolver(async (req, res) => {
  const texto = String(typeof req.body === 'string' ? req.body : req.body?.texto || '').replace(/^﻿/, '');
  const lista = [];
  let omitidos = 0;
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    const sep = linea.includes(';') ? ';' : (linea.includes('\t') ? '\t' : ',');
    const [codigo, nombre, precioTxt] = dividirLinea(linea, sep);
    try { lista.push(validarProducto({ codigo, nombre: nombre || '(sin nombre)', precio: precioTxt })); }
    catch { omitidos++; } // encabezado o línea rota
  }
  if (lista.length) await store.guardarVarios(lista);
  res.json({ importados: lista.length, omitidos });
}));

// Exportar CSV (formato Excel Argentina: ; y coma decimal)
app.get('/api/exportar', soloAdmin, envolver(async (_req, res) => {
  const esc = s => /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lineas = ['codigo;nombre;precio'];
  for (const p of await store.listar()) {
    lineas.push(`${esc(p.codigo)};${esc(p.nombre)};${String(p.precio).replace('.', ',')}`);
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="productos.csv"');
  res.send('﻿' + lineas.join('\r\n'));
}));

// ---- Páginas ----
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---- Despertador: evita que Render gratis duerma el servidor ----
// Render apaga el servicio gratis tras 15 min sin visitas. Cada 10 min el servidor
// se visita a sí mismo por su URL pública, así nunca queda 15 min sin tráfico.
// Render define RENDER_EXTERNAL_URL solo; en tu compu no hace nada.
function iniciarDespertador() {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.URL_PUBLICA;
  if (!base || process.env.DESPERTADOR === 'off') return;
  const url = base.replace(/\/$/, '') + '/api/salud';
  const CADA_MS = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      console.log(`⏰ Despertador: ${r.status} ${new Date().toISOString()}`);
    } catch (err) {
      console.warn('⏰ Despertador falló:', err.message);
    }
  }, CADA_MS);
  console.log(`⏰ Despertador activo: ${url} cada 10 min`);
}

store.init()
  .then(() => app.listen(PORT, () => {
    console.log(`✔ Verificador en http://localhost:${PORT}  (admin: /admin)`);
    console.log(`  Almacenamiento: ${store.tipo}`);
    iniciarDespertador();
  }))
  .catch(err => {
    console.error('No se pudo iniciar la base de datos:', err.message);
    process.exit(1);
  });
