# ENOC — migración a Cloudflare sin dependencia de Supabase

## Estado
- Rama aislada: `migration/cloudflare-no-supabase`.
- No se modificó el Worker productivo ni se escribieron filas en D1.
- El Worker actual `enoc-catalog-api` es de solo lectura: `/health`, `/api/categories`, `/api/products`, `/api/models`, `/api/variants`, `/api/settings`.
- El catálogo y el administrador todavía cargan el SDK de Supabase y contienen llamadas a Supabase; no deben publicarse sin sustituirlas.

## Arquitectura objetivo
- Catálogo y panel → Cloudflare Worker API.
- Datos de catálogo, pedidos, inventario y Cashea → D1.
- Imágenes → R2.
- Sesión administrativa → autenticación validada en el Worker; nunca guardar una contraseña o secreto administrativo en HTML.
- Tasa BCV y notificaciones → endpoints/servicios de Cloudflare independientes y validados.

## Orden seguro de implementación
1. Auditar relaciones, restricciones, datos JSON y reglas de negocio de D1.
2. Implementar autenticación administrativa y autorización por ruta.
3. Implementar endpoints de escritura con validación, sentencias preparadas y transacciones cuando correspondan.
4. Migrar funciones Cashea y sus operaciones contables sin cambiar sus reglas.
5. Migrar pedidos del catálogo y actualización de stock de forma atómica.
6. Adaptar el panel y catálogo a la API; quitar SDK y llamadas directas a Supabase solo después de validar cada módulo.
7. Probar en esta rama con casos de lectura, escritura, errores, permisos, stock y pedidos.
8. Desplegar primero a un Worker/candidato separado y validar; cambiar producción solo tras aprobación explícita.
9. Mantener Supabase disponible como respaldo hasta confirmar el funcionamiento completo.

## Alertas de integridad que requieren análisis
- `order_items` aparece vacío mientras `orders` tiene filas; revisar el campo `orders.items` y la forma en que se registraron pedidos antes de decidir si hace falta una migración.
- `product_variants` aparece vacío, pero existe `product_model_variants`; confirmar qué modelo de variantes consume cada pantalla.
- Las tablas de Cashea tienen relaciones y restricciones; los endpoints deben respetar claves foráneas y reglas de reversión.
- `profiles` por sí sola no es un mecanismo de autenticación. No confiar en un ID enviado por el navegador como prueba de que alguien es administrador.

## Criterio de finalización
La migración no se considera completa hasta que catálogo, pedidos, inventario, panel, autenticación, Cashea, tasa BCV, imágenes y notificaciones funcionen sin llamadas a Supabase y las pruebas estén verificadas. Este archivo documenta el plan; no afirma que esas tareas estén terminadas.
