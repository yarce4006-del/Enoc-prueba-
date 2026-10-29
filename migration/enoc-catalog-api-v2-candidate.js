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
        if (url.pathname.startsWith("/api/admin/cashea/") && request.method === "POST" && env.ENABLE_CASHEA_MUTATIONS !== "true") return out({error:"Cashea write routes are locked until isolated staging validation is complete"},503,headers);
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
      if (url.pathname === "/api/legacy-variants") {
        const pid=url.searchParams.get("product_id");
        if(!pid)return out({error:"product_id is required"},400,headers);
        const r=await env.DB.prepare("SELECT id,product_id,sku,size,color,stock,price,active,created_at,updated_at FROM product_variants WHERE active=1 AND product_id=? ORDER BY size,color").bind(pid).all();
        return out({data:r.results},200,headers);
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
    let selectedVariantId=item.variant_id||item.variantId||null;
    let variant=null;
    if (selectedVariantId) {
      variant=await env.DB.prepare("SELECT v.id,v.price,v.stock,v.active,m.product_id,m.id AS model_id FROM product_model_variants v JOIN product_models m ON m.id=v.model_id WHERE v.id=? AND v.active=1 AND m.active=1").bind(String(selectedVariantId)).first();
      if (!variant || variant.product_id!==product.id || (modelId && variant.model_id!==modelId)) return out({error:"A selected size or color is unavailable"},409,headers);
    } else if (modelId) {
      if (item.size===undefined || item.size===null || String(item.size)==="")
        return out({error:"A size/variant must be selected for model-based products"},400,headers);
      let q="SELECT v.id,v.price,v.stock,v.active,m.product_id,m.id AS model_id FROM product_model_variants v JOIN product_models m ON m.id=v.model_id WHERE v.model_id=? AND v.active=1 AND m.active=1 AND v.size=?";
      const params=[String(modelId),String(item.size)];
      if (item.color!==undefined && item.color!==null) { q+=" AND v.color=?"; params.push(String(item.color)); }
      variant=await env.DB.prepare(q+" LIMIT 1").bind(...params).first();
      if (!variant || variant.product_id!==product.id) return out({error:"A selected size or color is unavailable"},409,headers);
      selectedVariantId=variant.id;
    }
    if (variant) {
      if (Number(variant.stock)<qty) return out({error:"Insufficient stock for a selected variant"},409,headers);
      if (variant.price!==null && variant.price!==undefined) price=Number(variant.price);
    }
    if (!Number.isFinite(price)||price<0) return out({error:"Product price is invalid"},409,headers);
    const name=String(item.name||item.product_name||product.name).trim();
    normalized.push({...item,product_id:product.id,variant_id:selectedVariantId,model_id:modelId||variant?.model_id||null,qty,name,price});
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
  // Atomic inventory reservation: create the order only if every selected variant
  // still has sufficient stock. Stock updates run only if the order row was created.
  const variantNeeds=new Map();
  for (const item of normalized) if (item.variant_id) {
    const key=String(item.variant_id);
    variantNeeds.set(key,(variantNeeds.get(key)||0)+item.qty);
  }
  const conditions=[];
  const insertParams=[id,orderNumber,customerName,b.customer_id_number??c.id_number??null,phone,b.customer_email??c.email??null,delivery,b.shipping_address??c.address??null,b.shipping_city??c.city??null,b.shipping_reference??null,payment,"pending",subtotal.toFixed(2),discount.toFixed(2),shipping.toFixed(2),total.toFixed(2),"Pendiente",b.customer_notes??c.notes??null,JSON.stringify(normalized),JSON.stringify(customerData)];
  for (const [variantId,qty] of variantNeeds) {
    conditions.push("EXISTS (SELECT 1 FROM product_model_variants WHERE id=? AND active=1 AND stock>=?)");
    insertParams.push(variantId,qty);
  }
  const insertSql="INSERT INTO orders (id,order_number,customer_name,customer_id_number,customer_phone,customer_email,delivery_method,shipping_address,shipping_city,shipping_reference,payment_method,payment_status,subtotal,discount,shipping_cost,total,status,customer_notes,items,customer_data) SELECT "+Array(20).fill("?").join(",")+" WHERE "+(conditions.length?conditions.join(" AND "):"1=1");
  const batch=[env.DB.prepare(insertSql).bind(...insertParams)];
  for (const [variantId,qty] of variantNeeds) {
    batch.push(env.DB.prepare("UPDATE product_model_variants SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS (SELECT 1 FROM orders WHERE id=?)").bind(qty,variantId,id));
  }
  const result=await env.DB.batch(batch);
  const created=await env.DB.prepare("SELECT id FROM orders WHERE id=?").bind(id).first();
  if (!created) return out({error:"Stock changed during checkout or a selected variant is unavailable. Refresh the catalog and try again."},409,headers);
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
  if(m==="POST"&&p==="/api/admin/cashea/operations"){
    const b=await body(request),total=Number(b.sale_total),initial=Number(b.initial_amount||0);
    const date=String(b.sale_date||"");
    if(!String(b.customer_name||"").trim()||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(total)||total<=0||!Number.isFinite(initial)||initial<0||initial>total)return out({error:"Customer, valid sale date and valid amounts are required"},400,headers);
    const id=crypto.randomUUID(),ref=String(b.operation_reference||"").trim()||null;
    await env.DB.prepare("INSERT INTO cashea_operations (id,operation_reference,customer_name,customer_phone,sales_channel,sale_date,currency,sale_total,initial_amount,financed_amount,commission_sale_pct,commission_financed_pct,estimated_commission,estimated_net_amount,status,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(id,ref,String(b.customer_name).trim(),b.customer_phone||null,b.sales_channel||"physical",date,b.currency||"USD",total.toFixed(2),initial.toFixed(2),round2(total-initial).toFixed(2),Number(b.commission_sale_pct||0).toString(),Number(b.commission_financed_pct||0).toString(),"0.00","0.00",b.notes||null,"admin").run();
    return out({data:{id,status:"draft"}},201,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/items"){
    const b=await body(request),opId=String(b.operation_id||""),items=Array.isArray(b.items)?b.items:[];
    if(!opId||!items.length||items.length>100)return out({error:"operation_id and 1–100 items are required"},400,headers);
    const op=await env.DB.prepare("SELECT id,status FROM cashea_operations WHERE id=?").bind(opId).first();
    if(!op||op.status!=="draft")return out({error:"Items can only be added to a draft operation"},409,headers);
    const stmts=[];
    for(const it of items){
      const qty=Number(it.quantity),price=Number(it.unit_price);
      if(!it.variant_id||!Number.isInteger(qty)||qty<1||!Number.isFinite(price)||price<0)return out({error:"Invalid item variant, quantity or price"},400,headers);
      const variant=await env.DB.prepare("SELECT v.id,v.stock,v.active,m.product_id,m.name AS model_name,m.active AS model_active,p.name AS product_name,p.sku,p.active AS product_active FROM product_model_variants v JOIN product_models m ON m.id=v.model_id JOIN products p ON p.id=m.product_id WHERE v.id=?").bind(String(it.variant_id)).first();
      if(!variant||!variant.active||!variant.model_active||!variant.product_active)return out({error:"An item variant is unavailable"},409,headers);
      stmts.push(env.DB.prepare("INSERT INTO cashea_operation_items (id,operation_id,product_id,variant_id,product_name,sku,model_name,size,color,quantity,unit_price,line_total,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
       .bind(crypto.randomUUID(),opId,variant.product_id,String(it.variant_id),variant.product_name,variant.sku||null,variant.model_name, it.size??null,it.color??null,qty,price.toFixed(2),(price*qty).toFixed(2)));
    }
    await env.DB.batch(stmts);
    return out({data:{operation_id:opId,item_count:items.length}},201,headers);
  }
  if(m==="GET"&&p==="/api/admin/cashea/operations"){
    const r=await env.DB.prepare("SELECT * FROM cashea_operations ORDER BY created_at DESC LIMIT 1000").all();
    return out({data:r.results},200,headers);
  }
  if(m==="GET"&&p==="/api/admin/cashea/items"){
    const id=url.searchParams.get("operation_id");if(!id)return out({error:"operation_id is required"},400,headers);
    const r=await env.DB.prepare("SELECT * FROM cashea_operation_items WHERE operation_id=? ORDER BY created_at").bind(id).all();
    return out({data:r.results},200,headers);
  }
  if(m==="GET"&&p==="/api/admin/cashea/fiscal"){
    const [reserves,declarations]=await env.DB.batch([env.DB.prepare("SELECT * FROM cashea_fiscal_reserves ORDER BY sale_date DESC LIMIT 5000"),env.DB.prepare("SELECT * FROM cashea_fiscal_declarations ORDER BY created_at DESC LIMIT 1000")]);
    return out({data:{reserves:reserves.results,declarations:declarations.results}},200,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/fiscal/reserve"){
    const b=await body(request),rate=Number(b.bcv_rate),rateDate=String(b.rate_date||"");
    if(!b.operation_id||!Number.isFinite(rate)||rate<=0||!/^\d{4}-\d{2}-\d{2}$/.test(rateDate))return out({error:"operation_id, positive BCV rate and YYYY-MM-DD rate_date are required"},400,headers);
    const op=await env.DB.prepare("SELECT id,operation_reference,customer_name,sale_date,sale_total,currency FROM cashea_operations WHERE id=?").bind(String(b.operation_id)).first();
    if(!op)return out({error:"Cashea operation not found"},404,headers);
    if(op.currency&&op.currency!=="USD")return out({error:"Fiscal reserve calculation currently requires USD operations"},409,headers);
    const existing=await env.DB.prepare("SELECT id FROM cashea_fiscal_reserves WHERE operation_id=?").bind(op.id).first();
    if(existing)return out({error:"Fiscal reserve already exists for this operation",id:existing.id},409,headers);
    const usd=Number(op.sale_total);if(!Number.isFinite(usd)||usd<0)return out({error:"Invalid operation sale total"},409,headers);
    const totalBs=round2(usd*rate),taxable=round2(totalBs/1.16),iva=round2(taxable*.16),patente=round2(totalBs*.02),id=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO cashea_fiscal_reserves (id,operation_id,operation_reference,customer_name,sale_date,sale_total_usd,bcv_rate,bcv_rate_date,bcv_rate_source,total_bs,taxable_base_bs,iva_amount_bs,patente_amount_bs,status,created_by,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'registered',NULL,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(id,op.id,op.operation_reference,op.customer_name,op.sale_date,usd.toFixed(2),rate.toFixed(6),rateDate,String(b.rate_source||"BCV verificado"),totalBs.toFixed(2),taxable.toFixed(2),iva.toFixed(2),patente.toFixed(2),b.notes??null).run();
    return out({data:{id,operation_id:op.id,total_bs:totalBs,taxable_base_bs:taxable,iva_amount_bs:iva,patente_amount_bs:patente,status:"registered"}},201,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/fiscal/declarations"){
    const b=await body(request),start=String(b.period_start||""),end=String(b.period_end||"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return out({error:"Valid period_start and period_end are required"},400,headers);
    const ids=Array.isArray(b.reserve_ids)?[...new Set(b.reserve_ids.map(String))]:[];
    if(!ids.length)return out({error:"reserve_ids must contain at least one fiscal reserve"},400,headers);
    const rows=(await env.DB.prepare("SELECT * FROM cashea_fiscal_reserves WHERE status='registered' AND declaration_id IS NULL AND sale_date>=? AND sale_date<=? ORDER BY sale_date").bind(start,end).all()).results;
    const selected=rows.filter(r=>ids.includes(String(r.id)));
    if(selected.length!==ids.length)return out({error:"One or more reserves are missing, already declared, or outside the selected period"},409,headers);
    const sum=k=>round2(selected.reduce((a,r)=>a+Number(r[k]||0),0));
    const id=crypto.randomUUID(),salesUsd=sum("sale_total_usd"),salesBs=sum("total_bs"),taxable=sum("taxable_base_bs"),iva=sum("iva_amount_bs"),patente=sum("patente_amount_bs"),total=round2(iva+patente);
    const batch=[env.DB.prepare("INSERT INTO cashea_fiscal_declarations (id,period_start,period_end,declared_at,declared_by,operation_count,total_sales_usd,total_sales_bs,taxable_base_bs,iva_amount_bs,patente_amount_bs,total_reserved_bs,reference,notes,status,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP,NULL,?,?,?,?,?,?,?,?,?,'registered',CURRENT_TIMESTAMP)").bind(id,start,end,selected.length,salesUsd.toFixed(2),salesBs.toFixed(2),taxable.toFixed(2),iva.toFixed(2),patente.toFixed(2),total.toFixed(2),b.reference??null,b.notes??null)];
    for(const r of selected)batch.push(env.DB.prepare("UPDATE cashea_fiscal_reserves SET declaration_id=?,status='declared',updated_at=CURRENT_TIMESTAMP WHERE id=? AND declaration_id IS NULL AND status='registered'").bind(id,r.id));
    await env.DB.batch(batch);
    return out({data:{id,operation_count:selected.length,total_sales_usd:salesUsd,total_sales_bs:salesBs,taxable_base_bs:taxable,iva_amount_bs:iva,patente_amount_bs:patente,total_reserved_bs:total}},201,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/confirm"){
    const b=await body(request),id=String(b.operation_id||"");if(!id)return out({error:"operation_id is required"},400,headers);
    const op=await env.DB.prepare("SELECT * FROM cashea_operations WHERE id=?").bind(id).first();
    if(!op)return out({error:"Cashea operation not found"},404,headers);
    if(op.status==="confirmed"||op.status==="settled")return out({error:"Operation is already confirmed"},409,headers);
    const items=(await env.DB.prepare("SELECT * FROM cashea_operation_items WHERE operation_id=?").bind(id).all()).results;
    if(!items.length)return out({error:"Operation has no items"},409,headers);
    const needs=new Map();for(const it of items){if(!it.variant_id||!Number.isInteger(Number(it.quantity))||Number(it.quantity)<1)return out({error:"Every item must have a valid variant and quantity"},409,headers);needs.set(String(it.variant_id),(needs.get(String(it.variant_id))||0)+Number(it.quantity));}
    for(const [vid,q] of needs){const v=await env.DB.prepare("SELECT stock,active FROM product_model_variants WHERE id=?").bind(vid).first();if(!v||!v.active||Number(v.stock)<q)return out({error:"Insufficient stock for variant "+vid},409,headers);}
    const total=Number(op.sale_total),initial=Number(op.initial_amount||0),financed=round2(total-initial),salePct=Number(op.commission_sale_pct||0),finPct=Number(op.commission_financed_pct||0);
    if(!Number.isFinite(total)||total<0||initial<0||initial>total||salePct<0||salePct>100||finPct<0||finPct>100)return out({error:"Operation amounts or commission percentages are invalid"},409,headers);
    const commission=round2(total*salePct/100+financed*finPct/100),net=round2(financed-financed*finPct/100);
    const batch=[];for(const [vid,q] of needs)batch.push(env.DB.prepare("UPDATE product_model_variants SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1 AND stock>=?").bind(q,vid,q));
    batch.push(env.DB.prepare("UPDATE cashea_operations SET financed_amount=?,estimated_commission=?,estimated_net_amount=?,status='confirmed',confirmed_at=CURRENT_TIMESTAMP,confirmed_by='admin',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status NOT IN ('confirmed','settled','cancelled')").bind(financed.toFixed(2),commission.toFixed(2),net.toFixed(2),id));
    await env.DB.batch(batch);
    return out({data:{id,status:"confirmed",financed_amount:financed,estimated_commission:commission,estimated_net_amount:net}},200,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/exchange"){
    const b=await body(request),opId=String(b.operation_id||""),itemId=String(b.item_id||""),newId=String(b.new_variant_id||""),reason=String(b.reason||"").trim();
    if(!opId||!itemId||!newId||!reason)return out({error:"operation_id, item_id, new_variant_id and reason are required"},400,headers);
    const [op,item,newV]=await Promise.all([
      env.DB.prepare("SELECT id,status FROM cashea_operations WHERE id=?").bind(opId).first(),
      env.DB.prepare("SELECT * FROM cashea_operation_items WHERE id=? AND operation_id=?").bind(itemId,opId).first(),
      env.DB.prepare("SELECT v.*,m.product_id,m.name AS model_name,p.name AS product_name FROM product_model_variants v JOIN product_models m ON m.id=v.model_id JOIN products p ON p.id=m.product_id WHERE v.id=? AND v.active=1 AND m.active=1 AND p.active=1").bind(newId).first()
    ]);
    if(!op||!item||!newV)return out({error:"Operation, item or new variant not found"},404,headers);
    if(!["confirmed","settled"].includes(op.status))return out({error:"Only confirmed operations can exchange items"},409,headers);
    if(String(item.variant_id)===newId)return out({error:"Choose a different variant"},400,headers);
    if(Number(newV.stock)<Number(item.quantity))return out({error:"Insufficient stock for the new variant"},409,headers);
    const oldV=await env.DB.prepare("SELECT v.*,m.product_id,m.name AS model_name,p.name AS product_name FROM product_model_variants v JOIN product_models m ON m.id=v.model_id JOIN products p ON p.id=m.product_id WHERE v.id=?").bind(String(item.variant_id)).first();
    if(!oldV)return out({error:"Original variant not found"},409,headers);
    await env.DB.batch([
      env.DB.prepare("UPDATE product_model_variants SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(Number(item.quantity),String(item.variant_id)),
      env.DB.prepare("UPDATE product_model_variants SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1 AND stock>=?").bind(Number(item.quantity),newId,Number(item.quantity)),
      env.DB.prepare("INSERT INTO cashea_item_exchanges (id,operation_id,operation_item_id,from_variant_id,to_variant_id,from_product_id,to_product_id,from_product_name,from_model_name,from_size,from_color,to_product_name,to_model_name,to_size,to_color,quantity,reason,changed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admin',CURRENT_TIMESTAMP)").bind(crypto.randomUUID(),opId,itemId,String(item.variant_id),newId,oldV.product_id,newV.product_id,oldV.product_name,oldV.model_name,oldV.size,oldV.color,newV.product_name,newV.model_name,newV.size,newV.color,Number(item.quantity),reason),
      env.DB.prepare("UPDATE cashea_operation_items SET variant_id=?,product_id=?,product_name=?,model_name=?,size=?,color=?,sku=(SELECT sku FROM products WHERE id=?),unit_price=?,line_total=? WHERE id=? AND operation_id=?").bind(newId,newV.product_id,newV.product_name||newV.name,newV.model_name,newV.size,newV.color,newV.product_id,Number(newV.price??item.unit_price).toFixed(2),(Number(newV.price??item.unit_price)*Number(item.quantity)).toFixed(2),itemId,opId)
    ]);
    return out({data:{ok:true,message:"Cambio registrado y stock actualizado",operation_id:opId,item_id:itemId}},200,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/payments/batches"){
    const b=await body(request),date=String(b.payment_date||""),amount=Number(b.amount_received),currency=String(b.currency||"USD"),ids=Array.isArray(b.operation_ids)?[...new Set(b.operation_ids.map(String))]:[];
    if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||!Number.isFinite(amount)||amount<=0||!ids.length)return out({error:"Valid payment_date, positive amount_received and operation_ids are required"},400,headers);
    const ops=[];for(const id of ids){const op=await env.DB.prepare("SELECT * FROM cashea_operations WHERE id=?").bind(id).first();if(!op||op.status!=="confirmed")return out({error:"Every operation must exist and be awaiting payment"},409,headers);if(String(op.currency||"USD")!==currency)return out({error:"Payment currency does not match operation currency"},409,headers);const prior=await env.DB.prepare("SELECT COUNT(*) n FROM cashea_payment_batch_operations WHERE operation_id=?").bind(id).first();if(Number(prior.n)>0)return out({error:"An operation is already linked to a payment batch"},409,headers);ops.push(op);}
    const expected=round2(ops.reduce((s,o)=>s+Number(o.estimated_net_amount||0),0));if(Math.abs(expected-amount)>0.01)return out({error:"Received amount does not match the combined net pending amount",expected_amount:expected},409,headers);
    const batchId=crypto.randomUUID(),statements=[env.DB.prepare("INSERT INTO cashea_payment_batches (id,payment_date,amount_received,currency,reference,notes,registered_by,created_at) VALUES (?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP)").bind(batchId,date,amount.toFixed(2),currency,b.reference??null,b.notes??null)];
    for(const id of ids){statements.push(env.DB.prepare("INSERT INTO cashea_payment_batch_operations (id,payment_batch_id,operation_id,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(crypto.randomUUID(),batchId,id));statements.push(env.DB.prepare("UPDATE cashea_operations SET status='settled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='confirmed'").bind(id));}
    await env.DB.batch(statements);
    return out({data:{id:batchId,payment_date:date,amount_received:amount,currency,operation_ids:ids,status:"registered"}},201,headers);
  }
  if(m==="POST"&&p==="/api/admin/cashea/payments/reverse"){
    const b=await body(request),id=String(b.operation_id||""),reason=String(b.reason||"Pago marcado por error").trim();if(!id)return out({error:"operation_id is required"},400,headers);
    const op=await env.DB.prepare("SELECT * FROM cashea_operations WHERE id=? AND status='settled'").bind(id).first();if(!op)return out({error:"Settled operation not found"},404,headers);
    const links=(await env.DB.prepare("SELECT b.*,l.id AS link_id FROM cashea_payment_batch_operations l JOIN cashea_payment_batches b ON b.id=l.payment_batch_id WHERE l.operation_id=?").bind(id).all()).results;
    if(links.length!==1)return out({error:"Operation must belong to exactly one payment batch to reverse"},409,headers);
    const settlements=await env.DB.prepare("SELECT COUNT(*) n FROM cashea_settlements WHERE operation_id=?").bind(id).first();if(Number(settlements.n)>0)return out({error:"A settlement exists for this operation; reversal requires manual reconciliation"},409,headers);
    const link=links[0],revId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cashea_payment_reversals (id,original_batch_id,operation_id,payment_date,amount_received,currency,reference,original_batch_created_at,reversed_by,reversed_at,reason,operation_reference,customer_name) VALUES (?,?,?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP,?,?,?)").bind(revId,link.id,id,link.payment_date,op.estimated_net_amount||"0",op.currency||"USD",link.reference,link.created_at,reason,op.operation_reference,op.customer_name),
      env.DB.prepare("DELETE FROM cashea_payment_batch_operations WHERE id=?").bind(link.link_id),
      env.DB.prepare("UPDATE cashea_operations SET status='confirmed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='settled'").bind(id)
    ]);
    return out({data:{ok:true,id:revId,operation_id:id,status:"confirmed"}},200,headers);
  }
  if(m==="GET"&&p==="/api/admin/cashea/payments"){
    const [batches,links,reversals]=await env.DB.batch([env.DB.prepare("SELECT * FROM cashea_payment_batches ORDER BY created_at DESC LIMIT 1000"),env.DB.prepare("SELECT * FROM cashea_payment_batch_operations"),env.DB.prepare("SELECT * FROM cashea_payment_reversals ORDER BY reversed_at DESC LIMIT 1000")]);
    return out({data:{batches:batches.results,operations:links.results,reversals:reversals.results}},200,headers);
  }
  return out({error:"Admin route not found"},404,headers);
}
function round2(n){return Math.round((Number(n)+Number.EPSILON)*100)/100;}
async function body(req){const n=Number(req.headers.get("Content-Length")||0);if(n>1000000)throw Error("Too large");return req.json();}
function out(data,status,headers){return new Response(JSON.stringify(data),{status,headers});}
function equal(a,b){const x=enc.encode(a),y=enc.encode(b);if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;}
function b64u(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
function unb64u(s){s=s.replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from(atob(s+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));}
async function sign(claims,secret){const h=b64u(enc.encode(JSON.stringify({alg:"HS256",typ:"JWT"}))),p=b64u(enc.encode(JSON.stringify(claims))),data=h+"."+p;const k=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return data+"."+b64u(new Uint8Array(await crypto.subtle.sign("HMAC",k,enc.encode(data))));}
async function verify(req,env){
 const auth=req.headers.get("Authorization")||"",token=auth.startsWith("Bearer ")?auth.slice(7):"";
 if(!token)return null;
 if(env.ADMIN_JWT_SECRET){
  const p=token.split(".");
  if(p.length===3)try{const k=await crypto.subtle.importKey("raw",enc.encode(env.ADMIN_JWT_SECRET),{name:"HMAC",hash:"SHA-256"},false,["verify"]);if(await crypto.subtle.verify("HMAC",k,unb64u(p[2]),enc.encode(p[0]+"."+p[1]))){const c=JSON.parse(new TextDecoder().decode(unb64u(p[1])));if(c.exp>Math.floor(Date.now()/1000)&&c.role==="admin")return c;}}catch{}
 }
 // Accept an authenticated Supabase session only after server-side token validation.
 if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)return null;
 try{
  const r=await fetch(env.SUPABASE_URL.replace(/\/$/,"")+"/auth/v1/user",{headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:"Bearer "+token}});
  if(!r.ok)return null;
  const user=await r.json();
  if(!user?.id||!user?.email)return null;
  const allowed=(env.ADMIN_ALLOWED_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  const role=user.app_metadata?.role||user.user_metadata?.role;
  if(role!=="admin"&&!allowed.includes(String(user.email).toLowerCase()))return null;
  return {sub:user.id,role:"admin",email:user.email,auth_source:"supabase"};
 }catch{return null;}
}
