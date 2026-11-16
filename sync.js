// ================================================================= CLOUD SYNC
// Sign in with Google to keep tasks, journal entries, habits, sleep, study history and the focus
// goal in sync between devices (Firebase Firestore, free tier).
//
// How it works
// - Everything still lives in this browser first, so the app works offline.
//   The cloud copy is a mirror that each device reads from and writes to.
// - Tasks and journal entries are stored one per cloud document with an update
//   time ("u"). When two devices change the same item, the newer change wins.
//   Deleted items leave a small "deleted" marker so the deletion syncs too.
// - Study history (focus/break time, sessions) is stored per device, so two
//   devices studying on the same day never overwrite each other. The Calendar
//   and the timer's stats add up all devices.
// - Deletion markers are dropped after 90 days (here and in the cloud). A device that stays
//   offline longer than that can bring a deleted item back.
// - Known limitation: "newer" means each device's own clock. If one device's clock is far
//   off, its changes win (or lose) when they shouldn't. Not handled.
//
// Cloud layout:  users/{uid}/tasks/{taskId}
//                users/{uid}/journal/{YYYY-MM-DD}
//                users/{uid}/habits/{habitId}
//                users/{uid}/sleep/{YYYY-MM-DD}
//                users/{uid}/days/{YYYY-MM-DD}__{deviceId}
//                users/{uid}/meta/settings
//                users/{uid}/robot/claude   (Claude Code status for the desk robot: written by the
//                                            laptop with the Admin SDK, read-only here; see claudestatus.js)

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDLqMC3ITgcerijdciFkyOA1rTkRAtnu8g',
  authDomain: 'pomodoro-timer-8d10f.firebaseapp.com',
  projectId: 'pomodoro-timer-8d10f',
  storageBucket: 'pomodoro-timer-8d10f.firebasestorage.app',
  messagingSenderId: '643123974057',
  appId: '1:643123974057:web:dcdfaa558cf59c3c573eb8',
};
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

