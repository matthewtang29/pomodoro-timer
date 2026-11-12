// Service worker: makes the installed app open instantly and work offline.
// Files come from the saved copy right away; each one is re-checked with GitHub in
// the background, so an update you push is used from the next launch (and an open
// window offers to reload into it straight away).
const CACHE = 'pomegranate-v35';
const ASSETS = [
  './', 'index.html', 'style.css',
  'app.js', 'localtimer.js', 'notify.js', 'score.js', 'analytics.js', 'tasks.js', 'calendar.js', 'journal.js', 'habits.js', 'sleep.js', 'dashboard.js', 'sync.js', 'livesync.js', 'push.js', 'theme.js', 'shortcuts.js', 'main.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/inter.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Saved copy first (so the app opens instantly), then check GitHub in the background
// and save whatever is newer for next time. When the page itself (index.html) has
// changed, the open window is told so it can offer "Reload".
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // the app page itself, opened as ./, ./index.html, ./?do=add, ./#tasks… (other pages such as
  // privacy.html are their own files)
  const scopePath = new URL(self.registration.scope).pathname;
  const nav = req.mode === 'navigate' && (url.pathname === scopePath || url.pathname === scopePath + 'index.html');
  const key = nav ? new URL('index.html', self.registration.scope).href : req;   // every launch URL (?do=add…) is the same page

  const work = (async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    const oldPage = nav && cached ? cached.clone() : null;
    const fresh = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async res => {
      if (res.ok) {
        if (oldPage) {
          const [a, b] = await Promise.all([oldPage.text(), res.clone().text()]);
          if (a !== b) tellPagesUpdated();
        }
        await cache.put(key, res.clone());
      }
      return res;
    });
    return { cached, fresh };
  })();

  e.respondWith(work.then(async ({ cached, fresh }) => {
    if (cached) return cached;
    try { return await fresh; }
    catch (err) {   // offline and never saved
      return (await caches.match(req, { ignoreSearch: true })) || (nav ? caches.match('index.html') : Response.error());
      // (a page that was never opened online, like privacy.html, just shows the browser's offline page)
    }
  }));
  e.waitUntil(work.then(w => w.fresh).catch(() => {}));
});

function tellPagesUpdated() {
  return self.clients.matchAll({ type: 'window' }).then(list => list.forEach(c => c.postMessage({ type: 'app-updated' })));
}

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
