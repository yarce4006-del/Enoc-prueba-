# ENOC API v2 — validación previa a staging

Fecha: 2026-10-28  
Rama: `migration/cloudflare-no-supabase`  
Archivo: `migration/enoc-catalog-api-v2-candidate.js`  
Estado: candidato; no desplegado.

## Verificaciones realizadas

- Se leyó el esquema real de D1 y se comprobó la compatibilidad sintáctica de las consultas SQL con `EXPLAIN` (sin insertar ni actualizar registros).
- El SQL de creación de pedidos usa las columnas existentes de `orders`, incluidos `items` y `customer_data`.
- El `INSERT ... SELECT ... WHERE EXISTS` y el `UPDATE` de stock condicionado a que exista el pedido pasan la validación SQL.
- Las consultas de variante/modelo y actualización de estados pasan la validación SQL.
- La API mantiene el formato histórico de artículos JSON en `orders.items`.

## Lectura de integridad de D1 (solo lectura)

- Pedidos actuales: 40.
- Variantes de modelo: 320.
- Variantes con stock negativo: 0.
- Productos activos: 36.
- Modelos activos sin producto activo asociado: 0.
- Claves duplicadas activas `(model_id, size, color)`: 0.

## Limitaciones que bloquean producción

1. Las comprobaciones anteriores no equivalen a una prueba de integración HTTP. No se creó ningún pedido de prueba ni se modificó stock.
2. La API todavía necesita pruebas en una base D1 de staging aislada, con casos de dos pedidos concurrentes que intenten comprar la última unidad.
3. Debe confirmarse que el frontend envía `product_id`, `model_id`, `variant_id`, `size` y `color` con el formato esperado.
4. El registro de pedidos no descuenta inventario de `product_variants` (solo reserva `product_model_variants` cuando la línea incluye una variante seleccionada). Si el catálogo utiliza variantes de producto sin modelo, hay que agregar ese flujo antes de habilitar el endpoint.
5. Debe revisarse la lista de orígenes CORS con el dominio real de producción.
6. Las rutas de administración requieren configurar secretos del Worker; no poner credenciales en HTML.
7. No desplegar este candidato contra la D1 de producción para probar escrituras.

## Resultado

Las consultas SQL clave pasan la validación sintáctica y las comprobaciones de integridad leídas no muestran anomalías en esos criterios. La API **no está certificada para producción** hasta completar pruebas HTTP y concurrencia en staging aislado, confirmar el contrato del frontend y revisar los flujos de inventario restantes.
