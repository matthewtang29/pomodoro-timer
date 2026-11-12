// ================================================================= START-UP
// Tabs, installable-app setup, and first render. Loaded last.

const VIEWS = { today: 'todayView', timer: 'timerView', tasks: 'tasksView', calendar: 'calView', journal: 'journalView', habits: 'habitsView', sleep: 'sleepView' };

function showTab(name) {
  if (!VIEWS[name]) name = 'timer';
  for (const [key, id] of Object.entries(VIEWS)) $(id).hidden = key !== name;
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  editingId = null;
  if (name === 'today') renderDashboard();   // dashboard.js
  if (name === 'tasks') { renderProjectLists(); renderTasks(); }
  if (name === 'calendar') renderCalendar();
  if (name === 'journal') renderJournal();
  if (name === 'habits') renderHabits();
  if (name === 'sleep') renderSleep();
  if (name === 'timer') renderTimerTask();
  history.replaceState(null, '', name === 'timer' ? location.pathname + location.search : '#' + name);
}
// Redraw whatever page is open (after a restore, a goal change, or clearing history)
function refreshView() {
  const open = Object.entries(VIEWS).find(([, id]) => !$(id).hidden);
  showTab(open ? open[0] : 'timer');
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
  // the Tasks button always goes back to all projects (a project in the sidebar picks one)
  if (b.dataset.tab === 'tasks' && projFilter) { projFilter = ''; qaFollowProject(); }
  showTab(b.dataset.tab);
}));

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
  const offerReload = () => {
    if (offered) return;
    offered = true;
    toast('A new version of the app is ready', 'Reload', () => location.reload());
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadWorker) offerReload(); });
  // the app opened from its saved copy and GitHub has a newer page
  navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'app-updated') offerReload(); });
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

// ---------------------------------------------------------------- one window at a time
// The first window holds a browser lock for as long as it's open. A window opened while
// it's held (a second click on the icon, a hotkey, a shortcut) passes what it was opened
// for (start a session, add a task, a tab) to the open window and closes itself. If the
// browser won't let it close (a normal tab), it says so and offers to take over instead.
// The manifest's launch_handler does the same job inside Chrome when it applies; this is
// the backup for launches it doesn't cover.
const SingleWindow = (() => {
  const LOCK = 'pomegranate-window';
  const TAKE = 'pomegranate-take-over';
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(LOCK) : null;
  const forever = () => new Promise(() => {});

  function hold(steal) {
    return navigator.locks.request(LOCK, steal ? { steal: true } : { ifAvailable: true }, lock => {
      if (!lock) { handOff(); return; }   // another window has it
      if (channel) channel.onmessage = e => onLaunch(e.data);
      handleLaunchAction();
      return forever();   // keep the lock until this window closes
    }).catch(() => showBlocked('Pomegranate is now open in another window.'));   // taken over by another window
  }

  // this is the open window: do what the new one was opened for
  function onLaunch(msg) {
    if (!msg || msg.type !== 'launch') return;
    try { window.focus(); } catch (e) {}
    if (msg.action) runLaunchAction(msg.action, 0);
    else if (msg.tab) showTab(msg.tab);
  }

  // this is the extra window: hand over and close
  function handOff() {
    const tab = (location.hash || '').slice(1);
    if (channel) channel.postMessage({ type: 'launch', action: launchAction || '', tab: VIEWS[tab] ? tab : '' });
    window.close();
    setTimeout(() => showBlocked('Pomegranate is already open in another window.'), 300);   // still here: closing wasn't allowed
  }

  function showBlocked(text) {
    if (document.getElementById('dupOverlay')) return;
    const box = el('div', 'dup-overlay');
    box.id = 'dupOverlay';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const card = el('div', 'dup-card box pad');
    card.append(el('h2', null, text), el('p', 'sync-note', 'Use that window, or switch to this one. The other window will pause.'));
    const use = el('button', 'primary', 'Use this window');
    use.type = 'button';
    use.addEventListener('click', () => {
      try { sessionStorage.setItem(TAKE, '1'); } catch (e) {}
      location.reload();   // reload so this window starts from the latest saved data
    });
    card.append(use);
    box.append(card);
    document.body.append(box);
    use.focus();
  }

  function start() {
    if (!navigator.locks) { handleLaunchAction(); return; }   // very old browser: no check
    let steal = false;
    try { steal = sessionStorage.getItem(TAKE) === '1'; sessionStorage.removeItem(TAKE); } catch (e) {}
    hold(steal);
  }
  return { start };
})();

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
LocalTimer.start();   // the timer (always, unless BOARD_RUNS_TIMER in app.js hands it to the board)
Sync.start();         // reconnects cloud sync if you signed in before
Notify.start();       // timer-finished alerts (settings in the ⚙ menu)
Push.start();         // alerts while the app is closed (needs sign-in)
showTab((location.hash || '').slice(1) || 'timer');
SingleWindow.start();  // only one Pomegranate window at a time; also runs a shortcut's action

// The installed app reconnects to the timer it used last time, without the port picker
if (isInstalledApp && 'serial' in navigator) {
  navigator.serial.getPorts().then(ports => {
    if (ports.length === 1 && !port) connect(ports[0]);
  }).catch(() => {});
}
