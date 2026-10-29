# Estado de conexión Cashea / resguardos fiscales — API v2

## Worker de integración
- Worker: `enoc-cashea-api-v2`
- URL: `https://enoc-cashea-api-v2.enoc365-image-migration.workers.dev`
- Health: `GET /health`
- D1 enlazada: `enoc-production-migration`
- Rama de código: `migration/cloudflare-no-supabase`

## Cambios en esta rama
- `migration/enoc-catalog-api-v2-candidate.js`: rutas de operaciones, artículos, pagos, cambios y resguardos fiscales; validación de sesión Supabase del lado servidor.
- `admin.html`: lecturas de operaciones, artículos, pagos y resguardos por API; llamadas de escritura apuntan a las rutas API.
- `login.html`: conserva el inicio de sesión Supabase existente.

## Protección activa
Las escrituras de Cashea están bloqueadas por defecto con HTTP 503 mientras no se valide en un entorno aislado. No activar `ENABLE_CASHEA_MUTATIONS=true` contra D1 de producción para pruebas.

La API exige además un rol `admin` en los metadatos del usuario Supabase o que su correo esté en `ADMIN_ALLOWED_EMAILS`. La variable de lista blanca no se ha configurado porque el correo administrador autorizado no estaba disponible durante la implementación. Hasta que se configure, el acceso administrativo a la API debe fallar cerrado.

## Para completar la activación
1. Configurar `ADMIN_ALLOWED_EMAILS` con el correo real autorizado (o verificar que el usuario tenga rol admin en sus metadatos).
2. Crear una D1 de staging y copiar el esquema/datos necesarios de Cashea, productos, modelos y variantes.
3. Probar creación/confirmación de venta, actualización de inventario, cambio de artículos, pagos, reversos, resguardos y declaraciones en staging.
4. Corregir cualquier diferencia entre la lógica histórica de las RPC de Supabase y la implementación API.
5. Solo después de aprobar las pruebas, decidir la activación controlada de escritura.

## Importante
El Worker está desplegado, pero esto no significa que el panel de producción esté migrado. El archivo `admin.html` modificado vive en esta rama de migración; no se publicó en Netlify ni se modificó la rama principal. La API se encuentra protegida y no debe considerarse lista para operaciones fiscales reales hasta completar la validación anterior.
