// ================================================================= CLOUD SYNC
// Sign in with Google to keep tasks, journal entries, study history and the focus
// goal in sync between devices (Firebase Firestore, free tier).
//
// How it works
// - Everything still lives in this browser first, so the app works offline.
//   The cloud copy is a mirror that each device reads from and writes to.
// - Tasks and journal entries are stored one per cloud document with an update
//   time ("u"). When two devices change the same item, the newer change wins.
//   Deleted items leave a small "deleted" marker so the deletion syncs too.
// - Study history (focus/break time, sessions) is stored per device, so two
//   devices studying on the same day never overwrite each other. The Analytics
//   and Calendar tabs add up all devices.
//
// Cloud layout:  users/{uid}/tasks/{taskId}
//                users/{uid}/journal/{YYYY-MM-DD}
//                users/{uid}/days/{YYYY-MM-DD}__{deviceId}
//                users/{uid}/meta/settings

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
  };
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  // ---------------------------------------------------------------- device identity
  let deviceId = read(LS.device, null);
  if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10); write(LS.device, deviceId); }
  const ua = navigator.userAgent;
  const deviceName = (/iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Computer') +
    ' · ' + (/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser');

  // ---------------------------------------------------------------- change tracking (always on)
  // prev: last known JSON of each item (without its "u"), to notice what changed on save
  const prev = { tasks: {}, journal: {}, days: {} };
  const tomb = read(LS.tomb, { tasks: {}, journal: {} });   // deleted item -> when
  let remoteDays = read(LS.remote, {});                      // deviceId -> { date: day }
  let metaU = read(LS.metaU, 0);
  const dirty = { tasks: new Set(), journal: new Set(), days: new Set(), meta: false };
  let applying = false;     // true while writing changes that came from the cloud

  const bare = o => { const c = { ...o }; delete c.u; return JSON.stringify(c); };
  const now = () => Date.now();

  function itemsOf(kind) {
    if (kind === 'tasks') return Object.fromEntries(tasks.items.map(t => [t.id, t]));
    if (kind === 'journal') return journal.entries;
    return store.days;
  }

  // Called by saveTasks / saveJournal / saveStore just before they write.
  // Stamps changed items with an update time and records deletions.
  function stamp(kind) {
    const items = itemsOf(kind);
    const seen = prev[kind];
    for (const [id, item] of Object.entries(items)) {
      const j = bare(item);
      if (seen[id] !== j) {
        seen[id] = j;
        if (!applying) { item.u = now(); dirty[kind].add(id); if (tomb[kind]) delete tomb[kind][id]; }
      }
    }
    for (const id of Object.keys(seen)) {
      if (!(id in items)) {
        delete seen[id];
        if (!applying && tomb[kind]) { tomb[kind][id] = now(); dirty[kind].add(id); }
      }
    }
    if (!applying) { if (kind !== 'days') write(LS.tomb, tomb); schedule(kind === 'days' ? 30000 : 2000); }
  }
  function stampMeta() { if (applying) return; metaU = now(); write(LS.metaU, metaU); dirty.meta = true; schedule(2000); }

  function primePrev() {
    ['tasks', 'journal', 'days'].forEach(kind => {
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
  let remoteU = { tasks: {}, journal: {}, days: {} };
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
    if (typeof Push !== 'undefined') await Push.forget();   // stop alerts on this device
    write(LS.enabled, false);
    if (auth) await auth.signOut();
  }

  function onSignedIn(u) {
    user = u;
    write(LS.enabled, true);
    firstLoaded = {};
    remoteU = { tasks: {}, journal: {}, days: {} };
    setState('syncing');
    unsubs.forEach(f => f());
    const err = e => { setState('error', e.message || String(e)); };
    unsubs = [
      col('tasks').onSnapshot(s => onSnap('tasks', s), err),
      col('journal').onSnapshot(s => onSnap('journal', s), err),
      col('days').onSnapshot(s => onSnap('days', s), err),
      col('meta').onSnapshot(s => onSnap('meta', s), err),
    ];
    db.collection(`users/${u.uid}/devices`).doc(deviceId).set({ name: deviceName, lastSeen: now() }).catch(() => {});
    if (typeof LiveSync !== 'undefined') LiveSync.onAuth(u, db);   // shared timer sessions
    if (typeof Push !== 'undefined') Push.onAuth(u, db);           // alerts while the app is closed
  }
  function onSignedOut() {
    unsubs.forEach(f => f());
    unsubs = [];
    user = null;
    if (typeof LiveSync !== 'undefined') LiveSync.onAuth(null, null);
    if (typeof Push !== 'undefined') Push.onAuth(null, null);
    setState('off');
  }

  // ---------------------------------------------------------------- receiving changes
  function onSnap(kind, snap) {
    let changed = false;
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
            // this device's own history was cleared from another device
            if (ch.type === 'removed' && store.days[date]) {
              delete store.days[date];
              try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
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
        // tasks / journal
        remoteU[kind][doc.id] = data.u || 0;
        if (ch.type === 'removed') return;
        const items = itemsOf(kind);
        const local = items[doc.id];
        const localU = local ? (local.u || 0) : (tomb[kind][doc.id] || 0);
        if ((data.u || 0) <= localU) return;
        if (data.deleted) {
          if (local) {
            if (kind === 'tasks') tasks.items = tasks.items.filter(t => t.id !== doc.id);
            else delete journal.entries[doc.id];
            changed = true;
          }
          tomb[kind][doc.id] = data.u;
        } else {
          const item = { ...data };
          if (kind === 'tasks') {
            const i = tasks.items.findIndex(t => t.id === doc.id);
            if (i >= 0) tasks.items[i] = item; else tasks.items.push(item);
          } else {
            journal.entries[doc.id] = item;
          }
          delete tomb[kind][doc.id];
          changed = true;
        }
      });
      if (changed) {
        if (kind === 'tasks') saveTasks();
        if (kind === 'journal') saveJournal();
        if (kind === 'days') write(LS.remote, remoteDays);
        write(LS.tomb, tomb);
      }
    } finally {
      applying = false;
    }

    if (!firstLoaded[kind]) {
      firstLoaded[kind] = true;
      queueLocalNewer(kind);
      if (['tasks', 'journal', 'days', 'meta'].every(k => firstLoaded[k])) {
        flush().then(() => {
          if (justSignedIn) toast('Sync is on: tasks, journal and history now sync across your devices');
          justSignedIn = false;
        });
      }
    }
    if (changed) refreshViews();
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
      if (!$('tasksView').hidden) renderTasks();
      if (!$('calView').hidden) renderCalendar();
      if (!$('journalView').hidden && !jDirty) renderJournal();
      if (!$('analyticsView').hidden) renderAnalytics();
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

  async function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!user || flushing) return;
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
    dirty.days.forEach(date => {
      const d = store.days[date];
      const ref = col('days').doc(`${date}__${deviceId}`);
      if (d) ops.push(['set', ref, { ...clean(d), date, device: deviceId, u: d.u || now() }]);
      else ops.push(['delete', ref]);
    });
    if (dirty.meta) ops.push(['set', col('meta').doc('settings'), { goal: focusGoalMin, u: metaU || now() }]);
    if (!ops.length) { setState('synced'); return; }

    const sent = { tasks: [...dirty.tasks], journal: [...dirty.journal], days: [...dirty.days], meta: dirty.meta };
    dirty.tasks.clear(); dirty.journal.clear(); dirty.days.clear(); dirty.meta = false;
    flushing = true;
    setState('syncing');
    try {
      for (let i = 0; i < ops.length; i += 400) {   // Firestore batches hold up to 500 writes
        const b = db.batch();
        ops.slice(i, i + 400).forEach(([op, ref, data]) => (op === 'set' ? b.set(ref, data) : b.delete(ref)));
        await b.commit();
      }
      lastSynced = now();
      setState('synced');
    } catch (e) {
      // put everything back so it's retried
      sent.tasks.forEach(x => dirty.tasks.add(x)); sent.journal.forEach(x => dirty.journal.add(x));
      sent.days.forEach(x => dirty.days.add(x)); if (sent.meta) dirty.meta = true;
      setState('error', navigator.onLine ? (e.message || String(e)) : 'Offline');
      setTimeout(() => schedule(2000), 30000);
    } finally {
      flushing = false;
    }
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
  }
  function queueAll() {
    ['tasks', 'journal', 'days'].forEach(k => queueLocalNewer(k));
  }

  // ---------------------------------------------------------------- start
  function start() {
    primePrev();
    renderSyncPanel();
    if (read(LS.enabled, false)) loadSdk().catch(() => {});   // was signed in before
    window.addEventListener('online', () => { if (user) { queueAll(); schedule(1000); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', () => flush());
  }

  return {
    start, stamp, stampMeta, mergedDay, allDayKeys, clearDays, signIn, signOut, flush,
    prefetch: () => loadSdk().catch(() => {}),
    get signedIn() { return !!user; },
    get deviceId() { return deviceId; },
    get deviceName() { return deviceName; },
  };
})();
