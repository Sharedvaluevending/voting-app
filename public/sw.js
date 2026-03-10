// Service Worker - Web Push notifications
self.addEventListener('push', function(event) {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'AlphaConfluence', body: event.data.text() || '' };
  }
  const title = payload.title || 'AlphaConfluence';
  const body = payload.body || '';
  const tag = payload.tag || 'trade';
  const url = payload.url || '/trades';
  const options = {
    body,
    tag,
    icon: '/images/logo-icon.png',
    badge: '/images/logo-icon.png',
    data: { url: payload.url || '/trades', ...(payload.data || {}) },
    requireInteraction: false,
    vibrate: [100, 50, 100]
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/trades';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(self.location.origin + (url.startsWith('/') ? url : '/' + url));
      }
    })
  );
});
