# ENOC — rutas Cashea en API v2

Rama: `migration/cloudflare-no-supabase`  
Archivo de implementación: `enoc-catalog-api-v2-candidate.js`

Todas las rutas siguientes requieren JWT de administrador emitido por `POST /api/admin/login`.

## Operaciones

- `GET /api/admin/cashea/operations`: lista operaciones.
- `GET /api/admin/cashea/items?operation_id=...`: consulta artículos de una operación.
- `POST /api/admin/cashea/confirm`: cuerpo `{"operation_id":"..." }`; valida artículos y stock, calcula financiado/comisión/neto y confirma.
- `POST /api/admin/cashea/exchange`: cuerpo `{"operation_id":"...","item_id":"...","new_variant_id":"...","reason":"..." }`; registra historial y ajusta inventario.
- `GET /api/admin/cashea/payments`: consulta lotes, vínculos y reversos.
- `POST /api/admin/cashea/payments/batches`: cuerpo `{"payment_date":"YYYY-MM-DD","amount_received":0,"currency":"USD","operation_ids":["..."],"reference":null,"notes":null}`; comprueba importe neto esperado y registra el lote.
- `POST /api/admin/cashea/payments/reverse`: cuerpo `{"operation_id":"...","reason":"..." }`; solo permite reversar operaciones con un lote y sin liquidación registrada.

## Resguardos fiscales

- `GET /api/admin/cashea/fiscal`: consulta resguardos y declaraciones.
- `POST /api/admin/cashea/fiscal/reserve`: cuerpo `{"operation_id":"...","bcv_rate":0,"rate_date":"YYYY-MM-DD","rate_source":"BCV verificado","notes":null}`. Requiere tasa positiva y no permite duplicar el resguardo de una operación. Calcula total Bs = USD × tasa; base imponible = total Bs / 1.16; IVA = base × 16%; patente = total Bs × 2%.
- `POST /api/admin/cashea/fiscal/declarations`: cuerpo `{"period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","reserve_ids":["..."],"reference":null,"notes":null}`. Solo admite resguardos registrados, no declarados y dentro del período.

## Advertencias que siguen aplicando

Este commit implementa rutas de backend; no cambia el `admin.html` publicado ni conecta automáticamente sus botones a la nueva API. La versión actual del panel sigue invocando RPCs de Supabase. Por eso no debe anunciarse el módulo como migrado ni desplegarse como sustituto funcional del panel hasta terminar la capa de integración del frontend y verificar la semántica de los procedimientos heredados.

La tasa BCV se proporciona explícitamente; el endpoint no consulta ni verifica por sí mismo una fuente oficial. No usar tasas inventadas ni declarar montos sin revisar la tasa y el tratamiento fiscal aplicable.
