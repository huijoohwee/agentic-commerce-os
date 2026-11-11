const status = document.querySelector('#offline-status');

if (!('serviceWorker' in navigator)) {
  status.textContent = 'This browser does not support offline caching.';
} else {
  navigator.serviceWorker.register('../sw.js', { scope: '../' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      status.textContent = 'This index and its source manifest are cached on this device.';
    })
    .catch(() => {
      status.textContent = 'Offline caching is unavailable; the source links remain read-only.';
    });
}
