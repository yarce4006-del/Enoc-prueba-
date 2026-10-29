# ENOC — validación real de esquema Cloudflare D1 (2026-10-28)

Base consultada en modo lectura: `enoc-production-migration`. Este documento no modifica producción.

## Compatibilidad del Worker candidato
- `categories`: `id,name,slug,active` existen.
- `products`: `id,sku,name,description,category_id,price,image_url,image_urls,image_labels,active,updated_at` existen.
- `product_models`: `id,product_id,name,image_urls,active` existen.
- `product_model_variants`: `id,model_id,size,color,stock,price,active,updated_at` existen.
- `store_settings`: todos los campos consultados/actualizados por el candidato existen.
- `orders`: `status,updated_at,created_at` existen; estados permitidos: `Espera de verificación`, `Pendiente`, `Confirmado`, `Pagado`, `En preparación`, `Enviado`, `Entregado`, `Cancelado`.

## Puntos obligatorios antes de despliegue
1. Los 40 pedidos históricos usan `orders.items` como JSON; `order_items` está vacío. Preservar compatibilidad.
2. Falta implementar `POST /api/orders` con validación y protección contra duplicados; no publicar un catálogo que no pueda registrar compras.
3. Faltan CRUD de modelos, variantes y categorías; Cashea y sus seis RPC; BCV; push; y migración de autenticación del cargador R2.
4. Verificar el dominio real de Netlify antes de fijar CORS.
5. Configurar credenciales de administración solo como secretos del Worker; no incrustarlas en HTML.
6. Probar escritura y reversión en entorno aislado antes de cambiar producción.

## Resultado
Las columnas SQL que usa el Worker candidato actual existen en D1, pero **la API sigue incompleta y no se ha desplegado**. No confundir compatibilidad del esquema con migración finalizada.
