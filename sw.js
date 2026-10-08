const CACHE='enoc-admin-v2';
const CORE=['./','./admin.html','./admin.webmanifest','./enoc-icon-180.png','./enoc-icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('push',event=>{
  let data={}; try{data=event.data?event.data.json():{};}catch(e){data={body:event.data?.text?.()||'Hay un nuevo pedido.'};}
  const title=data.title||'🔔 Nuevo pedido ENOC';
  const options={body:data.body||'Hay un nuevo pedido en ENOC.',icon:'./enoc-icon-180.png',badge:'./enoc-icon-180.png',tag:data.tag||'enoc-order',renotify:true,data:{url:data.url||'./admin.html'}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||'./admin.html',self.location.origin).href;
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){ if('focus' in client) return client.focus(); }
    return clients.openWindow(target);
  }));
});
self.addEventListener('fetch',event=>{
  const req=event.request; if(req.method!=='GET') return;
  const url=new URL(req.url); if(url.origin!==self.location.origin) return;
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(resp=>{const copy=resp.clone();caches.open(CACHE).then(c=>c.put('./admin.html',copy));return resp;}).catch(()=>caches.match('./admin.html')));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(resp=>{const copy=resp.clone();caches.open(CACHE).then(c=>c.put(req,copy));return resp;}).catch(()=>caches.match('./admin.html'))));
});
