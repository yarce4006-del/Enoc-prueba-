/**
 * ENOC Cloudflare Worker API v2 — STAGING CANDIDATE ONLY.
 * Not deployed. Uses the confirmed D1 schema from migration audit.
 * Bindings: DB (D1), ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_JWT_SECRET.
 *
 * Important: order creation persists the existing legacy items JSON format.
 * It intentionally does NOT decrement inventory yet; that requires an atomic
 * reservation design and frontend integration tests before production.
 */
const ALLOWED_ORIGINS = new Set([
  "https://enoc365.netlify.app",
  "https://enoc.com",
  "https://www.enoc.com"
]);
const enc = new TextEncoder();
const ORDER_STATUSES = ["Espera de verificación","Pendiente","Confirmado","Pagado","En preparación","Enviado","Entregado","Cancelado"];
const PAYMENT_STATUSES = ["pending","proof_uploaded","verified","rejected"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers});
    if (origin && !ALLOWED_ORIGINS.has(origin)) return out({error:"Origin not allowed"},403,headers);

    try {
      if (url.pathname === "/health" && request.method === "GET")
        return out({ok:true,service:"enoc-catalog-api-v2-candidate",mode:"not-deployed"},200,headers);

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        const b = await body(request);
        if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_JWT_SECRET)
          return out({error:"Admin authentication is not configured"},503,headers);
        if (!equal(String(b.username||""),env.ADMIN_USERNAME) || !equal(String(b.password||""),env.ADMIN_PASSWORD))
          return out({error:"Invalid credentials"},401,headers);
        const now=Math.floor(Date.now()/1000);
        return out({data:{access_token:await sign({sub:"enoc-admin",role:"admin",iat:now,exp:now+14400},env.ADMIN_JWT_SECRET),token_type:"Bearer",expires_in:14400}},200,headers);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const claims=await verify(request,env);
        if (!claims || claims.role!=="admin") return out({error:"Unauthorized"},401,headers);
        return await admin(request,url,env,headers);
      }

      if (url.pathname === "/api/orders" && request.method === "POST")
        return await createOrder(request,env,headers);

      if (request.method !== "GET") return out({error:"Method not allowed"},405,headers);
      if (url.pathname === "/api/categories") {
        const r=await env.DB.prepare("SELECT id,name,slug,active FROM categories WHERE active=1 ORDER BY name").all();
        return out({data:r.results},200,headers);
      }
      if (url.pathname === "/api/products") {
        const r=await env.DB.prepare("SELECT id,sku,name,description,category_id,price,image_url,image_urls,image_labels,active FROM products WHERE active=1 ORDER BY name").all();
        return out({data:r.results},200,headers);
      }
      if (url.pathname === "/api/models") {
        const id=url.searchParams.get("product_id");
        const q=id?env.DB.prepare("SELECT id,product_id,name,image_urls,active FROM product_models WHERE active=1 AND product_id=? ORDER BY name").bind(id):env.DB.prepare("SELECT id,product_id,name,image_urls,active FROM product_models WHERE active=1 ORDER BY name");
        return out({data:(await q.all()).results},200,headers);
      }
      if (url.pathname === "/api/variants") {
        const mid=url.searchParams.get("model_id"), pid=url.searchParams.get("product_id");
        if (!mid&&!pid) return out({error:"model_id or product_id is required"},400,headers);
        const q=mid?env.DB.prepare("SELECT id,model_id,size,color,stock,price,active FROM product_model_variants WHERE active=1 AND model_id=? ORDER BY size,color").bind(mid):env.DB.prepare("SELECT v.id,v.model_id,v.size,v.color,v.stock,v.price,v.active FROM product_model_variants v JOIN product_models m ON m.id=v.model_id WHERE v.active=1 AND m.active=1 AND m.product_id=? ORDER BY m.name,v.size,v.color").bind(pid);
        return out({data:(await q.all()).results},200,headers);
      }
      if (url.pathname === "/api/settings") {
        const r=await env.DB.prepare("SELECT whatsapp,pago_movil_banco,pago_movil_telefono,pago_movil_cedula,binance_id,binance_email,whatsapp_1_url,whatsapp_2_url,hero_image_url,cashea_enabled,hero_title,hero_top_text,hero_description FROM store_settings ORDER BY updated_at DESC LIMIT 1").first();
        return out({data:r},200,headers);
      }
      return out({error:"Not found"},404,headers);
    } catch (e) {
      return out({error:"Internal server error"},500,headers);
    }
  }
};

