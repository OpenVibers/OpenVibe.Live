/* OpenVibe — shared Web Push service worker.
 * Served by every OpenVibe site at /openvibe-sw.js (must be same-origin, scope "/").
 * Payload (from openvibe.network push-service): { title, body, icon, url, tag } */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'OpenVibe', body: event.data ? event.data.text() : '' }; }
    const title = data.title || 'OpenVibe';
    const options = {
        body: data.body || '',
        icon: data.icon || 'https://openvibe.network/assets/logo-192.png',
        badge: data.badge || 'https://openvibe.network/assets/logo-72.png',
        tag: data.tag || 'openvibe',
        renotify: !!data.renotify,
        data: { url: data.url || 'https://openvibe.network/notifications', id: data.id || null },
        requireInteraction: false,
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || 'https://openvibe.network/notifications';
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        let target = null;
        try { target = new URL(url); } catch { /* */ }
        for (const c of all) {
            try {
                if (target && new URL(c.url).origin === target.origin && 'focus' in c) {
                    await c.focus();
                    if ('navigate' in c) { try { await c.navigate(url); } catch { /* cross-origin navigate blocked */ } }
                    return;
                }
            } catch { /* */ }
        }
        await self.clients.openWindow(url);
    })());
});
