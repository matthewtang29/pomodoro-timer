// ================================================================= START-UP
// Tabs, installable-app setup, and first render. Loaded last.

const VIEWS = { timer: 'timerView', tasks: 'tasksView', calendar: 'calView', journal: 'journalView', analytics: 'analyticsView' };

function showTab(name) {
  if (!VIEWS[name]) name = 'timer';
  for (const [key, id] of Object.entries(VIEWS)) $(id).hidden = key !== name;
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  editingId = null;
  if (name === 'analytics') renderAnalytics();
  if (name === 'tasks') { renderProjectLists(); renderTasks(); }
  if (name === 'calendar') renderCalendar();
  if (name === 'journal') renderJournal();
  if (name === 'timer') renderTimerTask();
  history.replaceState(null, '', name === 'timer' ? location.pathname + location.search : '#' + name);
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// Keyboard: arrow keys move between tabs when a tab has focus
$('tabTimer').parentElement.addEventListener('keydown', e => {
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  if (!fwd && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = tabs[(i + (fwd ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  showTab(next.dataset.tab);
});

// Re-render at midnight-ish so "Today" stays correct if the app stays open
let lastDay = dayKey(Date.now());
setInterval(() => {
  const k = dayKey(Date.now());
  if (k !== lastDay) {
    lastDay = k;
    const open = Object.entries(VIEWS).find(([, id]) => !$(id).hidden);
    showTab(open ? open[0] : 'timer');
  }
}, 60000);

// ---------------------------------------------------------------- installable app (PWA)
const isInstalledApp = window.matchMedia('(display-mode: standalone)').matches ||
                       window.matchMedia('(display-mode: window-controls-overlay)').matches;

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const hadWorker = !!navigator.serviceWorker.controller;
  // updateViaCache: 'none' -> always check GitHub for a newer sw.js
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => reg.update())
    .catch(() => {});
  // A new version was just installed: offer to reload into it
  // (not automatic, so a running session isn't cut off)
  let offered = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker || offered) return;
    offered = true;
    toast('A new version of the app is ready', 'Reload', () => location.reload());
  });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('Installed! Open Pomegranate from your Start menu or taskbar.'); });

// ---------------------------------------------------------------- first render
if (!('serial' in navigator)) {
  $('unsupported').hidden = false;
  $('connectBtn').disabled = true;
}
loadSettings();
updateTotalHint();
qaDefaults();
renderProjectLists();
render();
LocalTimer.start();   // drives the app until a physical timer is connected
Sync.start();         // reconnects cloud sync if you signed in before
Notify.start();       // timer-finished alerts (settings in the ⚙ menu)
Push.start();         // alerts while the app is closed (needs sign-in)
showTab((location.hash || '').slice(1) || 'timer');
handleLaunchAction();  // opened from a taskbar / home-screen shortcut (shortcuts.js)

// The installed app reconnects to the timer it used last time, without the port picker
if (isInstalledApp && 'serial' in navigator) {
  navigator.serial.getPorts().then(ports => {
    if (ports.length === 1 && !port) connect(ports[0]);
  }).catch(() => {});
}
