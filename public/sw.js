// Service worker for push notifications
self.addEventListener('push', function(event) {
  let data = { title: 'CryptoSignals Pro', body: 'Notification' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {}
  }
  const options = {
    body: data.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: 'trade-' + Date.now(),
    requireInteraction: false
  };
  event.waitUntil(self.registration.showNotification(data.title || 'CryptoSignals Pro', options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
    for (let i = 0; i < clientList.length; i++) {
      if (clientList[i].url && 'focus' in clientList[i]) {
        return clientList[i].focus();
      }
    }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});
