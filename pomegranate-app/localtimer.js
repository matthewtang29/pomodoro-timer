// ================================================================= BUILT-IN TIMER
// A software copy of the Arduino timer. It understands the same commands
// (START, AUTO, PAUSE, RESUME, EXIT, YES, NO, MUTE, UNMUTE, STATUS) and sends back
// the same STATE / EVENT lines, so the rest of the app (dial, tasks, analytics,
// scores) works exactly the same with or without the physical timer.
//
// It runs whenever no timer is connected. Timing is based on the clock, not on
// counting ticks, so it stays accurate in a background tab, and its state is
// saved so a session survives a page reload (handy on phones).
//
// Shared sessions (livesync.js): when you're signed in, a session started on one
// device is mirrored on your other devices. Every device runs the same state
// (it's all absolute times, so each one counts down on its own clock), any device
// can pause/resume/exit, and only the device that started it ("owner") records
// study time. A session from a connected physical timer is shown the same way;
// its controls are relayed to the computer the timer is plugged into.

const LocalTimer = (() => {
  const SAVE_KEY = 'pomodoro-local-timer';
  const GET_READY_MS = 6000;
  const IN_SESSION = ['GETREADY', 'FOCUS', 'REST', 'PAUSED', 'FOCUS_DONE', 'CHECKPOINT', 'CONTINUE'];

  let s = {
    st: 'MENU', pausedFrom: 'FOCUS', auto: false,
    focus: 25, brk: 5, cycles: 0, cycle: 0, done: 0, total: 0,
    phaseEnd: 0, pausedLeft: 0, screenEnd: 0, sessionStart: 0,
    owner: '', kind: 'local', changed: 0,   // shared-session info (see livesync.js)
  };
  let muted = false;
  let lastEmit = 0, lastSecs = -1, timer = null;

  try { muted = localStorage.getItem('pomodoro-local-muted') === '1'; } catch (e) {}

  const active = () => !port;   // only drives the app when no physical timer is connected
  const inSession = () => IN_SESSION.includes(s.st);
  const myId = () => (typeof Sync !== 'undefined' ? Sync.deviceId : '');
  // a session started on another device: shown and controllable here, but not recorded here
  const remote = () => !!s.owner && !!myId() && s.owner !== myId();
  const CONTROLS = ['PAUSE', 'RESUME', 'EXIT', 'YES', 'NO'];

  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...s, savedAt: Date.now() })); } catch (e) {}
  }
  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(SAVE_KEY));
      // resume a session if it was saved in the last 12 hours
      if (d && IN_SESSION.includes(d.st) && Date.now() - d.savedAt < 12 * 3600e3) { delete d.savedAt; s = { ...s, ...d }; }
    } catch (e) {}
  }

  function stateName() { return s.st === 'PAUSED' ? `PAUSED_${s.pausedFrom}` : s.st; }
  function secsLeft(now) {
    if (s.st === 'PAUSED') return Math.ceil(s.pausedLeft / 1000);
    if (s.st === 'GETREADY') return Math.max(0, Math.floor((s.phaseEnd - now) / 1000));
    if (s.st === 'FOCUS' || s.st === 'REST') return Math.max(0, Math.ceil((s.phaseEnd - now) / 1000));
    return 0;
  }

  function emit(at) {
    if (!active()) return;
    const now = at || Date.now();
    lastEmit = Date.now();
    lastSecs = secsLeft(now);
    handleLine(`STATE state=${stateName()} left=${lastSecs} cycle=${s.cycle} cycles=${s.auto ? 0 : s.cycles} ` +
      `focus=${s.focus} break=${s.brk} done=${s.done} total=${s.total} mode=${s.auto ? 'AUTO' : 'CUSTOM'} ` +
      `muted=${muted ? 1 : 0} src=${remote() ? 'REMOTE' : 'LOCAL'} sstart=${s.sessionStart}`, now);
  }
  // at: when it happened. Events more than 10 s old (the app was asleep or just opened)
  // are skipped, so you don't get a burst of chimes for things that already happened.
  function event(name, at) { if (active() && (!at || Date.now() - at < 10000)) handleLine('EVENT ' + name); }
  function err(code) { handleLine('ERR ' + code); }
  function go(st, at) { s.st = st; save(); emit(at); }

  // Move through every transition that is due. Transition times are chained from
  // the previous one, so a throttled background tab still ends each phase on time.
  function advance(now) {
    for (let guard = 0; guard < 50; guard++) {
      const t = s.st;
      if (t === 'GETREADY' && now >= s.phaseEnd) {
        const at = s.phaseEnd;
        s.phaseEnd = at + s.focus * 60000;
        go('FOCUS', at);
      } else if (t === 'FOCUS' && now >= s.phaseEnd) {
        const at = s.phaseEnd;
        s.done++; s.total += s.focus;
        event('FOCUS_DONE', at);
        if (!s.auto && s.cycle >= s.cycles) { event('SESSION_ENDED', at); s.screenEnd = at + 2000; go('ENDED', at); }
        else { s.screenEnd = at + 2000; go('FOCUS_DONE', at); }
      } else if (t === 'FOCUS_DONE' && now >= s.screenEnd) {
        const at = s.screenEnd;
        s.phaseEnd = at + s.brk * 60000;
        go('REST', at);
      } else if (t === 'REST' && now >= s.phaseEnd) {
        const at = s.phaseEnd;
        event('REST_DONE', at);
        s.screenEnd = at + 1500;
        go('CHECKPOINT', at);
      } else if (t === 'CHECKPOINT' && now >= s.screenEnd) {
        const at = s.screenEnd;
        if (s.auto) go('CONTINUE', at);
        else { s.cycle++; s.phaseEnd = at + GET_READY_MS; go('GETREADY', at); }
      } else if ((t === 'ENDED' || t === 'EXITED') && now >= s.screenEnd) {
        const at = s.screenEnd;
        s.screenEnd = at + 2500;
        go('SUMMARY', at);
      } else if (t === 'SUMMARY' && now >= s.screenEnd) {
        go('MENU', s.screenEnd);
      } else {
        return;
      }
    }
  }

  function start(auto, f, b, c) {
    const now = Date.now();
    s = { ...s, auto, focus: f, brk: b, cycles: auto ? 0 : c, cycle: 1, done: 0, total: 0,
          phaseEnd: now + GET_READY_MS, sessionStart: now, owner: myId(), kind: 'local' };
    go('GETREADY', now);
  }

  function command(line) {
    const cmd = line.trim().toUpperCase();
    const now = Date.now();
    advance(now);
    // a physical timer on another computer: pass the button press on to that computer
    if (s.kind === 'device' && remote() && inSession() && CONTROLS.includes(cmd)) {
      if (typeof LiveSync !== 'undefined') LiveSync.relay(cmd);
      return;
    }
    const before = JSON.stringify(s);
    run(cmd, now);
    // you changed the session (start, pause, exit…): share it with your other devices
    if (JSON.stringify(s) !== before && cmd !== 'STATUS') {
      s.changed = Date.now();
      save();
      if (typeof LiveSync !== 'undefined') LiveSync.publish(s);
    }
  }

  function run(cmd, now) {
    let m;
    if (cmd === 'STATUS') emit(now);
    else if (cmd === 'AUTO') { if (inSession()) err('BUSY'); else start(true, 25, 5, 0); }
    else if ((m = cmd.match(/^START\s+(\d+)\s+(\d+)\s+(\d+)$/))) {
      const [f, b, c] = m.slice(1).map(Number);
      if (inSession()) err('BUSY');
      else if (f < 1 || f > 99 || b < 1 || b > 99 || c < 1 || c > 20) err('RANGE');
      else start(false, f, b, c);
    }
    else if (cmd === 'PAUSE') {
      if (s.st === 'FOCUS' || s.st === 'REST') { s.pausedLeft = Math.max(0, s.phaseEnd - now); s.pausedFrom = s.st; go('PAUSED', now); }
      else err('STATE');
    }
    else if (cmd === 'RESUME') {
      if (s.st === 'PAUSED') { s.phaseEnd = now + s.pausedLeft; go(s.pausedFrom, now); }
      else err('STATE');
    }
    else if (cmd === 'EXIT') {
      if (inSession()) { event('EXITED'); s.screenEnd = now + 1500; go('EXITED', now); }
      else err('STATE');
    }
    else if (cmd === 'YES' || cmd === 'NO') {
      if (s.st !== 'CONTINUE') err('STATE');
      else if (cmd === 'YES') { s.cycle++; s.phaseEnd = now + GET_READY_MS; go('GETREADY', now); }
      else { s.screenEnd = now + 2500; go('SUMMARY', now); }
    }
    else if (cmd === 'MUTE' || cmd === 'UNMUTE') {
      muted = cmd === 'MUTE';
      try { localStorage.setItem('pomodoro-local-muted', muted ? '1' : '0'); } catch (e) {}
      emit(now);
    }
    else err('UNKNOWN');
  }

  // A shared session arrived from another device (or an update to ours). The newest change wins.
  function adopt(shared) {
    const x = shared && shared.s;
    if (!x || port) return;
    const when = x.changed || shared.updated || 0;
    if (when <= (s.changed || 0)) return;
    const wasIn = inSession();
    s = { ...s, ...x, changed: when };
    save();
    // exited from another device: tell analytics, so it's recorded as exited, not completed
    if (wasIn && s.st === 'EXITED') event('EXITED');
    lastSecs = -1;
    advance(Date.now());
    emit();
  }

  function tick() {
    if (!active()) return;
    const now = Date.now();
    advance(now);
    // same rhythm as the Arduino: when the seconds change, plus a heartbeat every second
    if (secsLeft(now) !== lastSecs || now - lastEmit >= 1000) emit(now);
  }

  function startTicking() {
    restore();
    advance(Date.now());
    emit();
    clearInterval(timer);
    timer = setInterval(tick, 250);
    // catch up immediately when the tab/app comes back to the foreground
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  return {
    command,
    start: startTicking,
    announce: () => emit(),
    busy: () => inSession() && !remote(),
    adopt,
    get muted() { return muted; },
  };
})();
