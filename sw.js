// アプリ本体・WebLLM本体(JS)をオフライン用に保存するService Worker。
// ※ AIモデル本体の保存はWebLLMが別のキャッシュ(Cache Storage)で行います。
const VERSION = "v6";
const APP_CACHE = "ioa-app-" + VERSION;
const CDN_CACHE = "ioa-cdn-v1";
const APP_FILES = [
  "./", "./index.html", "./style.css", "./app.js", "./worker.js", "./lab.html", "./lab.js",
  "./webllm-url.js", "./manifest.webmanifest",
  "./icon-180.png", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP_CACHE)
      .then((c) => c.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("ioa-app-") && k !== APP_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // WebLLM本体(JS)：キャッシュ優先。なければ取得して保存。
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }
  // アプリ本体：キャッシュ優先、裏で更新。
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  // それ以外（モデル配布元など）はWebLLM自身のキャッシュ処理に任せる。
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req)
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (hit) return hit;
  const res = await net;
  if (res) return res;
  const fallback = await cache.match("./index.html");
  return fallback || new Response("オフラインです", { status: 503 });
}
