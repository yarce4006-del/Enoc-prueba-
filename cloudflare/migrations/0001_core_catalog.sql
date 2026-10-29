-- ENOC Cloudflare D1 migration (core catalog schema)
-- Generated from the Supabase public table definitions on 2026-10-28.
-- This is a staging branch migration; no production deployment is included.
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT,
  slug TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  category_id TEXT, price REAL NOT NULL DEFAULT 0 CHECK(price >= 0), image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, image_urls TEXT NOT NULL DEFAULT '[]',
  image_labels TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY(category_id) REFERENCES categories(id)
);
CREATE TABLE IF NOT EXISTS product_models (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT NOT NULL, image_urls TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS product_model_variants (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, size TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), price REAL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(model_id) REFERENCES product_models(id)
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS store_settings (
  id TEXT PRIMARY KEY, whatsapp TEXT, pago_movil_banco TEXT, pago_movil_telefono TEXT,
  pago_movil_cedula TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, binance_id TEXT,
  binance_email TEXT, whatsapp_1_url TEXT, whatsapp_2_url TEXT, hero_image_url TEXT,
  cashea_enabled INTEGER NOT NULL DEFAULT 1, hero_title TEXT, hero_top_text TEXT, hero_description TEXT
);
