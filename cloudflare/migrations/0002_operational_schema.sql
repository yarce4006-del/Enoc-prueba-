-- ENOC Cloudflare D1 migration 0002: complete operational schema
-- Staging only. Derived from Supabase public schema metadata on 2026-10-28.
-- Numeric money fields use TEXT to avoid binary floating-point rounding during transfer.
-- Supabase Auth users are external; profiles/push_subscriptions user IDs are retained without auth.users FK.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, sku TEXT UNIQUE,
  size TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  price TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, order_number TEXT UNIQUE, customer_name TEXT NOT NULL,
  customer_id_number TEXT, customer_phone TEXT NOT NULL, customer_email TEXT,
  delivery_method TEXT NOT NULL CHECK(delivery_method IN ('Envío — pago en cobro destino','Retiro en tienda')),
  shipping_address TEXT, shipping_city TEXT, shipping_reference TEXT,
  payment_method TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(payment_status IN ('pending','proof_uploaded','verified','rejected')),
  payment_proof_url TEXT, subtotal TEXT NOT NULL DEFAULT '0', discount TEXT NOT NULL DEFAULT '0',
  shipping_cost TEXT NOT NULL DEFAULT '0', total TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('Espera de verificación','Pendiente','Confirmado','Pagado','En preparación','Enviado','Entregado','Cancelado')),
  customer_notes TEXT, admin_notes TEXT, whatsapp_sent INTEGER NOT NULL DEFAULT 0,
  whatsapp_sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, customer_address TEXT,
  payment_reference TEXT, origin_bank TEXT, total_bs TEXT, bcv_rate TEXT, items TEXT, customer_data TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT, product_name TEXT NOT NULL,
  sku TEXT, size TEXT, color TEXT, quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
  unit_price TEXT NOT NULL DEFAULT '0', subtotal TEXT NOT NULL DEFAULT '0',
  product_image_url TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cashea_operations (
  id TEXT PRIMARY KEY, order_id TEXT, operation_reference TEXT, customer_name TEXT,
  customer_phone TEXT, sales_channel TEXT, sale_date TEXT, currency TEXT,
  sale_total TEXT, initial_amount TEXT, financed_amount TEXT, commission_sale_pct TEXT,
  commission_financed_pct TEXT, estimated_commission TEXT, estimated_net_amount TEXT,
  status TEXT, notes TEXT, confirmed_at TEXT, confirmed_by TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS cashea_installments (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, installment_number INTEGER NOT NULL,
  due_date TEXT, amount_due TEXT NOT NULL, amount_paid TEXT NOT NULL DEFAULT '0',
  status TEXT, paid_at TEXT, external_reference TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(operation_id) REFERENCES cashea_operations(id)
);

CREATE TABLE IF NOT EXISTS cashea_settlements (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, settlement_date TEXT,
  amount_received TEXT NOT NULL, currency TEXT, bank_reference TEXT, external_reference TEXT,
  notes TEXT, registered_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(operation_id) REFERENCES cashea_operations(id)
);

CREATE TABLE IF NOT EXISTS cashea_operation_items (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, product_id TEXT, variant_id TEXT,
  product_name TEXT NOT NULL, sku TEXT, model_name TEXT, size TEXT, color TEXT,
  quantity INTEGER NOT NULL, unit_price TEXT NOT NULL, line_total TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(operation_id) REFERENCES cashea_operations(id),
  FOREIGN KEY(product_id) REFERENCES products(id),
  FOREIGN KEY(variant_id) REFERENCES product_model_variants(id)
);

CREATE TABLE IF NOT EXISTS cashea_payment_batches (
  id TEXT PRIMARY KEY, payment_date TEXT, amount_received TEXT NOT NULL, currency TEXT,
  reference TEXT, notes TEXT, registered_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cashea_payment_batch_operations (
  id TEXT PRIMARY KEY, payment_batch_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(payment_batch_id) REFERENCES cashea_payment_batches(id),
  FOREIGN KEY(operation_id) REFERENCES cashea_operations(id)
);

CREATE TABLE IF NOT EXISTS cashea_payment_reversals (
  id TEXT PRIMARY KEY, original_batch_id TEXT, operation_id TEXT, payment_date TEXT,
  amount_received TEXT NOT NULL, currency TEXT, reference TEXT, original_batch_created_at TEXT,
  reversed_by TEXT, reversed_at TEXT, reason TEXT, operation_reference TEXT, customer_name TEXT
);

CREATE TABLE IF NOT EXISTS cashea_fiscal_declarations (
  id TEXT PRIMARY KEY, period_start TEXT, period_end TEXT, declared_at TEXT,
  declared_by TEXT, operation_count INTEGER, total_sales_usd TEXT, total_sales_bs TEXT,
  taxable_base_bs TEXT, iva_amount_bs TEXT, patente_amount_bs TEXT, total_reserved_bs TEXT,
  reference TEXT, notes TEXT, status TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cashea_fiscal_reserves (
  id TEXT PRIMARY KEY, operation_id TEXT, operation_reference TEXT, customer_name TEXT,
  sale_date TEXT, sale_total_usd TEXT, bcv_rate TEXT, bcv_rate_date TEXT, bcv_rate_source TEXT,
  total_bs TEXT, taxable_base_bs TEXT, iva_amount_bs TEXT, patente_amount_bs TEXT,
  status TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, notes TEXT, declaration_id TEXT,
  FOREIGN KEY(operation_id) REFERENCES cashea_operations(id),
  FOREIGN KEY(declaration_id) REFERENCES cashea_fiscal_declarations(id)
);

CREATE TABLE IF NOT EXISTS cashea_item_exchanges (
  id TEXT PRIMARY KEY, operation_id TEXT, operation_item_id TEXT, from_variant_id TEXT,
  to_variant_id TEXT, from_product_id TEXT, to_product_id TEXT, from_product_name TEXT,
  from_model_name TEXT, from_size TEXT, from_color TEXT, to_product_name TEXT,
  to_model_name TEXT, to_size TEXT, to_color TEXT, quantity INTEGER, reason TEXT,
  changed_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(operation_id) REFERENCES cashea_operations(id),
  FOREIGN KEY(operation_item_id) REFERENCES cashea_operation_items(id),
  FOREIGN KEY(from_variant_id) REFERENCES product_model_variants(id),
  FOREIGN KEY(to_variant_id) REFERENCES product_model_variants(id),
  FOREIGN KEY(from_product_id) REFERENCES products(id),
  FOREIGN KEY(to_product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_product_models_product_id ON product_models(product_id);
CREATE INDEX IF NOT EXISTS idx_model_variants_model_id ON product_model_variants(model_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_cashea_operations_sale_date ON cashea_operations(sale_date);
CREATE INDEX IF NOT EXISTS idx_cashea_operations_status ON cashea_operations(status);
CREATE INDEX IF NOT EXISTS idx_cashea_items_operation_id ON cashea_operation_items(operation_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_reserves_operation_id ON cashea_fiscal_reserves(operation_id);
