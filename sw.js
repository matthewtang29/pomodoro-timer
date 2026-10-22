// Service worker: lets the installed app open offline.
// Network first, and every request double-checks with GitHub that the file hasn't
// changed (instead of trusting the browser's 10-minute cache), so updates you push
// show up the next time the app opens. The cached copy is only used when offline.
const CACHE = 'pomegranate-v16';
const ASSETS = [
  './', 'index.html', 'style.css',
  'app.js', 'localtimer.js', 'notify.js', 'score.js', 'analytics.js', 'tasks.js', 'calendar.js', 'journal.js', 'sync.js', 'livesync.js', 'push.js', 'theme.js', 'shortcuts.js', 'main.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/inter.woff2', 'fonts/figtree.woff2', 'fonts/nunito.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});

// Alerts sent by the cloud function (focus done, break over, session complete).
// They arrive even when the app is closed. If the app is on screen it already shows
// its own message, so the system notification is skipped there, except on Apple
// devices, which require every alert to be shown.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const onScreen = list.some(c => c.visibilityState === 'visible');
    const ua = self.navigator.userAgent;
    const apple = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
    if (onScreen && !apple && !d.test) return;
    await self.registration.showNotification(d.title || 'Pomegranate', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      tag: d.tag || 'pomodoro-timer', renotify: true, vibrate: [200, 100, 200], data: { url: './' },
    });
  })());
});

// Clicking a "timer finished" notification brings the app back to the front
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});
