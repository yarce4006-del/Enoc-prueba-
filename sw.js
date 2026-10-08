const CACHE='enoc-admin-v1';
const CORE=['./admin.html','./admin.webmanifest','./enoc-icon.svg'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return;
  event.respondWith(fetch(event.request).then(res=>{
    const copy=res.clone(); caches.open(CACHE).then(c=>c.put(event.request,copy)); return res;
  }).catch(()=>caches.match(event.request)));
});
