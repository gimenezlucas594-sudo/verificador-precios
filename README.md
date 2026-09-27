# Verificador de precios (web)

- `/` → pantalla del verificador (se deja abierta en la compu con el lector)
- `/admin` → carga de productos con contraseña (desde cualquier compu o celular)

## Probar en tu compu (VS Code)

```bash
npm install
npm start
```

Abrí http://localhost:3000 y http://localhost:3000/admin (contraseña por defecto: `admin123`).
Sin `DATABASE_URL` guarda todo en `data/productos.json`, sirve solo para probar.

## Subir a Render

1. **Base de datos gratis en Neon** (no vence, el Postgres gratis de Render se borra a los 30 días):
   - Entrá a https://neon.tech, creá un proyecto y copiá la *connection string*
     (`postgresql://usuario:clave@ep-xxxx.neon.tech/neondb?sslmode=require`).
2. **Subí el proyecto a GitHub** (repo nuevo, por ejemplo `verificador-precios`).
3. **En Render** → *New* → *Blueprint* → elegí el repo. Detecta `render.yaml` y te pide:
   - `ADMIN_PASSWORD`: la contraseña del panel.
   - `DATABASE_URL`: la URL de Neon.
4. Esperá el deploy y listo: `https://verificador-precios.onrender.com`.

Las tablas se crean solas al arrancar.

## Cada compu con lector

Abrí la URL en Chrome y tocá la pantalla para pantalla completa. Para que arranque sola en modo kiosco,
creá un acceso directo en Windows con este destino:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk https://verificador-precios.onrender.com
```

y ponelo en la carpeta de inicio (`Win + R` → `shell:startup`). Para salir del modo kiosco: `Alt + F4`.

## Cómo funciona sin cortes

- Cada verificador descarga la lista completa y busca **en la compu**: la respuesta es instantánea.
- Cada 2 minutos pregunta si hubo cambios. Si no hubo, no descarga nada.
- Si se cae internet, sigue funcionando con los últimos precios (arriba a la derecha dice "Sin conexión").
- Si escaneás un producto recién cargado que todavía no llegó, lo pide directo al servidor.
- Render gratis "duerme" el servidor tras 15 min sin uso; la consulta cada 2 min lo mantiene despierto.

## Ajustes

Al principio del `<script>` de `public/index.html`:

- `NOMBRE_LOCAL`: texto de arriba a la izquierda.
- `DURACION_MS`: tiempo que se muestra el precio (8000 = 8 s).
- `SINCRONIZAR_CADA_MS`: cada cuánto busca precios nuevos.

## CSV

Una línea por producto: `codigo;nombre;precio` (también acepta `,` o tab). El encabezado es opcional.
Precios como `1500`, `1500,50` o `1.500`. Si el código ya existe, se actualiza.
