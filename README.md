# Sur Dorado - App de Vendedores

App para que vendedores en la calle consulten sus clientes del día, qué compraron
y en qué artículos, desde el celular (se instala como app, sin pasar por tiendas).

No usa librerías externas: solo Node.js (con su base de datos SQLite incluida). Esto
significa que no hace falta `npm install`, lo que evita problemas de instalación.

## Estructura

```
server/
  server.js   - servidor HTTP y todas las rutas de la API
  db.js       - base de datos SQLite (se crea sola en data/app.db)
  auth.js     - login y sesiones
  seed.js     - crea los usuarios iniciales (correr una sola vez)
public/
  index.html, app.js  - la app que ve el vendedor en el celular
  manifest.webmanifest, sw.js, icon.svg - para que se pueda "instalar"
```

## Usuarios iniciales

Definidos en `server/seed.js`:
- Admin: usuario `surdorado`, clave `luca1901`
- Vendedores (compartido para todos): usuario `vendedores`, clave `vende2026`

Podés cambiar estas claves editando `server/seed.js` antes de correrlo, o pedirme
que agregue una pantalla de gestión de usuarios más adelante.

## Cómo probarlo en tu computadora (opcional, antes de subirlo)

Necesitás tener Node.js 22.5 o más nuevo instalado (node.js.org).

```
npm run seed     (una sola vez, crea los usuarios)
npm start        (levanta el servidor en http://localhost:3000)
```

## Cómo publicarlo en internet (Render, plan gratuito)

1. Entrá a https://render.com y creá una cuenta gratis.
2. Subí esta carpeta a un repositorio de GitHub (Render se conecta desde ahí).
   - Si no usás git/GitHub, avisame y te dejo el paso a paso para crear el repositorio.
3. En Render: "New" → "Web Service" → conectá el repositorio.
4. Configuración:
   - Build Command: (dejar vacío, no hace falta)
   - Start Command: `npm start`
   - Plan: Free
5. Antes de que quede accesible para todos, hay que correr el seed una sola vez.
   Render tiene una consola ("Shell") en el panel del servicio: ahí corrés
   `npm run seed`.
6. Render te da una URL tipo `https://sur-dorado-vendedores.onrender.com`. Esa es
   la que le pasás a los vendedores.

## Cómo lo instalan los vendedores en el celular

1. Abren la URL en Chrome (Android) o Safari (iPhone).
2. Chrome: menú (⋮) → "Instalar app" o "Agregar a pantalla de inicio".
   Safari: botón compartir → "Agregar a pantalla de inicio".
3. Les queda un ícono como cualquier app. La sesión queda iniciada hasta que
   toquen "Salir" a propósito.

## Cómo cargás los datos todos los días

Por ahora, la carga de datos se hace llamando al endpoint `/api/upload` con
usuario admin, mandando los clientes (desde Universo) y las ventas (desde el
archivo diario) ya procesados en JSON. Esto es lo próximo que armamos: una
pantalla simple donde subís el Excel del día (se procesa en el navegador,
igual que en el dashboard grande) y se manda solo a este servidor.

## Importante sobre el plan gratuito de Render

- El servidor "duerme" si nadie lo usa por un rato y tarda ~30 segundos en
  despertar la próxima vez que alguien entra. Para consultas ocasionales
  durante el día no debería notarse mucho.
- Los discos del plan gratuito **no son permanentes**: si Render reinicia el
  servicio, se puede perder la base de datos. Para este primer uso (probar
  el flujo) no es grave, pero antes de depender de esto en el día a día,
  conviene pasar a un disco persistente (plan pago chico, ~7 USD/mes) o a
  una base de datos externa gratuita (te puedo armar cualquiera de las dos
  opciones cuando estés listo).
