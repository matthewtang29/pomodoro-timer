// ================================================================= NOTIFICATIONS
// Tells you when a focus block, break or session ends, with the physical timer
// or the built-in one.
// - App in the background: a system notification (with vibration on phones).
// - App on screen: an in-app message, plus the chime.
// Optional: keep the screen awake during a session, so a phone doesn't put the
// app to sleep before the timer ends.

const Notify = (() => {
  const PREF = 'pomodoro-notify';
  const WAKE = 'pomodoro-wakelock';
  let enabled = true, keepAwake = false;
  try {
    enabled = localStorage.getItem(PREF) !== '0';
    keepAwake = localStorage.getItem(WAKE) === '1';
  } catch (e) {}

  const supported = 'Notification' in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function permission() { return supported ? Notification.permission : 'unsupported'; }

  // Ask the browser for permission (must happen right after a click)
  async function ask() {
    if (!enabled || !supported || Notification.permission !== 'default') return permission();
    try { await Notification.requestPermission(); } catch (e) {}
    renderPanel();
    if (typeof Push !== 'undefined') Push.sync();   // also set up alerts for when the app is closed
    return permission();
  }

  // Phones only allow notifications through the service worker; computers allow both
  async function show(title, body) {
    if (!enabled || permission() !== 'granted') return false;
    const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'pomodoro-timer',
                   renotify: true, vibrate: [200, 100, 200], data: { url: location.href } };
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, opts);
        return true;
      }
    } catch (e) {}
    try { new Notification(title, opts); return true; } catch (e) { return false; }
  }

  function taskName() {
    const t = typeof currentTaskId !== 'undefined' && currentTaskId ? taskById(currentTaskId) : null;
    return t ? t.title : '';
  }

  // the final focus block of a custom session has no break after it
  function isLastBlock() { return !!status && status.cycles > 0 && status.cycle >= status.cycles; }

  function messageFor(name) {
    const s = status || {};
    const task = taskName();
    if (name === 'FOCUS_DONE') {
      if (isLastBlock()) return null;   // "Session complete" comes right after instead
      const brk = s.break ? `${s.break}-minute break` : 'break';
      return ['Focus block done 🎉', `Time for a ${brk}.${task ? ` Nice work on "${task}".` : ''}`];
    }
    if (name === 'REST_DONE') {
      const next = s.cycles > 0 ? ` (cycle ${Math.min(s.cycle + 1, s.cycles)} of ${s.cycles})` : '';
      return ['Break over', `Back to focus${next}.`];
    }
    if (name === 'SESSION_ENDED') {
      // the final block's totals arrive in the next status line, so count it here
      const blocks = (s.done || 0) + 1, mins = (s.total || 0) + (s.focus || 0);
      return ['Session complete ✅', `${blocks} focus block${blocks === 1 ? '' : 's'}, ${fmtDuration(mins)} of focus. Well done!`];
    }
    return null;
  }

  function event(name) {
    const msg = messageFor(name);
    if (!msg) return;
    if (!document.hidden) toast(`${msg[0]} · ${msg[1]}`);
    // in the background: the cloud alert covers it when it's set up on this device
    else if (!(typeof Push !== 'undefined' && Push.active)) show(msg[0], msg[1]);
  }

  // ---------------------------------------------------------------- keep screen awake
  let lock = null;
  let sessionActive = false;
  async function syncWakeLock() {
    const want = keepAwake && sessionActive && !document.hidden && 'wakeLock' in navigator;
    try {
      if (want && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!want && lock) {
        await lock.release();
        lock = null;
      }
    } catch (e) { lock = null; }
  }
  // called on every timer update
  function update(st) {
    const active = !!st && !['MENU', 'SUMMARY', 'ENDED', 'EXITED'].includes(st.state);
    if (active !== sessionActive) { sessionActive = active; syncWakeLock(); }
  }
  document.addEventListener('visibilitychange', syncWakeLock);   // the lock drops when you switch away

  // ---------------------------------------------------------------- settings panel
  function renderPanel() {
    const chk = document.getElementById('notifyChk');
    const note = document.getElementById('notifyStatus');
    if (!chk || !note) return;
    chk.checked = enabled;
    const p = permission();
    let text = '';
    if (!supported) text = isIOS && !installed
      ? 'On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), then turn this on there.'
      : "This browser doesn't support notifications. You'll still hear the chime.";
    else if (!enabled) text = 'Off. You\'ll still hear the chime while the app is open.';
    else if (p === 'granted') text = 'On. You\'ll get a notification when a timer ends while the app is in the background.';
    else if (p === 'denied') text = 'Blocked by the browser. Click the icon on the left of the address bar (or your phone\'s app settings) and allow notifications.';
    else text = 'Tap the switch again or start a session to allow notifications.';
    note.textContent = text;
    chk.disabled = !supported;

    const wakeRow = document.getElementById('wakeRow');
    if (wakeRow) {
      wakeRow.hidden = !('wakeLock' in navigator);
      document.getElementById('wakeChk').checked = keepAwake;
    }
  }

  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(PREF, on ? '1' : '0'); } catch (e) {}
    if (on) ask().then(p => {
      if (p === 'granted') show('Notifications are on', "You'll be told when each timer ends.");
      if (typeof Push !== 'undefined') Push.sync();
    });
    else if (typeof Push !== 'undefined') Push.sync();   // turns off closed-app alerts too
    renderPanel();
  }
  function setKeepAwake(on) {
    keepAwake = on;
    try { localStorage.setItem(WAKE, on ? '1' : '0'); } catch (e) {}
    syncWakeLock();
  }

  function start() {
    const chk = document.getElementById('notifyChk');
    if (chk) chk.addEventListener('change', () => setEnabled(chk.checked));
    const wake = document.getElementById('wakeChk');
    if (wake) wake.addEventListener('change', () => setKeepAwake(wake.checked));
    renderPanel();
  }

  return { ask, event, update, start, renderPanel, show, get enabled() { return enabled; } };
})();
