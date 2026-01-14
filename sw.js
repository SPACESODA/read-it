self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open('read-aloud-v3').then((cache) => {
            return cache.addAll([
                './',
                './index.html',
                './style.css',
                './app.js',
                './manifest.webmanifest',
                './icons/android-chrome-192x192.png',
                './icons/android-chrome-512x512.png',
                './icons/apple-touch-icon.png',
                './icons/favicon-32x32.png',
                './icons/favicon-16x16.png',
                './icons/favicon.ico'
            ]);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => (key === 'read-aloud-v3' ? null : caches.delete(key)))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200) {
                    return networkResponse;
                }
                const responseClone = networkResponse.clone();
                caches.open('read-aloud-v3').then((cache) => cache.put(event.request, responseClone));
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});
