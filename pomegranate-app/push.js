// ================================================================= ALERTS WHILE THE APP IS CLOSED
// Phones pause web apps in the background, so the app can't fire its own
// "focus done" alert there. Instead, each signed-in device that allows
// notifications registers for Web Push here, and the cloud function in
// cloud/functions sends the alert at the exact moment each focus block or break
// ends, whether the app is open, in the background, or closed.
//
// Works on computers (Chrome, Edge, Firefox, Safari), Android, and iPhone/iPad
// once the app is added to the Home Screen (iOS 16.4+).
//
// While push is set up on a device, the app doesn't also show its own system
// notification there (no doubles); the in-app message still appears when it's open.

const Push = (() => {
  // Public half of the key pair that signs our notifications. The private half is a
  // secret stored only in Firebase (see cloud/SETUP.md). If you make a new pair,
  // update this and cloud/functions/index.js.
  const VAPID_PUBLIC = 'BIdsimzWVAM035hZfFhbcLFL66kWxrr54FMr1Cwmj2jUKFckx61Pd55DSURrK5KkTrN1JPRnrBvqCmqPlRUllLM';
  const FLAG = 'pomodoro-push-active';

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let user = null, db = null;
  let active = false, problem = '', testPending = false;
  try { active = localStorage.getItem(FLAG) === '1'; } catch (e) {}

  const myDoc = () => db.doc(`users/${user.uid}/push/${Sync.deviceId}`);
  function setActive(on) {
    active = on;
    try { localStorage.setItem(FLAG, on ? '1' : '0'); } catch (e) {}
  }

  function keyBytes(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  // Make this device's push registration match the settings: on when signed in and
  // notifications are allowed, off otherwise.
  async function sync() {
    problem = '';
    const want = supported && !!user && Notify.enabled && Notification.permission === 'granted';
    if (!want) {
      if (!user && active) setActive(false);   // signed out: the cloud copy was removed in forget()
      else if (user && active) await forget();
      render();
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub)) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
      await myDoc().set({ sub: sub.toJSON(), name: Sync.deviceName, updated: Date.now() });
      setActive(true);
    } catch (e) {
      setActive(false);
      problem = e && e.message ? e.message : String(e);
    }
    render();
  }

  function sameKey(sub) {
    try {
      const k = new Uint8Array(sub.options.applicationServerKey);
      const want = keyBytes(VAPID_PUBLIC);
      return k.length === want.length && k.every((v, i) => v === want[i]);
    } catch (e) { return true; }
  }

  // stop alerts on this device (signing out, or notifications turned off)
  async function forget() {
    setActive(false);
    try { if (user && db) await myDoc().delete(); } catch (e) {}
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) {}
    render();
  }

  // ask the cloud function to send a test alert to every device that has them on
  function test() {
    if (!user || !db) return;
    testPending = true;
    render();
    db.doc(`users/${user.uid}/live/test`).set({ at: Date.now(), by: Sync.deviceId })
      .catch(e => { problem = e.message || String(e); })
      .finally(() => setTimeout(() => { testPending = false; render(); }, 4000));
  }

  function onAuth(u, d) {
    user = u; db = d;
    sync();
  }

  // ---------------------------------------------------------------- settings panel
  function render() {
    const note = document.getElementById('pushStatus');
    const btn = document.getElementById('pushTest');
    if (!note || !btn) return;
    let text = '';
    if (!supported) text = '';
    else if (!user) text = 'Sign in to also get alerts when the app is closed, on every device.';
    else if (problem) text = `Couldn't set up alerts for when the app is closed: ${problem}`;
    else if (active) text = '✓ Alerts reach this device even when the app is closed.';
    note.textContent = text;
    note.classList.toggle('sync-err', !!problem);
    note.hidden = !text;
    btn.hidden = !(user && active);
    btn.disabled = testPending;
    btn.textContent = testPending ? 'Sent, check your devices…' : 'Send a test alert';
  }

  function start() {
    const btn = document.getElementById('pushTest');
    if (btn) btn.addEventListener('click', test);
    render();
  }

  return { start, sync, forget, onAuth, test, get active() { return active && !!user; } };
})();
