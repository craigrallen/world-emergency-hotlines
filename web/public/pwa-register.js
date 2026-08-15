/* No analytics or reporting: this script only manages the local offline shell. */
(() => {
  const status = document.querySelector('[data-offline-status]');
  const message = document.querySelector('[data-offline-message]');
  const show = (text) => { if (status && message) { message.textContent = text; status.hidden = false; } };
  const hide = () => { if (status) status.hidden = true; };
  const updateNetworkStatus = () => navigator.onLine ? hide() : show('You appear to be offline. Only the limited cached shell is available; hotline listings are not cached.');
  addEventListener('online', updateNetworkStatus);
  addEventListener('offline', updateNetworkStatus);
  updateNetworkStatus();
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }).catch(() => {}), { once: true });
})();
