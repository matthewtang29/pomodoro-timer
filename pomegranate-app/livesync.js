// ================================================================= SHARED TIMER
// Start a session on one device and it shows up on your other signed-in devices.
//
// The session lives in one cloud document, users/{uid}/live/timer, holding the
// built-in timer's state. Every time is absolute (when this phase ends, etc.), so
// each device counts down on its own clock and they stay in step without
// constant updates. A device only writes when you change something (start,
// pause, resume, exit, continue); the newest change wins.
//
// Physical timer: the computer it's plugged into writes the timer's state on
// every change, and other devices show it. Pause/exit pressed on another device
// is passed to that computer through users/{uid}/relay/cmd.
//
// The cloud function in cloud/functions also watches this document to send
// "focus done" / "break over" notifications to your devices (see push.js).

const LiveSync = (() => {
  const IN_SESSION = ['GETREADY', 'FOCUS', 'REST', 'PAUSED_FOCUS', 'PAUSED_REST', 'FOCUS_DONE', 'CHECKPOINT', 'CONTINUE'];
  const STALE_MS = 12 * 3600e3;   // ignore sessions older than this
  let db = null, user = null, unsubs = [];
  let physicalKey = '', physicalIn = false;
  const handled = new Set();      // relayed commands already carried out

  const timerDoc = () => db.doc(`users/${user.uid}/live/timer`);
  const relayDoc = () => db.doc(`users/${user.uid}/relay/cmd`);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clean = o => JSON.parse(JSON.stringify(o));

  // ---------------------------------------------------------------- listen
  function onAuth(u, d) {
    unsubs.forEach(f => f());
    unsubs = [];
    user = u; db = d;
    if (!u) return;

    unsubs.push(timerDoc().onSnapshot(snap => {
      if (!snap.exists || snap.metadata.hasPendingWrites) return;   // nothing yet, or our own write
      const data = snap.data();
      if (!data || !data.s || Date.now() - (data.updated || 0) > STALE_MS) return;
      if (port) return;   // a physical timer is plugged in here: it's in charge on this device
      LocalTimer.adopt(data);
    }, () => {}));

    unsubs.push(relayDoc().onSnapshot(snap => {
      if (!snap.exists || snap.metadata.hasPendingWrites) return;
      const r = snap.data();
      // only the computer the physical timer is plugged into acts on these
      if (!port || !r || !r.id || handled.has(r.id) || r.by === Sync.deviceId) return;
      handled.add(r.id);
      if (Math.abs(Date.now() - (r.at || 0)) > 20000) return;   // old request
      send(r.cmd);
    }, () => {}));
  }

  // ---------------------------------------------------------------- share
  function write(s) {
    if (!user || !db) return;
    timerDoc().set({
      s: clean(s), rev: newId(), by: Sync.deviceId, byName: Sync.deviceName,
      updated: s.changed || Date.now(),
    }).catch(() => {});
  }

  // built-in timer: called after you start / pause / resume / exit / continue
  function publish(s) { write(s); }

  // physical timer plugged in here: share its state whenever it changes
  function physical(st) {
    if (!user) return;
    const inSession = IN_SESSION.includes(st.state);
    if (!inSession && !physicalIn) return;   // idle at the menu: nothing to share
    physicalIn = inSession;
    const key = [st.state, st.cycle, st.cycles, st.done, st.focus, st.break, st.mode].join('|');
    if (key === physicalKey) return;
    physicalKey = key;

    const now = Date.now(), left = (st.left || 0) * 1000;
    const s = {
      kind: 'device', owner: Sync.deviceId, changed: now,
      auto: st.mode === 'AUTO', focus: st.focus, brk: st.break, cycles: st.cycles || 0,
      cycle: st.cycle, done: st.done, total: st.total, sessionStart: st.sstart || now,
      st: st.state, pausedFrom: 'FOCUS', phaseEnd: 0, pausedLeft: 0, screenEnd: now + 2000,
    };
    if (st.state.startsWith('PAUSED_')) { s.st = 'PAUSED'; s.pausedFrom = st.state.slice(7); s.pausedLeft = left; }
    else if (['GETREADY', 'FOCUS', 'REST'].includes(st.state)) s.phaseEnd = now + left;
    else if (st.state === 'CHECKPOINT') s.screenEnd = now + 1500;
    else if (st.state === 'SUMMARY') s.screenEnd = now + 2500;
    write(s);
  }

  // the physical timer was unplugged mid-session: end it on the other devices
  function physicalGone() {
    if (!physicalIn) return;
    physicalIn = false;
    physicalKey = '';
    const now = Date.now();
    write({ kind: 'device', owner: Sync.deviceId, changed: now, st: 'EXITED', screenEnd: now + 1500 });
  }

  // pause / resume / exit pressed here for a physical timer on another computer
  function relay(cmd) {
    if (!user || !db) { toast('Sign in to control a timer on another device'); return; }
    relayDoc().set({ cmd, id: newId(), by: Sync.deviceId, at: Date.now() }).catch(() => toast("Couldn't reach your other device"));
    toast(`Sent “${cmd.toLowerCase()}” to your timer`);
  }

  return { onAuth, publish, physical, physicalGone, relay };
})();
