/**
 * ENOC Cloudflare Worker API — CANDIDATE ONLY
 * Not deployed. Intended for the migration branch and review before staging.
 * Required Worker bindings/secrets:
 *   DB (D1), ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_JWT_SECRET
 *
 * Security model:
 * - Public GET endpoints only expose active catalog data and public store settings.
 * - All /api/admin/* routes require a short-lived HMAC-signed JWT.
 * - Never put ADMIN_PASSWORD or ADMIN_JWT_SECRET in HTML.
 */
const ALLOWED_ORIGINS = new Set([
  "https://enoc365.netlify.app",
  "https://enoc.com",
  "https://www.enoc.com"
]);
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "null";
    const headers = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, headers);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "enoc-catalog-api-candidate", mode: "candidate" }, 200, headers);
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        const body = await readJson(request);
        if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_JWT_SECRET) {
          return json({ error: "Admin authentication is not configured" }, 503, headers);
        }
        if (!constantTimeEqual(String(body.username || ""), env.ADMIN_USERNAME) ||
            !constantTimeEqual(String(body.password || ""), env.ADMIN_PASSWORD)) {
          return json({ error: "Invalid credentials" }, 401, headers);
        }
        const now = Math.floor(Date.now() / 1000);
        const token = await signJwt({ sub: "enoc-admin", role: "admin", iat: now, exp: now + 60 * 60 * 4 }, env.ADMIN_JWT_SECRET);
        return json({ data: { access_token: token, token_type: "Bearer", expires_in: 14400 } }, 200, headers);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const claims = await verifyRequest(request, env);
        if (!claims || claims.role !== "admin") return json({ error: "Unauthorized" }, 401, headers);
        return await handleAdmin(request, url, env, headers);
      }

      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, headers);
      switch (url.pathname) {
        case "/api/categories": {
          const result = await env.DB.prepare(
            "SELECT id, name, slug, active FROM categories WHERE active = 1 ORDER BY name"
          ).all();
          return json({ data: result.results }, 200, headers);
        }
        case "/api/products": {
          const result = await env.DB.prepare(
            "SELECT id, sku, name, description, category_id, price, image_url, image_urls, image_labels, active FROM products WHERE active = 1 ORDER BY name"
          ).all();
          return json({ data: result.results }, 200, headers);
        }
        case "/api/models": {
          const productId = url.searchParams.get("product_id");
          const query = productId
            ? env.DB.prepare("SELECT id, product_id, name, image_urls, active FROM product_models WHERE active = 1 AND product_id = ? ORDER BY name").bind(productId)
            : env.DB.prepare("SELECT id, product_id, name, image_urls, active FROM product_models WHERE active = 1 ORDER BY name");
          return json({ data: (await query.all()).results }, 200, headers);
        }
        case "/api/variants": {
          const modelId = url.searchParams.get("model_id");
          const productId = url.searchParams.get("product_id");
          if (!modelId && !productId) return json({ error: "model_id or product_id is required" }, 400, headers);
          const query = modelId
            ? env.DB.prepare("SELECT id, model_id, size, color, stock, price, active FROM product_model_variants WHERE active = 1 AND model_id = ? ORDER BY size, color").bind(modelId)
            : env.DB.prepare("SELECT v.id, v.model_id, v.size, v.color, v.stock, v.price, v.active FROM product_model_variants v JOIN product_models m ON m.id = v.model_id WHERE v.active = 1 AND m.active = 1 AND m.product_id = ? ORDER BY m.name, v.size, v.color").bind(productId);
          return json({ data: (await query.all()).results }, 200, headers);
        }
        case "/api/settings": {
          const result = await env.DB.prepare(
            "SELECT whatsapp, pago_movil_banco, pago_movil_telefono, pago_movil_cedula, binance_id, binance_email, whatsapp_1_url, whatsapp_2_url, hero_image_url, cashea_enabled, hero_title, hero_top_text, hero_description FROM store_settings ORDER BY updated_at DESC LIMIT 1"
          ).first();
          return json({ data: result }, 200, headers);
        }
        default: return json({ error: "Not found" }, 404, headers);
      }
    } catch (error) {
      // Keep SQL details and credentials out of public responses.
      return json({ error: "Internal server error" }, 500, headers);
    }
  }
};

