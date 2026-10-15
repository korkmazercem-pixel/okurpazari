/* OkurPazarı service worker — uygulama gibi yüklenebilsin ve çevrimdışı açılsın diye.
   Ağ öncelikli: internet varsa her zaman güncel sürüm gelir (yeniden yükleme gerekmez); yoksa son kopya açılır. */
const CACHE = "okurpazari-v1";
const KABUK = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(KABUK).catch(() => {}))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // Google/Gemini istekleri olduğu gibi geçer
  e.respondWith(fetch(e.request).then((r) => { const kopya = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, kopya)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined))));
});
