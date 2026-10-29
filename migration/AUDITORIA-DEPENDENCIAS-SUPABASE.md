# ENOC — auditoría de dependencias Supabase (desde los HTML entregados)

Fecha de revisión: 2026-10-28  
Rama: `migration/cloudflare-no-supabase`

Este documento registra llamadas observadas en los archivos HTML de trabajo. No representa una migración terminada y no autoriza publicar cambios en producción.

## Dependencias encontradas en el panel administrativo

### Tablas consultadas o modificadas
- `categories`
- `orders`
- `product-images` (bucket de almacenamiento)
- `product_model_variants`
- `product_models`
- `products`
- `profiles`
- `store_settings`
- `cashea_operations`
- `cashea_operation_items`
- `cashea_payment_batches`
- `cashea_settlements`
- `cashea_payment_reversals`
- `cashea_fiscal_declarations`
- `cashea_fiscal_reserves`
- `cashea_item_exchanges`

### RPC de Cashea que deben conservar su semántica
- `confirm_cashea_operation`
- `exchange_cashea_item`
- `register_cashea_fiscal_declaration`
- `register_cashea_fiscal_reserve`
- `register_cashea_payment_batch`
- `reverse_cashea_payment_batch`

No se deben reemplazar por actualizaciones simples independientes: confirmar una operación, descontar/devolver inventario, registrar declaraciones fiscales y revertir depósitos requieren lógica atómica e idempotencia.

### Servicios auxiliares detectados
- Edge Function `super-function`: tasa BCV.
- Edge Function `enoc-push-subscribe`: configuración VAPID y suscripciones push.
- El cargador de imágenes usa el Worker `enoc-r2-upload` y actualmente obtiene el token de una sesión Supabase. El flujo de autorización deberá cambiar al nuevo mecanismo antes de quitar Supabase Auth.

## Dependencias encontradas en el catálogo público
- Lectura de `categories`, `products`, `product_models`, `product_model_variants`, `product_variants` y `store_settings`.
- Escritura de pedidos en `orders`, incluyendo artículos en JSON y datos del cliente.
- Edge Function `super-function` para la tasa BCV.

## Requisitos mínimos para la API nueva

1. `POST /api/orders`: validar datos y métodos de pago/entrega, calcular total en servidor, validar variantes y stock, guardar el pedido de forma consistente y no abrir WhatsApp si falla el registro.
2. Rutas administrativas de pedidos: lectura paginada, actualización de estado con lista permitida y registro de cambios relevante.
3. Inventario: decrementos y devoluciones atómicos; nunca aceptar stock negativo ni confiar en el stock enviado por el navegador.
4. Cashea: migrar las seis RPC como operaciones de negocio transaccionales, con historial y validación de estados.
5. BCV: endpoint propio con fuente, fecha efectiva, validación de respuesta y tratamiento de fallos; no inventar ni reutilizar una tasa caducada sin indicarlo.
6. Push: endpoint para suscripción y claves VAPID; secretos privados solo en variables de entorno.
7. R2: autorización del lado del servidor y validación de tipo/tamaño/ruta de los archivos.
8. Auth: credenciales y secreto JWT solo en secretos de Cloudflare; token con expiración, y verificación de autorización en cada ruta privada.
9. Configuración pública: devolver únicamente campos seguros que el catálogo necesita.

## Bloqueos antes de desplegar
- Revisar esquema real y restricciones de todas las tablas afectadas por escritura.
- Inspeccionar las funciones SQL actuales de las seis RPC para conservar reglas exactas de Cashea.
- Probar el esquema real de `products`, `product_model_variants`, `orders` y `store_settings` frente al candidato actual. Los nombres de columnas del candidato son provisionales hasta validar todas las columnas.
- Implementar pruebas de creación de pedido, stock insuficiente, petición no autorizada, estado inválido, error de R2 y fallo de BCV.
- Desplegar a un Worker de staging independiente antes de cambiar producción.

## Estado de esta revisión
El código candidato de API ya está guardado en la rama. Aún no se ha desplegado ni se considera listo para producción. No se han modificado filas de negocio de D1 ni el sitio publicado.