async function createOrder(request,env,headers) {
  const b=await body(request);
  const c=b.customer_data && typeof b.customer_data==="object" ? b.customer_data : {};
  const items=Array.isArray(b.items)?b.items:null;
  if (!items || !items.length || items.length>100) return out({error:"items must contain between 1 and 100 items"},400,headers);
  const customerName=String(b.customer_name||c.name||"").trim();
  const phone=String(b.customer_phone||c.phone||"").trim();
  const delivery=String(b.delivery_method||"");
  const payment=String(b.payment_method||"");
  if (!customerName || !phone || !payment || !["Envío — pago en cobro destino","Retiro en tienda"].includes(delivery))
    return out({error:"Customer name, phone, payment method and valid delivery method are required"},400,headers);
  const normalized=[];
  let subtotal=0;
  for (const item of items) {
    const qty=Number(item.qty ?? item.quantity);
    if (!Number.isInteger(qty)||qty<1||qty>100)
      return out({error:"Each item needs a valid quantity"},400,headers);
    let productId=item.product_id||null;
    const modelId=item.model_id||null;
    if (!productId && modelId) {
      const model=await env.DB.prepare("SELECT product_id FROM product_models WHERE id=? AND active=1").bind(String(modelId)).first();
      if (!model) return out({error:"A selected model is unavailable"},409,headers);
      productId=model.product_id;
    }
    if (!productId) return out({error:"Each item must include product_id or model_id"},400,headers);
    const product=await env.DB.prepare("SELECT id,name,price,active FROM products WHERE id=? AND active=1").bind(String(productId)).first();
    if (!product) return out({error:"A selected product is unavailable"},409,headers);
    let price=Number(product.price);
    const variantId=item.variant_id||item.variantId||null;
    if (variantId) {
      const variant=await env.DB.prepare("SELECT v.price,v.stock,v.active,m.product_id FROM product_model_variants v JOIN product_models m ON m.id=v.model_id WHERE v.id=? AND v.active=1 AND m.active=1").bind(String(variantId)).first();
      if (!variant || variant.product_id!==product.id) return out({error:"A selected size or color is unavailable"},409,headers);
      if (variant.price!==null && variant.price!==undefined) price=Number(variant.price);
      if (Number(variant.stock)<qty) return out({error:"Insufficient stock for a selected variant"},409,headers);
    } else if (modelId && (item.size!==undefined || item.color!==undefined)) {
      let q="SELECT stock,price FROM product_model_variants WHERE model_id=? AND active=1 AND size=?";
      const params=[String(modelId),String(item.size??"")];
      if (item.color!==undefined && item.color!==null) { q+=" AND color=?"; params.push(String(item.color)); }
      const variant=await env.DB.prepare(q+" LIMIT 1").bind(...params).first();
      if (!variant) return out({error:"A selected size or color is unavailable"},409,headers);
      if (Number(variant.stock)<qty) return out({error:"Insufficient stock for a selected variant"},409,headers);
      if (variant.price!==null && variant.price!==undefined) price=Number(variant.price);
    }
    if (!Number.isFinite(price)||price<0) return out({error:"Product price is invalid"},409,headers);
    const name=String(item.name||item.product_name||product.name).trim();
    normalized.push({...item,product_id:product.id,qty,name,price});
    subtotal += qty*price;
  }
  if (!Number.isFinite(subtotal)||subtotal>10000000) return out({error:"Invalid order total"},400,headers);
  const discount=Math.max(0,Number(b.discount||0));
  const shipping=Math.max(0,Number(b.shipping_cost||0));
  if (!Number.isFinite(discount)||!Number.isFinite(shipping)||discount>subtotal)
    return out({error:"Invalid discount or shipping cost"},400,headers);
  const total=Math.max(0,subtotal-discount+shipping);
  const id=crypto.randomUUID();
  const orderNumber="E"+Date.now().toString().slice(-8)+Math.floor(Math.random()*90+10);
  const customerData={...c,notes:b.customer_notes??c.notes??null,origin:c.origin||"catalog"};
  await env.DB.prepare(
    "INSERT INTO orders (id,order_number,customer_name,customer_id_number,customer_phone,customer_email,delivery_method,shipping_address,shipping_city,shipping_reference,payment_method,payment_status,subtotal,discount,shipping_cost,total,status,customer_notes,items,customer_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id,orderNumber,customerName,b.customer_id_number??c.id_number??null,phone,b.customer_email??c.email??null,delivery,b.shipping_address??c.address??null,b.shipping_city??c.city??null,b.shipping_reference??null,payment,"pending",subtotal.toFixed(2),discount.toFixed(2),shipping.toFixed(2),total.toFixed(2),"Pendiente",b.customer_notes??c.notes??null,JSON.stringify(normalized),JSON.stringify(customerData)).run();
  return out({data:{id,order_number:orderNumber,status:"Pendiente",payment_status:"pending",subtotal:subtotal.toFixed(2),discount:discount.toFixed(2),shipping_cost:shipping.toFixed(2),total:total.toFixed(2)}},201,headers);
}

async function admin(request,url,env,headers) {
  const p=url.pathname,m=request.method;
  if(m==="GET"&&p==="/api/admin/orders"){
    const status=url.searchParams.get("status");
    if(status&&!ORDER_STATUSES.includes(status))return out({error:"Invalid status"},400,headers);
    const q=status?env.DB.prepare("SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 500").bind(status):env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
    return out({data:(await q.all()).results},200,headers);
  }
  if(m==="PATCH"&&p==="/api/admin/orders/status"){
    const b=await body(request);
    if(!b.id||!ORDER_STATUSES.includes(b.status))return out({error:"Invalid order id or status"},400,headers);
    const r=await env.DB.prepare("UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.status,String(b.id)).run();
    if(!r.meta?.changes)return out({error:"Order not found"},404,headers);
    return out({data:{id:b.id,status:b.status}},200,headers);
  }
  if(m==="PATCH"&&p==="/api/admin/orders/payment-status"){
    const b=await body(request);
    if(!b.id||!PAYMENT_STATUSES.includes(b.payment_status))return out({error:"Invalid order id or payment status"},400,headers);
    const r=await env.DB.prepare("UPDATE orders SET payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.payment_status,String(b.id)).run();
    if(!r.meta?.changes)return out({error:"Order not found"},404,headers);
    return out({data:{id:b.id,payment_status:b.payment_status}},200,headers);
  }
  if(m==="PATCH"&&p==="/api/admin/variants/stock"){
    const b=await body(request),stock=Number(b.stock);
    if(!b.id||!Number.isInteger(stock)||stock<0||stock>1000000)return out({error:"Valid variant id and non-negative integer stock are required"},400,headers);
    const r=await env.DB.prepare("UPDATE product_model_variants SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(stock,String(b.id)).run();
    if(!r.meta?.changes)return out({error:"Variant not found"},404,headers);
    return out({data:{id:b.id,stock}},200,headers);
  }
  if(m==="PATCH"&&p==="/api/admin/settings"){
    const b=await body(request);
    const allowed=["whatsapp","pago_movil_banco","pago_movil_telefono","pago_movil_cedula","binance_id","binance_email","whatsapp_1_url","whatsapp_2_url","hero_image_url","cashea_enabled","hero_title","hero_top_text","hero_description"];
    const keys=allowed.filter(k=>Object.hasOwn(b,k));
    if(!keys.length)return out({error:"No supported settings provided"},400,headers);
    const current=await env.DB.prepare("SELECT id FROM store_settings ORDER BY updated_at DESC LIMIT 1").first();
    if(!current)return out({error:"Store settings row not found"},404,headers);
    const vals=keys.map(k=>k==="cashea_enabled"?(b[k]?1:0):b[k]);
    await env.DB.prepare("UPDATE store_settings SET "+keys.map(k=>k+"=?").join(",")+",updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(...vals,current.id).run();
    return out({data:{updated:keys}},200,headers);
  }
  if(m==="PATCH"&&p==="/api/admin/products"){
    const b=await body(request);
    if(!b.id)return out({error:"Product id required"},400,headers);
    const allowed=["sku","name","description","category_id","price","image_url","image_urls","image_labels","active"];
    const keys=allowed.filter(k=>Object.hasOwn(b,k));
    if(!keys.length)return out({error:"No supported fields"},400,headers);
    if(Object.hasOwn(b,"price")&&(!Number.isFinite(Number(b.price))||Number(b.price)<0))return out({error:"Invalid price"},400,headers);
    const vals=keys.map(k=>["image_urls","image_labels"].includes(k)?JSON.stringify(Array.isArray(b[k])?b[k]:[]):k==="active"?(b[k]?1:0):b[k]);
    const r=await env.DB.prepare("UPDATE products SET "+keys.map(k=>k+"=?").join(",")+",updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(...vals,String(b.id)).run();
    if(!r.meta?.changes)return out({error:"Product not found or unchanged"},404,headers);
    return out({data:{id:b.id,updated:keys}},200,headers);
  }
  if(m==="POST"&&p==="/api/admin/products"){
    const b=await body(request);
    if(!b.sku||!b.name||!Number.isFinite(Number(b.price))||Number(b.price)<0)return out({error:"sku, name and valid non-negative price required"},400,headers);
    const id=String(b.id||crypto.randomUUID());
    await env.DB.prepare("INSERT INTO products (id,sku,name,description,category_id,price,image_url,image_urls,image_labels,active,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)").bind(id,String(b.sku),String(b.name),b.description??null,b.category_id??null,Number(b.price),b.image_url??null,JSON.stringify(Array.isArray(b.image_urls)?b.image_urls:[]),JSON.stringify(Array.isArray(b.image_labels)?b.image_labels:[]),b.active===false?0:1).run();
    return out({data:{id}},201,headers);
  }
  if(m==="DELETE"&&p==="/api/admin/products"){
    const id=url.searchParams.get("id");if(!id)return out({error:"id is required"},400,headers);
    const r=await env.DB.prepare("UPDATE products SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    if(!r.meta?.changes)return out({error:"Product not found"},404,headers);
    return out({data:{id,active:0}},200,headers);
  }
  return out({error:"Admin route not found"},404,headers);
}
async function body(req){const n=Number(req.headers.get("Content-Length")||0);if(n>1000000)throw Error("Too large");return req.json();}
function out(data,status,headers){return new Response(JSON.stringify(data),{status,headers});}
function equal(a,b){const x=enc.encode(a),y=enc.encode(b);if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;}
function b64u(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
function unb64u(s){s=s.replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from(atob(s+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));}
async function sign(claims,secret){const h=b64u(enc.encode(JSON.stringify({alg:"HS256",typ:"JWT"}))),p=b64u(enc.encode(JSON.stringify(claims))),data=h+"."+p;const k=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return data+"."+b64u(new Uint8Array(await crypto.subtle.sign("HMAC",k,enc.encode(data))));}
async function verify(req,env){if(!env.ADMIN_JWT_SECRET)return null;const a=req.headers.get("Authorization")||"",t=a.startsWith("Bearer ")?a.slice(7):"",p=t.split(".");if(p.length!==3)return null;try{const k=await crypto.subtle.importKey("raw",enc.encode(env.ADMIN_JWT_SECRET),{name:"HMAC",hash:"SHA-256"},false,["verify"]);if(!await crypto.subtle.verify("HMAC",k,unb64u(p[2]),enc.encode(p[0]+"."+p[1])))return null;const c=JSON.parse(new TextDecoder().decode(unb64u(p[1])));return c.exp>Math.floor(Date.now()/1000)?c:null;}catch{return null;}}