async function handleAdmin(request, url, env, headers) {
  const path = url.pathname;
  const method = request.method;
  if (method === "GET" && path === "/api/admin/orders") {
    const status = url.searchParams.get("status");
    const stmt = status
      ? env.DB.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 500").bind(status)
      : env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
    return json({ data: (await stmt.all()).results }, 200, headers);
  }
  if (method === "PATCH" && path === "/api/admin/orders/status") {
    const b = await readJson(request);
    if (!b.id || !["Espera de verificación","Pendiente","Confirmado","Pagado","En preparación","Enviado","Entregado","Cancelado"].includes(b.status)) {
      return json({ error: "Invalid order id or status" }, 400, headers);
    }
    const result = await env.DB.prepare("UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(b.status, String(b.id)).run();
    if (!result.meta?.changes) return json({ error: "Order not found" }, 404, headers);
    return json({ data: { id: b.id, status: b.status } }, 200, headers);
  }
  if (method === "POST" && path === "/api/admin/products") {
    const b = await readJson(request);
    if (!b.sku || !b.name || !Number.isFinite(Number(b.price)) || Number(b.price) < 0) {
      return json({ error: "sku, name and a valid non-negative price are required" }, 400, headers);
    }
    const id = String(b.id || crypto.randomUUID());
    await env.DB.prepare(
      "INSERT INTO products (id, sku, name, description, category_id, price, image_url, image_urls, image_labels, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, name=excluded.name, description=excluded.description, category_id=excluded.category_id, price=excluded.price, image_url=excluded.image_url, image_urls=excluded.image_urls, image_labels=excluded.image_labels, active=excluded.active, updated_at=CURRENT_TIMESTAMP"
    ).bind(id, String(b.sku), String(b.name), b.description ?? null, b.category_id ?? null,
      Number(b.price), b.image_url ?? null, jsonString(b.image_urls, []), jsonString(b.image_labels, []),
      b.active === false ? 0 : 1).run();
    return json({ data: { id } }, 200, headers);
  }
  if (method === "DELETE" && path === "/api/admin/products") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400, headers);
    // Soft-delete so historic orders retain product references.
    const result = await env.DB.prepare("UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    if (!result.meta?.changes) return json({ error: "Product not found" }, 404, headers);
    return json({ data: { id, active: 0 } }, 200, headers);
  }
  if (method === "PATCH" && path === "/api/admin/variants/stock") {
    const b = await readJson(request);
    const stock = Number(b.stock);
    if (!b.id || !Number.isInteger(stock) || stock < 0) return json({ error: "Valid variant id and non-negative integer stock are required" }, 400, headers);
    const result = await env.DB.prepare("UPDATE product_model_variants SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(stock, String(b.id)).run();
    if (!result.meta?.changes) return json({ error: "Variant not found" }, 404, headers);
    return json({ data: { id: b.id, stock } }, 200, headers);
  }
  if (method === "PATCH" && path === "/api/admin/settings") {
    const b = await readJson(request);
    const allowed = ["whatsapp","pago_movil_banco","pago_movil_telefono","pago_movil_cedula","binance_id","binance_email","whatsapp_1_url","whatsapp_2_url","hero_image_url","cashea_enabled","hero_title","hero_top_text","hero_description"];
    const fields = allowed.filter(k => Object.prototype.hasOwnProperty.call(b, k));
    if (!fields.length) return json({ error: "No supported settings provided" }, 400, headers);
    const current = await env.DB.prepare("SELECT id FROM store_settings ORDER BY updated_at DESC LIMIT 1").first();
    if (!current) return json({ error: "Store settings row not found" }, 404, headers);
    const sql = "UPDATE store_settings SET " + fields.map(k => k + " = ?").join(", ") + ", updated_at = CURRENT_TIMESTAMP WHERE id = ?";
    const values = fields.map(k => k === "cashea_enabled" ? (b[k] ? 1 : 0) : b[k]);
    await env.DB.prepare(sql).bind(...values, current.id).run();
    return json({ data: { updated: fields } }, 200, headers);
  }
  return json({ error: "Admin route not found" }, 404, headers);
}

async function readJson(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > 1_000_000) throw new Error("Request too large");
  return await request.json();
}
function jsonString(value, fallback) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return JSON.stringify(parsed); } catch { return JSON.stringify(fallback); }
  }
  return JSON.stringify(fallback);
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}
function constantTimeEqual(a, b) {
  const x = encoder.encode(a), y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function toB64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function signJwt(claims, secret) {
  const header = toB64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = toB64Url(encoder.encode(JSON.stringify(claims)));
  const data = header + "." + payload;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return data + "." + toB64Url(new Uint8Array(signature));
}
async function verifyRequest(request, env) {
  if (!env.ADMIN_JWT_SECRET) return null;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const data = parts[0] + "." + parts[1];
    const key = await crypto.subtle.importKey("raw", encoder.encode(env.ADMIN_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromB64Url(parts[2]), encoder.encode(data));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(parts[1])));
    if (!claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
