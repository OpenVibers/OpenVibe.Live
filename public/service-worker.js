// Legacy push worker from the first release. Nothing registers it any more (the site uses /openvibe-sw.js
// from openvibe-shared); it stays so browsers that registered it long ago keep a valid script, and its
// icon paths now point at files that exist.
/* OpenVibe.Live — Service Worker for Push Notifications */

self.addEventListener('push', (event) => {
    if (!event.data) return;
    try {
        const data = event.data.json();
        const options = {
            body: data.body || '',
            icon: data.icon || '/assets/logo-192.png',
            badge: '/assets/logo-72.png',
            tag: data.tag || 'openvibe-notification',
            data: { url: data.url || '/' },
            requireInteraction: false,
        };
        event.waitUntil(
            self.registration.showNotification(data.title || 'OpenVibe.Live', options)
        );
    } catch (e) {
        // Fallback for non-JSON payloads
        event.waitUntil(
            self.registration.showNotification('OpenVibe.Live', { body: event.data.text() })
        );
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // Focus existing tab if open
            for (const client of windowClients) {
                if (client.url.includes('openvibe.live') && 'focus' in client) {
                    client.focus();
                    if (url !== '/') client.navigate(url);
                    return;
                }
            }
            // Otherwise open new tab
            return clients.openWindow(url);
        })
    );
});