const Sync = (() => {
  const LS = {
    device: 'pomodoro-device-id', enabled: 'pomodoro-sync-enabled',
    tomb: 'pomodoro-sync-tombstones', remote: 'pomodoro-sync-remote-days', metaU: 'pomodoro-goal-u',
    uid: 'pomodoro-sync-uid',   // last account this device synced with, to notice an account switch
  };
  const TOMB_MAX_AGE = 90 * 864e5;
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { safeSetItem(k, JSON.stringify(v)); };

  // ---------------------------------------------------------------- device identity
  let deviceId = read(LS.device, null);
  if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10); write(LS.device, deviceId); }
  const ua = navigator.userAgent;
  const deviceName = (/iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Computer') +
    ' · ' + (/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser');

  // ---------------------------------------------------------------- change tracking (always on)
  // prev: last known JSON of each item (without its "u"), to notice what changed on save
  const prev = { tasks: {}, journal: {}, days: {}, habits: {}, sleep: {} };
  const tomb = read(LS.tomb, { tasks: {}, journal: {} });   // deleted item -> when
  tomb.habits = tomb.habits || {};
  tomb.sleep = tomb.sleep || {};
  let remoteDays = read(LS.remote, {});                      // deviceId -> { date: day }
  let metaU = read(LS.metaU, 0);
  const dirty = { tasks: new Set(), journal: new Set(), days: new Set(), habits: new Set(), sleep: new Set(), meta: false };
  // While writing changes that came from elsewhere (the cloud, a backup), the saves must not
  // look like fresh local edits. A Set: only those ids are taken as-is; anything else that
  // changed is a real local edit not saved yet (e.g. focus time ticking on the linked task)
  // and is stamped as usual. true: take everything as-is (restoring a backup signed out).
  let applying = false;

  const bare = o => { const c = { ...o }; delete c.u; return JSON.stringify(c); };
  const now = () => Date.now();

  function itemsOf(kind) {
    if (kind === 'tasks') return Object.fromEntries(tasks.items.map(t => [t.id, t]));
    if (kind === 'journal') return journal.entries;
    if (kind === 'habits') return habits.items;
    if (kind === 'sleep') return sleepLog.entries;
    return store.days;
  }

  // Called by saveTasks / saveJournal / saveStore just before they write.
  // Stamps changed items with an update time and records deletions.
  function stamp(kind) {
    const items = itemsOf(kind);
    const seen = prev[kind];
    const asIs = id => applying === true || (applying instanceof Set && applying.has(id));
    let local = false;
    for (const [id, item] of Object.entries(items)) {
      const j = bare(item);
      if (seen[id] !== j) {
        seen[id] = j;
        if (!asIs(id)) { item.u = now(); dirty[kind].add(id); if (tomb[kind]) delete tomb[kind][id]; local = true; }
      }
    }
    for (const id of Object.keys(seen)) {
      if (!(id in items)) {
        delete seen[id];
        if (!asIs(id) && tomb[kind]) { tomb[kind][id] = now(); dirty[kind].add(id); local = true; }
      }
    }
    if (!applying || local) { if (kind !== 'days') write(LS.tomb, tomb); schedule(kind === 'days' ? 30000 : 2000); }
  }
  function stampMeta() { if (applying) return; metaU = now(); write(LS.metaU, metaU); dirty.meta = true; schedule(2000); }

  function pruneTombs() {
    const cut = now() - TOMB_MAX_AGE;
    let n = 0;
    for (const kind in tomb) for (const id in tomb[kind]) if (tomb[kind][id] < cut) { delete tomb[kind][id]; n++; }
    if (n) write(LS.tomb, tomb);
  }
  const hasDirty = () => dirty.meta || ['tasks', 'journal', 'days', 'habits', 'sleep'].some(k => dirty[k].size > 0);

  // ---------------------------------------------------------------- restoring a backup
  // Old backups may hold items saved before sync existed (no "u"). Give them their own edit
  // time (or 1) so other devices accept them, without making them look newer than they are.
  function withTimes(data) {
    const lists = [data.tasks && data.tasks.items, data.journal && data.journal.entries,
      data.habits && data.habits.items, data.sleep && data.sleep.entries];
    lists.forEach(l => Object.values(l || {}).forEach(it => {
      if (it && typeof it === 'object' && !it.u) it.u = it.updated || it.created || 1;
    }));
  }

  // Signed in: merge the backup instead of replacing. Items missing here are added; where both
  // have an item the newer "u" (or "updated") wins, and a deletion newer than the backup's copy
  // counts as the newer version. Nothing is deleted or tombstoned, and merged items keep their
  // own times, so an old backup can't override newer changes on other devices.
  // Signed out: replace() swaps the data in quietly (no new times, no tombstones), so if this
  // device signs in later the backup's items only win where they really are newer.
  function restoreBackup(data, replace) {
    withTimes(data);
    if (!user) {
      applying = true;
      try { replace(); } finally { applying = false; }
      return null;
    }
    const ts = o => (o && (o.u || o.updated)) || 0;
    const n = { added: 0, updated: 0, kept: 0 };
    const taskMap = data.tasks && Array.isArray(data.tasks.items)
      ? Object.fromEntries(data.tasks.items.filter(t => t && t.id).map(t => [t.id, t])) : null;
    const plan = [
      ['tasks', taskMap, saveTasks],
      ['journal', data.journal && cleanEntries(data.journal.entries), saveJournal],
      ['habits', data.habits && data.habits.items, saveHabits],
      ['sleep', data.sleep && data.sleep.entries, saveSleep],
      ['days', data.analytics && data.analytics.days, () => saveStore(true)],
    ];
    try {
      for (const [kind, incoming, save] of plan) {
        if (!incoming || typeof incoming !== 'object') continue;
        const items = itemsOf(kind);
        const ids = new Set();
        for (const [id, item] of Object.entries(incoming)) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const local = items[id];
          const mine = local ? ts(local) : (tomb[kind] && tomb[kind][id]) || -1;
          if (ts(item) <= mine) { n.kept++; continue; }
          const copy = { ...item };
          if (kind === 'tasks') {
            const i = tasks.items.findIndex(t => t.id === id);
            if (i >= 0) tasks.items[i] = copy; else tasks.items.push(copy);
          } else if (kind === 'days') store.days[id] = copy;
          else items[id] = copy;
          local ? n.updated++ : n.added++;
          ids.add(id);
          if (tomb[kind]) delete tomb[kind][id];
          // before the first download, queueLocalNewer() does this comparison instead
          if (firstLoaded[kind] && (!(id in remoteU[kind]) || (copy.u || 0) > remoteU[kind][id])) dirty[kind].add(id);
        }
        if (!ids.size) continue;
        applying = ids;
        try { save(); } finally { applying = false; }
      }
    } finally {
      applying = false;
      write(LS.tomb, tomb);
      schedule(2000);
      refreshViews();
    }
    return n;
  }

  function primePrev() {
    ['tasks', 'journal', 'days', 'habits', 'sleep'].forEach(kind => {
      for (const [id, item] of Object.entries(itemsOf(kind))) prev[kind][id] = bare(item);
    });
  }

  // ---------------------------------------------------------------- merged study history
  // Other devices' days, added to this device's day. Identical copies (e.g. the same
  // backup restored on two devices) are counted once.
  function daySignature(d) {
    return Math.round(d.focus || 0) + '|' + (d.sessions || []).map(s => s.start).sort().join(',');
  }
  function mergedDay(k, own) {
    const others = [];
    for (const dev in remoteDays) if (dev !== deviceId && remoteDays[dev][k]) others.push(remoteDays[dev][k]);
    if (!others.length) return own;
    const out = { focus: 0, brk: 0, other: 0, blocks: 0, sessions: [] };
    const sigs = new Set();
    const starts = new Set();
    [own, ...others].forEach(d => {
      if (!d) return;
      const sig = daySignature(d);
      if (sigs.has(sig) && (d.focus || (d.sessions || []).length)) return;
      sigs.add(sig);
      out.focus += d.focus || 0; out.brk += d.brk || 0; out.other += d.other || 0; out.blocks += d.blocks || 0;
      (d.sessions || []).forEach(s => { if (!starts.has(s.start)) { starts.add(s.start); out.sessions.push(s); } });
    });
    out.sessions.sort((a, b) => a.start - b.start);
    return out;
  }
  function allDayKeys() {
    const keys = new Set(Object.keys(store.days));
    for (const dev in remoteDays) if (dev !== deviceId) Object.keys(remoteDays[dev]).forEach(k => keys.add(k));
    return keys;
  }

  // ---------------------------------------------------------------- Firebase
  let fb = null, auth = null, db = null, user = null;
  let sdkPromise = null;
  let unsubs = [];
  let firstLoaded = {};
  let remoteU = { tasks: {}, journal: {}, days: {}, habits: {}, sleep: {} };
  let flushTimer = null, flushing = false;
  let state = 'off', lastSynced = 0, lastError = '';
  let justSignedIn = false;   // show the welcome message only right after pressing Sign in

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.append(s);
    });
  }
  // Firebase is only downloaded when sync is used (keeps the app light and offline-friendly)
  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = (window.firebase ? Promise.resolve() :
        loadScript(FIREBASE_SDK + 'firebase-app-compat.js')
          .then(() => Promise.all([loadScript(FIREBASE_SDK + 'firebase-auth-compat.js'), loadScript(FIREBASE_SDK + 'firebase-firestore-compat.js')])))
        .then(() => {
          fb = window.firebase;
          if (!fb.apps || !fb.apps.length) fb.initializeApp(FIREBASE_CONFIG);
          auth = fb.auth();
          db = fb.firestore();
          auth.onAuthStateChanged(u => (u ? onSignedIn(u) : onSignedOut()));
        })
        .catch(e => { sdkPromise = null; setState('error', navigator.onLine ? 'Could not load sync' : 'Offline'); throw e; });
    }
    return sdkPromise;
  }

  const col = name => db.collection(`users/${user.uid}/${name}`);
  const clean = o => JSON.parse(JSON.stringify(o));   // Firestore rejects undefined values

  async function signIn() {
    try {
      await loadSdk();
      justSignedIn = true;
      const provider = new fb.auth.GoogleAuthProvider();
      try {
        await auth.signInWithPopup(provider);
      } catch (e) {
        // some installed apps block pop-ups: fall back to a full-page sign-in
        if (/popup|operation-not-supported/.test(e.code || '')) await auth.signInWithRedirect(provider);
        else if (!/cancelled|closed-by-user/.test(e.code || '')) throw e;
      }
    } catch (e) {
      toast('Sign-in failed: ' + (e.message || e.code || e));
    }
  }
  async function signOut() {
    await flush();
    await flush();   // the first may only have waited for a batch already in flight
    if (typeof Push !== 'undefined') await Push.forget();   // stop alerts on this device
    write(LS.enabled, false);
    if (auth) await auth.signOut();
  }

  function onSignedIn(u) {
    const last = read(LS.uid, null);
    // (no saved account: first sign-in here, or a device from before this was remembered)
    if (last && last !== u.uid) { askAccountSwitch(u); return; }
    begin(u);
  }
  function begin(u) {
    user = u;
    write(LS.enabled, true);
    write(LS.uid, u.uid);
    firstLoaded = {};
    remoteU = { tasks: {}, journal: {}, days: {}, habits: {}, sleep: {} };
    setState('syncing');
    listen();
    db.collection(`users/${u.uid}/devices`).doc(deviceId).set({ name: deviceName, lastSeen: now() }).catch(() => {});
    if (typeof LiveSync !== 'undefined') LiveSync.onAuth(u, db);   // shared timer sessions
    if (typeof Push !== 'undefined') Push.onAuth(u, db);           // alerts while the app is closed
    if (typeof ClaudeStatus !== 'undefined') ClaudeStatus.onAuth(u, db);   // desk robot: Claude Code status
  }

  // A listener stops for good after an error, so drop them all and subscribe again,
  // waiting longer after each failure (5 s doubling to 5 min), or straight away when back online.
  let retryTimer = null, retryMs = 0, listenFailed = false;
  function listen() {
    clearTimeout(retryTimer); retryTimer = null;
    unsubs.forEach(f => f()); unsubs = [];
    if (!user) return;
    const err = e => {
      if (retryTimer) return;   // several listeners can fail together
      listenFailed = true;
      setState('error', navigator.onLine ? (e.message || String(e)) : 'Offline');
      unsubs.forEach(f => f()); unsubs = [];
      retryMs = Math.min(retryMs ? retryMs * 2 : 5000, 300000);
      retryTimer = setTimeout(listen, retryMs);
    };
    unsubs = ['tasks', 'journal', 'days', 'meta', 'habits', 'sleep'].map(kind => col(kind).onSnapshot(s => onSnap(kind, s), err));
  }

  // Signed in with a different account than the one this device last synced with.
  // Nothing is sent or received until a choice is made, so the accounts never mix by accident.
  let switchDialog = null;
  function askAccountSwitch(u) {
    if (switchDialog) return;
    setState('off');
    const d = switchDialog = el('dialog', 'qa-dialog');
    const done = fn => { d.remove(); switchDialog = null; fn(); };   // remove() also closes it
    d.setAttribute('aria-labelledby', 'acctSwitchTitle');
    const h = el('h3', null, 'Different account');
    h.id = 'acctSwitchTitle';
    d.append(h,
      el('p', 'sync-note', `You signed in as ${u.email || 'a different Google account'}, but this device last synced with another account.`),
      el('p', 'sync-note', 'Merge: this device\'s tasks, journal, habits, sleep and study history are added to this account.'),
      el('p', 'sync-note', 'Replace: they are removed from this device (the other account keeps its own copy in the cloud) and this account\'s data is loaded instead. Use Back up first if something here never synced.'));
    const row = el('div', 'tm-btns');
    const btn = (text, cls, fn) => {
      const b = el('button', cls, text); b.type = 'button';
      b.addEventListener('click', () => done(fn));
      row.append(b);
    };
    const start_ = replace => {
      remoteDays = {}; write(LS.remote, remoteDays);   // the other account's devices
      if (replace) wipeLocal();
      begin(u);
    };
    btn('Merge into this account', 'small', () => start_(false));
    btn('Replace this device\'s data', 'small danger', () => start_(true));
    btn('Sign out', 'small', () => signOut());
    d.append(row);
    d.addEventListener('cancel', e => { e.preventDefault(); done(signOut); });   // Esc = sign out
    document.body.append(d);
    d.showModal();
  }
  // Empty this device's copy (no tombstones: nothing here should be deleted in the cloud)
  let adoptOwnDays = false;
  function wipeLocal() {
    applying = true;
    try {
      tasks.items = []; saveTasks();
      journal.entries = {}; jDirty = false; saveJournal();
      habits.items = {}; saveHabits();
      sleepLog.entries = {}; saveSleep();
      store = { v: 1, days: {} }; liveSession = null; saveStore(true);
    } finally { applying = false; }
    Object.keys(tomb).forEach(k => { tomb[k] = {}; });
    write(LS.tomb, tomb);
    metaU = 0; write(LS.metaU, 0);   // take the account's goal
    ['tasks', 'journal', 'days', 'habits', 'sleep'].forEach(k => dirty[k].clear()); dirty.meta = false;
    adoptOwnDays = true;   // load this device's study history if this account already has some
    refreshViews();
  }

  function onSignedOut() {
    clearTimeout(retryTimer); retryTimer = null;
    unsubs.forEach(f => f());
    unsubs = [];
    user = null;
    if (switchDialog) { switchDialog.remove(); switchDialog = null; }
    if (typeof LiveSync !== 'undefined') LiveSync.onAuth(null, null);
    if (typeof Push !== 'undefined') Push.onAuth(null, null);
    if (typeof ClaudeStatus !== 'undefined') ClaudeStatus.onAuth(null, null);
    setState('off');
  }

  // ---------------------------------------------------------------- receiving changes
  function onSnap(kind, snap) {
    let changed = false;
    const ids = new Set();   // items this snapshot wrote, the only ones stamp() takes as-is
    const cut = now() - TOMB_MAX_AGE;
    retryMs = 0;
    if (listenFailed) { listenFailed = false; setState('synced'); }
    applying = true;
    try {
      snap.docChanges().forEach(ch => {
        const doc = ch.doc;
        if (doc.metadata && doc.metadata.hasPendingWrites) return;   // our own write echoing back
        const data = doc.data() || {};
        if (kind === 'meta') {
          if (doc.id === 'settings' && data.u > metaU && data.goal) {
            metaU = data.u; write(LS.metaU, metaU);
            setFocusGoal(Number(data.goal));
            const gs = document.getElementById('goalSelect'); if (gs) gs.value = String(data.goal);
            changed = true;
          }
          return;
        }
        if (kind === 'days') {
          const [date, dev] = doc.id.split('__');
          if (dev === deviceId) {
            // after "Replace this device's data": take back this device's history in this account
            if (adoptOwnDays && ch.type !== 'removed' && !store.days[date]) {
              const d = { ...data }; delete d.date; delete d.device;
              store.days[date] = d;
              safeSetItem(STORE_KEY, JSON.stringify(store));
              prev.days[date] = bare(d);
              changed = true;
            }
            // this device's own history was cleared from another device
            if (ch.type === 'removed' && store.days[date]) {
              delete store.days[date];
              safeSetItem(STORE_KEY, JSON.stringify(store));
              delete prev.days[date];
              changed = true;
            }
            remoteU.days[date] = data.u || 0;
            return;
          }
          remoteDays[dev] = remoteDays[dev] || {};
          if (ch.type === 'removed') delete remoteDays[dev][date];
          else { const d = { ...data }; delete d.u; delete d.date; delete d.device; remoteDays[dev][date] = d; }
          changed = true;
          return;
        }
        // tasks / journal / habits / sleep
        remoteU[kind][doc.id] = data.u || 0;
        if (ch.type === 'removed') return;
        const old = data.deleted && (data.u || 0) < cut;
        if (old) staleTombs.push(doc.ref);
        const items = itemsOf(kind);
        const local = items[doc.id];
        const localU = local ? (local.u || 0) : (tomb[kind][doc.id] || 0);
        if ((data.u || 0) <= localU) return;
        if (data.deleted) {
          if (local) {
            if (kind === 'tasks') tasks.items = tasks.items.filter(t => t.id !== doc.id);
            else delete items[doc.id];
            ids.add(doc.id);
            changed = true;
          }
          if (!old) tomb[kind][doc.id] = data.u;
        } else {
          const item = { ...data };
          if (kind === 'tasks') {
            const i = tasks.items.findIndex(t => t.id === doc.id);
            if (i >= 0) tasks.items[i] = item; else tasks.items.push(item);
          } else {
            items[doc.id] = item;
          }
          delete tomb[kind][doc.id];
          ids.add(doc.id);
          changed = true;
        }
      });
      if (kind === 'days') adoptOwnDays = false;
      applying = ids;
      if (changed) {
        if (kind === 'tasks') saveTasks();
        if (kind === 'journal') saveJournal();
        if (kind === 'habits') saveHabits();
        if (kind === 'sleep') saveSleep();
        if (kind === 'days') write(LS.remote, remoteDays);
        write(LS.tomb, tomb);
      }
    } finally {
      applying = false;
    }
    if (staleTombs.length) { clearTimeout(pruneTimer); pruneTimer = setTimeout(pruneCloudTombs, 5000); }

    if (!firstLoaded[kind]) {
      firstLoaded[kind] = true;
      queueLocalNewer(kind);
      if (['tasks', 'journal', 'days', 'meta', 'habits', 'sleep'].every(k => firstLoaded[k])) {
        flush().then(() => {
          if (justSignedIn) toast('Sync is on: tasks, journal and history now sync across your devices');
          justSignedIn = false;
        });
      }
    }
    if (changed) refreshViews();
  }

  // Deletion markers older than 90 days are removed from the cloud by whichever device sees them
  let staleTombs = [], pruneTimer = null;
  async function pruneCloudTombs() {
    if (!user) { staleTombs = []; return; }
    const refs = staleTombs.splice(0);
    try {
      for (let i = 0; i < refs.length; i += 400) {
        const b = db.batch();
        refs.slice(i, i + 400).forEach(r => b.delete(r));
        await b.commit();
      }
    } catch (e) {}   // tried again next time they're seen
  }

  // After the first download, upload anything this device has that the cloud doesn't (or is older)
  function queueLocalNewer(kind) {
    if (kind === 'meta') { if (metaU) dirty.meta = true; return; }
    const items = itemsOf(kind);
    for (const [id, item] of Object.entries(items)) {
      if (!(id in remoteU[kind]) || (item.u || 0) > remoteU[kind][id]) dirty[kind].add(id);
    }
    if (tomb[kind]) for (const [id, u] of Object.entries(tomb[kind])) {
      if (id in remoteU[kind] && u > remoteU[kind][id]) dirty[kind].add(id);
    }
  }

  function refreshViews() {
    try {
      if (!$('todayView').hidden) renderDashboard();
      if (!$('tasksView').hidden) renderTasks();
      if (!$('calView').hidden) renderCalendar();
      if (!$('journalView').hidden && !jDirty) renderJournal();
      if (!$('habitsView').hidden) renderHabits();
      if (!$('sleepView').hidden && !$('sleepForm').contains(document.activeElement)) renderSleep();
      renderTimerTask();
      renderProjectLists();
    } catch (e) {}
  }

  // ---------------------------------------------------------------- sending changes
  function schedule(ms) {
    if (!user) return;
    if (flushTimer && ms > 2000) return;   // an earlier flush is already coming
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, ms);
  }

  let inflight = null;   // the batch being sent, so a second flush() can wait for it
  async function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!user) return;
    if (flushing) return inflight;   // it schedules another flush when it ends if more changed meanwhile
    const ops = [];
    dirty.tasks.forEach(id => {
      const t = tasks.items.find(x => x.id === id);
      if (t) ops.push(['set', col('tasks').doc(id), clean(t)]);
      else if (tomb.tasks[id]) ops.push(['set', col('tasks').doc(id), { deleted: true, u: tomb.tasks[id] }]);
    });
    dirty.journal.forEach(id => {
      const e = journal.entries[id];
      if (e) ops.push(['set', col('journal').doc(id), clean(e)]);
      else if (tomb.journal[id]) ops.push(['set', col('journal').doc(id), { deleted: true, u: tomb.journal[id] }]);
    });
    dirty.habits.forEach(id => {
      const h = habits.items[id];
      if (h) ops.push(['set', col('habits').doc(id), clean(h)]);
      else if (tomb.habits[id]) ops.push(['set', col('habits').doc(id), { deleted: true, u: tomb.habits[id] }]);
    });
    dirty.sleep.forEach(id => {
      const e = sleepLog.entries[id];
      if (e) ops.push(['set', col('sleep').doc(id), clean(e)]);
      else if (tomb.sleep[id]) ops.push(['set', col('sleep').doc(id), { deleted: true, u: tomb.sleep[id] }]);
    });
    dirty.days.forEach(date => {
      const d = store.days[date];
      const ref = col('days').doc(`${date}__${deviceId}`);
      if (d) ops.push(['set', ref, { ...clean(d), date, device: deviceId, u: d.u || now() }]);
      else ops.push(['delete', ref]);
    });
    if (dirty.meta) ops.push(['set', col('meta').doc('settings'), { goal: focusGoalMin, u: metaU || now() }]);
    if (!ops.length) { setState('synced'); return; }

    const sent = { tasks: [...dirty.tasks], journal: [...dirty.journal], days: [...dirty.days], habits: [...dirty.habits], sleep: [...dirty.sleep], meta: dirty.meta };
    dirty.tasks.clear(); dirty.journal.clear(); dirty.habits.clear(); dirty.sleep.clear(); dirty.days.clear(); dirty.meta = false;
    flushing = true;
    let ended;
    inflight = new Promise(r => { ended = r; });
    let ok = false;
    setState('syncing');
    try {
      for (let i = 0; i < ops.length; i += 400) {   // Firestore batches hold up to 500 writes
        const b = db.batch();
        ops.slice(i, i + 400).forEach(([op, ref, data]) => (op === 'set' ? b.set(ref, data) : b.delete(ref)));
        await b.commit();
      }
      lastSynced = now();
      ok = true;
      setState('synced');
    } catch (e) {
      // put everything back so it's retried
      sent.tasks.forEach(x => dirty.tasks.add(x)); sent.journal.forEach(x => dirty.journal.add(x));
      sent.days.forEach(x => dirty.days.add(x)); sent.habits.forEach(x => dirty.habits.add(x)); sent.sleep.forEach(x => dirty.sleep.add(x)); if (sent.meta) dirty.meta = true;
      setState('error', navigator.onLine ? (e.message || String(e)) : 'Offline');
      setTimeout(() => schedule(2000), 30000);
    } finally {
      flushing = false;
      inflight = null;
      ended();
    }
    // edits stamped while this batch was in flight had their flush skipped: send them now
    // (after a failure the 30 s retry above covers them)
    if (ok && hasDirty()) schedule(2000);
  }

  // Delete study history for every device (used by "Clear study history")
  async function clearDays() {
    remoteDays = {};
    write(LS.remote, remoteDays);
    dirty.days.clear();
    if (!user) return;
    try {
      const snap = await col('days').get();
      const refs = snap.docs.map(d => d.ref);
      for (let i = 0; i < refs.length; i += 400) {
        const b = db.batch();
        refs.slice(i, i + 400).forEach(r => b.delete(r));
        await b.commit();
      }
    } catch (e) { setState('error', e.message || String(e)); }
  }

  // Delete everything this account has in the cloud, then the sign-in account itself.
  // This device keeps its own copy (Back up / Clear in Settings handle that).
  // ('robot' holds the laptop-written Claude Code status; the rules allow the owner to delete it, for this)
  const CLOUD_KINDS = ['tasks', 'journal', 'habits', 'sleep', 'days', 'meta', 'devices', 'live', 'relay', 'push', 'robot'];
  async function deleteCloudData() {
    if (!user) return;
    if (!confirm('Delete all your Pomegranate data from the cloud and remove your sign-in?\n\n' +
      'Your other devices will stop syncing. What\'s saved on this device stays here (use Back up first if you want a copy). This can\'t be undone.')) return;
    const u = user;
    setState('syncing');
    try {
      clearTimeout(flushTimer); flushTimer = null;
      clearTimeout(retryTimer); retryTimer = null;
      unsubs.forEach(f => f()); unsubs = [];   // stop listening first, so the deletions don't touch this device
      if (typeof Push !== 'undefined') await Push.forget();
      if (typeof ClaudeStatus !== 'undefined') ClaudeStatus.onAuth(null, null);   // stop reading the robot doc
      for (const kind of CLOUD_KINDS) {
        const snap = await db.collection(`users/${u.uid}/${kind}`).get();
        const refs = snap.docs.map(d => d.ref);
        for (let i = 0; i < refs.length; i += 400) {
          const b = db.batch();
          refs.slice(i, i + 400).forEach(r => b.delete(r));
          await b.commit();
        }
      }
      write(LS.enabled, false);
      try { await u.delete(); }
      catch (e) {
        // Google asks you to sign in again before an account can be removed
        if (e.code !== 'auth/requires-recent-login') throw e;
        await u.reauthenticateWithPopup(new fb.auth.GoogleAuthProvider());
        await u.delete();
      }
      toast('Your cloud data and sign-in were deleted');
    } catch (e) {
      setState('error', 'Delete failed: ' + (e.message || e.code || e));
      if (user) onSignedIn(user);   // still signed in: resume syncing
    }
  }

  // ---------------------------------------------------------------- status + menu
  function setState(s, msg) { state = s; lastError = msg || ''; renderSyncPanel(); }

  function renderSyncPanel() {
    const box = document.getElementById('syncPanel');
    const dot = document.getElementById('syncDot');
    if (dot) { dot.className = 'sync-dot ' + (user ? state : 'off'); dot.hidden = !user; }
    if (!box) return;
    box.textContent = '';
    if (!user) {
      box.append(el('p', 'sync-note', 'Sign in to keep your tasks, journal and study history in sync on all your devices.'));
      const b = el('button', 'primary small sync-signin', 'Sign in with Google');
      b.type = 'button';
      b.addEventListener('click', signIn);
      box.append(b);
      const legal = el('p', 'sync-note', 'By signing in you agree to the ');
      const terms = el('a', null, 'Terms'); terms.href = 'terms.html'; terms.target = '_blank'; terms.rel = 'noopener';
      const priv = el('a', null, 'Privacy policy'); priv.href = 'privacy.html'; priv.target = '_blank'; priv.rel = 'noopener';
      legal.append(terms, ' and ', priv, '. Your data is stored with Google Firebase.');
      box.append(legal);
      if (state === 'error' && lastError) box.append(el('p', 'sync-note sync-err', lastError));
      return;
    }
    const who = el('div', 'sync-who');
    who.append(el('b', null, user.email || user.displayName || 'Signed in'));
    box.append(who);
    const status = {
      syncing: 'Syncing…',
      synced: lastSynced ? `✓ Synced ${new Date(lastSynced).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '✓ Up to date',
      error: `⚠ ${lastError || 'Sync problem'} · will retry`,
      off: '',
    }[state] || '';
    box.append(el('p', 'sync-note' + (state === 'error' ? ' sync-err' : ''), status));
    box.append(el('p', 'sync-note', `This device: ${deviceName}`));
    const row = el('div', 'sync-row');
    const now_ = el('button', 'small', 'Sync now'); now_.type = 'button'; now_.addEventListener('click', () => { queueAll(); flush(); });
    const out = el('button', 'small', 'Sign out'); out.type = 'button'; out.addEventListener('click', signOut);
    row.append(now_, out);
    box.append(row);
    box.append(robotIds(user.uid));
    const del = el('button', 'small danger sync-delete', 'Delete my cloud data');
    del.type = 'button';
    del.addEventListener('click', deleteCloudData);
    box.append(del);
  }
  // The values the laptop's Claude Code status script needs in its config.json
  let idsOpen = false;   // the panel redraws on every sync; keep this section open if it was
  function robotIds(uid) {
    const wrap = el('details', 'sync-ids');
    wrap.open = idsOpen;
    wrap.addEventListener('toggle', () => { idsOpen = wrap.open; });
    wrap.append(el('summary', null, 'Desk robot: Claude Code status'));
    wrap.append(el('p', 'sync-note', 'Put these in the laptop script\'s config.json. The app only reads this doc.'));
    [['Project id', FIREBASE_CONFIG.projectId], ['Doc path', `users/${uid}/robot/claude`], ['Your user id', uid]].forEach(([label, value]) => {
      const row = el('div', 'sync-id');
      const code = el('code', null, value);
      const copy = el('button', 'small', 'Copy');
      copy.type = 'button';
      copy.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(value); copy.textContent = 'Copied'; }
        catch (e) {   // clipboard blocked: select the text so Ctrl+C works
          const r = document.createRange(); r.selectNodeContents(code);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          copy.textContent = 'Press Ctrl+C';
        }
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      });
      row.append(el('span', null, label), code, copy);
      wrap.append(row);
    });
    return wrap;
  }
  function queueAll() {
    ['tasks', 'journal', 'days', 'habits', 'sleep'].forEach(k => queueLocalNewer(k));
  }

  // ---------------------------------------------------------------- start
  function start() {
    primePrev();
    pruneTombs();
    renderSyncPanel();
    if (read(LS.enabled, false)) loadSdk().catch(() => {});   // was signed in before
    window.addEventListener('online', () => {
      if (!user) return;
      if (retryTimer) listen();   // listeners failed while offline: don't wait out the backoff
      queueAll(); schedule(1000);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', () => flush());
  }

  return {
    start, stamp, stampMeta, mergedDay, allDayKeys, clearDays, signIn, signOut, flush, deleteCloudData, restoreBackup,
    prefetch: () => loadSdk().catch(() => {}),
    get signedIn() { return !!user; },
    get deviceId() { return deviceId; },
    get deviceName() { return deviceName; },
  };
})();
