# Calculadora de Márgenes VE — Web

Calculadora de márgenes para vendedores en Venezuela: costo en USD, tasa del día (BCV dólar, Binance USDT P2P, Euro BCV o personalizada), comisiones y margen deseado → precio de venta en bolívares sin perder dinero.

Sin build: solo archivos estáticos (`index.html` + `styles.css` + `app.js`), más Firebase por CDN para las cuentas. Responsive: se ve bien en PC y en teléfono.

## Cuentas, historial y productos

La calculadora funciona **como invitada sin entrar**, con todo lo de siempre. Al entrar con tu cuenta se activan:

- **Historial de cálculos:** cada cálculo se guarda en Firestore en `users/{uid}/history` con el esquema de la app (título, costo en USD, margen en %, comisiones en fracción, gasto fijo, redondeo, fuente y valor de la tasa, precio final en Bs y fecha ISO). Se guarda solo al copiar el precio o con el botón “Guardar cálculo”. Desde el historial puedes cargar un cálculo de nuevo en la calculadora, borrar uno o limpiar todo. Los cálculos guardados en la app aparecen aquí y viceversa.
- **Mis productos:** guarda tus productos con costo en USD, margen sugerido, comisiones y gasto fijo en `users/{uid}/products`, con el mismo esquema de la app. Al cargar un producto, la calculadora se llena sola con sus datos. Se pueden agregar, editar y eliminar. Los productos de la app aparecen aquí y viceversa.
- **Inicio de sesión:** con Google (popup, con fallback a redirect si el navegador lo bloquea) o con correo y contraseña (registro con nombre y restablecer contraseña por correo). La sesión persiste al cerrar el navegador.

Cada usuario solo ve y toca sus propios datos: las reglas de `firestore.rules` solo permiten leer/escribir bajo `users/{uid}/**` al dueño de esa cuenta. Nada más queda abierto.

## Esquema compartido con la app Flutter

La web y la app de Android comparten el mismo proyecto de Firebase (`calc-margenes-ve-2026`) y las mismas colecciones: un cálculo o producto guardado en una aparece en la otra. Los campos y unidades son los de la app:

| Colección | Campos | Unidades / valores |
|---|---|---|
| `users/{uid}/history` | `v`, `id`, `title`, `costUsd`, `marginPercent`, `fixedExpenseBs`, `commissionPlatform`, `commissionPaymentMethod`, `commissionOther`, `roundStep`, `rateSourceName`, `marginMode`, `rateValue`, `finalPriceBs`, `timestamp` | `marginPercent` en % (ej. 20); comisiones en fracción (ej. 0,015 = 1,5 %); `rateSourceName`: `bcvUsd`, `binanceUsdt`, `euroBcv` o `custom`; `marginMode`: `onSale`; `timestamp`: string ISO-8601 |
| `users/{uid}/products` | mismos parámetros que el historial, con `name` en vez de `title`, más `customRateValue` (solo si la tasa es personalizada), `createdAt` y `updatedAt` | fechas en string ISO-8601 |

Dos reglas que la web cumple para que la app pueda leer lo que escribe: el ID del documento se genera en la web y se guarda también en el campo `id` de cada documento, y las fechas se escriben como strings ISO-8601, nunca como `serverTimestamp()` (la app no lo parsea y descartaría la entrada). La web escribe `marginMode: 'onSale'` siempre, porque su fórmula es margen sobre el precio de venta; si falta ese campo, la app asumiría `onCost` y calcularía mal. Los productos viejos de la web (con `nombre`, `margenSugerido` y comisiones en %) se migran solos al abrir la lista: la web les pone el campo `id`, convierte las fechas a ISO y las comisiones a fracción.

## Puesta en marcha con Firebase

La config web del proyecto ya está en `firebase-config.js`. Si clonas el proyecto para tu propia cuenta, pon ahí tu config.

1. **Crear la app web en la consola de Firebase:** console.firebase.google.com → proyecto “Calculadora Margenes VE” → Configuración del proyecto → “Tus apps” → “Agregar app” → Web (`</>`) → copia los valores en `firebase-config.js`.
2. **Activar los proveedores de inicio de sesión:** en la consola → Authentication → Sign-in method → activa **Google** y **Correo/contraseña**. Sin esto, el login devuelve error `auth/operation-not-allowed`.
3. **Crear la base de Firestore y publicar las reglas:** en la consola → Firestore Database → “Crear base de datos” (modo producción, la ubicación que prefieras) → luego publica el archivo `firestore.rules` de este proyecto (con Firebase CLI: `firebase deploy --only firestore:rules`, o pégalo en la pestaña Reglas de la consola).
4. **Servir la carpeta** con cualquier hosting estático (no hay paso de build):
   - Local: `python3 -m http.server 8000` y abrir http://localhost:8000
   - O simplemente abrir `index.html` en el navegador.
   - Publicar: GitHub Pages (Settings → Pages → `main` / `/ (root)`), Netlify/Vercel (sin build) o Firebase Hosting (`firebase deploy` con `public` apuntando a esta carpeta).

> El login con Google exige que el dominio desde donde se sirve la app esté en la lista de dominios autorizados (Authentication → Settings → Authorized domains). `localhost` ya viene autorizado; si la publicas en otro dominio, agrégalo ahí.

## Fórmula

Precio en Bs = (Costo en Bs + Gasto fijo) ÷ (1 − comisiones − margen)

- Costo en Bs = costo en USD × tasa del día.
- El margen es sobre el precio de venta, no sobre el costo.
- Redondeo siempre hacia arriba a Bs 10 / 50 / 100.
- Incluye desglose paso a paso con la fórmula aplicada, calculadora inversa (precio actual → margen real), tabla comparativa de márgenes 10 %–40 % y botones para copiar el precio, el mensaje para el cliente y el desglose completo.

## Tasas

- **BCV dólar y Euro BCV:** se actualizan solas vía DolarApi (gratis, sin key).
- **Binance USDT (P2P):** se actualiza sola en la app nativa; en el navegador el fetch directo a Binance P2P está bloqueado por CORS, así que la web usa el valor guardado salvo que pegues una API key gratuita de DolarVzla (se guarda solo en tu navegador, nunca en un servidor).
- Sin conexión quedan las tasas guardadas con su fecha.

## Archivos

- `index.html` — estructura de la calculadora, login, historial y productos.
- `styles.css` — estilos (claro/oscuro según el sistema, responsive).
- `app.js` — cálculo, tasas en vivo, copia al portapapeles y persistencia local.
- `firebase-config.js` — configuración web de Firebase (proyecto “Calculadora Margenes VE”).
- `auth.js` — cuentas (Google + correo/contraseña), historial y productos con Firestore (SDK modular por CDN), con el mismo esquema de la app Flutter.
- `firestore.rules` — cada usuario solo accede a sus propios documentos bajo `users/{uid}/**`.
- `package.json` — marca el proyecto como módulo ES (para `node --check`).

Hecha para vender en Venezuela sin perder por tasa, comisiones ni redondeo.
