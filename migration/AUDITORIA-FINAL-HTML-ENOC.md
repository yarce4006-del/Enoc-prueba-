# Auditoría real de los HTML de ENOC

Fecha: 2026-10-28
Rama: migration/cloudflare-no-supabase
Alcance: inspección estática de los dos HTML entregados por el usuario. Esto no equivale a pruebas de ejecución.

## Resultado principal

Los archivos aún dependen de Supabase. No se deben publicar como migración completa a Cloudflare todavía.

- Catálogo: referencia el proyecto Supabase `https://huspfcjzqedmpavcgfxe.supabase.co`, consulta `categories`, `products`, `product_models`, `product_model_variants`, `product_variants`, `store_settings` y crea pedidos en `orders`. También llama a `functions/v1/super-function` para la tasa/funcionalidad asociada.
- Panel: carga `@supabase/supabase-js@2`, referencia el mismo proyecto Supabase y usa `categories`, `orders`, `product-images` (almacenamiento), `product_model_variants`, `product_models`, `products`, `profiles`, `store_settings`, `cashea_operations`, `cashea_operation_items`, `cashea_payment_batches`, `cashea_settlements`, `cashea_payment_reversals`, `cashea_fiscal_declarations` y `cashea_fiscal_reserves`.
- El panel invoca las RPC `confirm_cashea_operation`, `exchange_cashea_item`, `register_cashea_fiscal_declaration`, `register_cashea_fiscal_reserve`, `register_cashea_payment_batch` y `reverse_cashea_payment_batch`.
- El panel también llama a `functions/v1/enoc-push-subscribe` y `functions/v1/super-function`, usa sesión Supabase mediante `auth.getSession` / `auth.signOut`, y utiliza almacenamiento Supabase.

## Qué falta para considerar terminada la migración

1. Definir y desplegar la API Cloudflare completa con D1, R2 y autenticación de administrador; eliminar llamadas directas a Supabase de ambos HTML.
2. Implementar todas las rutas de lectura/escritura usadas por catálogo y panel, no solamente endpoints de lectura.
3. Migrar de forma transaccional las reglas de stock y pedidos. Los pedidos existentes contienen datos en `orders.items`; no asumir que `order_items` está poblada ni reconstruir los pedidos sin comparar los registros originales.
4. Implementar equivalentes de las seis RPC de Cashea, conservando reglas, reversos, reservas fiscales, declaraciones, lotes y relaciones.
5. Sustituir `super-function` por un endpoint Cloudflare para la tasa BCV y probar errores, caché, fecha y formato de respuesta.
6. Sustituir `enoc-push-subscribe` y comprobar suscripciones/permisos/notificaciones.
7. Cambiar autenticación y autorización del panel y del Worker de carga R2. No confiar en que ocultar la interfaz proteja las rutas.
8. Validar las operaciones de imágenes y permisos del bucket R2.
9. Ejecutar pruebas de regresión en staging: carga del catálogo, búsqueda/categorías, modelos/tallas/stock, creación de pedido, venta manual, estados de pedidos, login/logout, altas/ediciones/bajas de productos, subida/eliminación de imágenes, tasa BCV, cada flujo Cashea y push.
10. Comparar recuentos y muestras de datos entre Supabase y D1 antes de cualquier cambio de producción; documentar rollback.

## Estado de publicación

- Producción debe permanecer en su versión actual mientras falten pruebas.
- Esta auditoría no confirma que los datos se hayan migrado completamente ni que la API candidata esté lista.
- No desplegar el Worker candidato ni sustituir los HTML de producción hasta cerrar los puntos anteriores.
