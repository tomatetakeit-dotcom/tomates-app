# Tomates Pizzería · App de gestión

App web instalable (PWA) para ventas, cocina, caja, inventario, costeo, clientes y usuarios de Tomates Pizzería. Los datos viven en Supabase y la app se publica en Render.

- App: https://tomates-app.onrender.com/
- Base de datos y acceso: Supabase, proyecto `tomates-app` (ref `ztvhtrfzycrocpknpsrr`)
- Hosting: Render, Static Site `tomates-app`

## Archivos

| Ruta | Qué es |
| --- | --- |
| `index.html` | La app ya construida (una sola página). |
| `manifest.webmanifest`, `sw.js` | Instalación como app y caché de la interfaz. El service worker nunca guarda datos de Supabase. |
| `brand.tgz.b64` | Logo e iconos empacados en texto (tar.gz en base64). Render los descomprime al publicar. |
| `supabase/` | Scripts SQL en orden de aplicación y la Edge Function `invite-user`. |
| `src/` | Código fuente de la capa Supabase, acceso, marca y PWA, y el script que construye `index.html`. |

## Base de datos (aplicar en este orden en el editor SQL de Supabase)

1. `supabase/01_schema.sql` — tablas, reglas de acceso, inventario por recetas, tablas del CRM de WhatsApp.
2. `supabase/02_roles_permisos.sql` — roles (admin, supervisor, cajero, asesor, domiciliario), permisos por módulo e invitaciones.
3. `supabase/03_merge_last_seen.sql` — actualización parcial de registros y registro de último ingreso.
4. `supabase/04_seed_menu_inventario.sql` — menú, recetas e ingredientes iniciales (desde "Costeo Tomates.xlsx"). Se puede repetir sin duplicar.
5. `supabase/05_historial_costos.sql` — historial de costos de insumos: cada cambio (inicial, compra o manual) queda guardado con fecha, origen y usuario.
6. `supabase/06_permiso_analisis.sql` — permiso `analisis.ver` (pestaña Análisis: ventas vs compras, costo de lo vendido y márgenes; solo administrador).
7. `supabase/07_domicilio_manual.sql` — tarifa de domicilio escrita a mano (servicio externo): permiso `ventas.domicilio_manual` (administrador y cajero/vendedor) y regla en la base de datos.

Edge Function: `supabase/functions/invite-user/index.ts` (verificación JWT legacy desactivada; la función valida la sesión y el permiso `usuarios.gestionar`).

Registro libre desactivado: solo entran personas invitadas por el administrador.

## Publicar en Render

- Build command: `rm -rf dist && mkdir -p dist && cp index.html manifest.webmanifest sw.js dist/ && base64 -d brand.tgz.b64 | tar -xzf - -C dist && ls -R dist`
- Publish directory: `dist`
- Header: `/manifest.webmanifest` → `Content-Type: application/manifest+json`
- El repositorio está conectado como repositorio público: después de cada cambio hay que hacer **Manual Deploy → Deploy latest commit**.

## Reconstruir `index.html`

```
python3 -I src/build.py "<Tomates App original>.html" salida/
```

`build.py` toma la app original y le agrega `src/adapter.js` (capa Supabase), `src/auth.js` (acceso y permisos), `src/history.js` (historial y análisis de costos), `src/analysis.js` (pestaña Análisis por día, semana y mes), `src/pwa.js`, `src/auth.css` y `src/brand.css`. Con `--mock` genera una versión de prueba con datos simulados (`src/mock.js`). Si cambia `sw.js`, subir su `VERSION`.

## Marca

Guía: Tomates · Guía de marca para web y PWA 1.0. Rojo `#FF3035`, negro `#111111`, blanco. Botones rojos con texto negro. Iconos actuales provisionales (logo completo reducido) hasta tener la marca compacta aprobada.
