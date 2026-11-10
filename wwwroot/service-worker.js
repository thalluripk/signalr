"use strict";
const CACHE = "direct-shell-v2";
const ASSETS = ["/", "/index.html", "/css/site.css", "/js/theme.js", "/js/call.js", "/js/pwa.js", "/manifest.webmanifest", "/lib/signalr/signalr.min.js", "/lib/lucide/lucide.min.js", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"];
self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith("direct-shell-") && name !== CACHE).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});
self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== self.location.origin || url.search || !ASSETS.includes(url.pathname)) return;
    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    } else event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
self.addEventListener("message", event => {
    if (event.data?.type !== "APPLY_UPDATE") return;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const results = await Promise.all(windows.map(client => new Promise(resolve => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 2000);
            channel.port1.onmessage = response => {
                clearTimeout(timeout);
                channel.port1.close();
                resolve(response.data?.idle === true);
            };
            client.postMessage({ type: "CHECK_IDLE" }, [channel.port2]);
        })));
        if (results.every(Boolean)) await self.skipWaiting();
        else event.source?.postMessage({ type: "UPDATE_BLOCKED" });
    })());
});