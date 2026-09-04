// Минимальный service worker — нужен только для того, чтобы уведомления
// (Notification API) могли показываться и когда вкладка свёрнута в фон.
// Никакого офлайн-кеша сознательно не делаем — приложению нужны свежие данные.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
