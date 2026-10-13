/* 闹钟 Agent Service Worker — 缓存应用外壳 + Web Push 接收 */
const CACHE='alarm-agent-v1';
const ASSETS=['./','./index.html','./nlu.js','./manifest.webmanifest','./icon.svg'];

self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const url=new URL(e.request.url);
  // API 路由（/v1/*、/api/*）绝不走缓存，始终直连网络 —— 避免陈旧的错误响应（如 404/502）被长期缓存导致门户一直连不上
  if(url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')){
    e.respondWith(fetch(e.request).catch(()=>new Response(
      JSON.stringify({ error:{ code:'network_error', message:'网络不可达' } }),
      { status:503, headers:{ 'Content-Type':'application/json' } }
    )));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(res=>{ const cp=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); return res; }).catch(()=>caches.match('./index.html'))));
});

/* 接收服务端推送：前台已聚焦时由应用内弹窗处理，避免重复通知 */
self.addEventListener('push',e=>{
  let data={title:'⏰ 闹钟', body:'时间到', time:''};
  try{ data=Object.assign(data, JSON.parse(e.data.text())); }catch(_){}
  e.waitUntil((async()=>{
    const all=await clients.matchAll({type:'window', includeUncontrolled:true});
    const focused=all.some(c=>c.focused);
    if(focused) return; // 应用在前台：交给页面内响铃弹窗
    await self.registration.showNotification(data.title,{ body:data.body, tag:'alarm', renotify:true, data:data });
  })());
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list=>{
    for(const c of list){ if('focus' in c) return c.focus(); }
    if(clients.openWindow) return clients.openWindow('/');
  }));
});
