// ================================================================= CLAUDE CODE STATUS -> DESK ROBOT
// Relays Claude Code job status and plan usage from Firestore to the desk robot's OLED.
//
// A script on the laptop (Claude Code hooks + status line, Admin SDK) writes ONE doc:
//   users/{uid}/robot/claude = { jobs: { <key>: { sid, name, project, state, startedAt,
//                                                 finishedAt, updatedAt } },
//                                usage: { fiveHour, fiveHourResetsAt, sevenDay, sevenDayResetsAt, updatedAt } }
// The app only READS it. (The rules let the owner delete it too, for account cleanup in
// sync.js; nothing in this file ever writes or deletes it.)
//
// Board lines (firmware side is finished):
//   CLAUDE JOB <0|1> ? <name>       job running in that slot (no % known: sweeping bar)
//   CLAUDE JOB <0|1> DONE [name]    job finished: DONE! + chime, once per job
//   CLAUDE JOB <0|1> END            slot empty again (no alert)
//   USAGE <week%> <5h%> <weekReset> <5hReset>
//
// Listens only while the desk robot is linked (it has sent EVENT SYNC on this
// connection) AND you're signed in. Lines go through the same 50 ms write queue as the
// task sync and the timer commands.

const ClaudeStatus = (() => {
  const SLOTS = 2;
  const STALE_MS = 3 * 3600e3;      // a "running" job not updated for 3 h is ignored (e.g. interrupted with Esc)
  const LIVE_MS = 2 * 60e3;         // DONE only if it finished less than 2 min ago...
  const MIN_DONE_MS = 20e3;         // ...and took at least 20 s (quick Q&A replies don't chime)
  const TICK_MS = 60e3;             // re-check stale jobs and reset labels once a minute
  const NAME_MAX = 20;

  // ---------------------------------------------------------------- pure helpers (tested in tests.html)
  const pad2 = n => String(n).padStart(2, '0');
  const cleanName = s => String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').trim().slice(0, NAME_MAX).trim() || '-';
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

  // 3:10a / 12:05p
  function clock(d) {
    const h = d.getHours();
    return `${h % 12 || 12}:${pad2(d.getMinutes())}${h < 12 ? 'a' : 'p'}`;
  }
  // kind '5h' -> 3:10a, 'week' -> Fri7:00p; '-' when unknown or already passed. Max 9 chars, no spaces.
  function resetLabel(ms, kind, now = Date.now()) {
    ms = num(ms);
    if (!ms || ms <= now) return '-';
    const d = new Date(ms);
    return kind === 'week' ? d.toLocaleDateString('en-US', { weekday: 'short' }) + clock(d) : clock(d);
  }
  const pct = v => Math.max(0, Math.min(100, Math.round(num(v))));
  function usageLine(usage, now = Date.now()) {
    if (!usage || typeof usage !== 'object') return null;
    return `USAGE ${pct(usage.sevenDay)} ${pct(usage.fiveHour)} ` +
      `${resetLabel(usage.sevenDayResetsAt, 'week', now)} ${resetLabel(usage.fiveHourResetsAt, '5h', now)}`;
  }

  const isRunning = (j, now) => !!j && j.state === 'running' && num(j.updatedAt) > 0 && now - num(j.updatedAt) < STALE_MS;

  // A job that left "running": DONE (with chime) or just END?
  // startedAt may be missing on the done entry, so the time remembered from its running entry is used then.
  function doneDecision(job, now, rememberedStart) {
    if (!job || job.state !== 'done') return 'END';
    const fin = num(job.finishedAt);
    const start = num(job.startedAt) || num(rememberedStart);
    if (!fin || now - fin >= LIVE_MS) return 'END';       // history, not a live event
    if (!start || fin - start < MIN_DONE_MS) return 'END'; // short reply (or length unknown)
    return 'DONE';
  }

  // Slot state, kept across snapshots: which job key holds each slot (sticky), the name
  // last sent for it, and when it started.
  const newState = () => ({ slots: Array(SLOTS).fill(null), sent: Array(SLOTS).fill(null), start: Array(SLOTS).fill(0) });

  // One step: compare the doc's jobs with the slots and return the board lines to send.
  // mode: 'live'    a change seen by this listener (the only mode that can send DONE)
  //       'loading' a change while still loading (cache -> server): only what changed, never DONE
  //       'initial' first load of the doc on this link: send every slot (running or END)
  //       'resync'  board asked again (EVENT SYNC): same, from the current slots
  function step(st, jobs, now, mode) {
    jobs = jobs && typeof jobs === 'object' ? jobs : {};
    const lines = [];

    // 1. slotted jobs that stopped running: finished, disappeared or went stale
    for (let s = 0; s < SLOTS; s++) {
      const k = st.slots[s];
      if (!k) continue;
      const j = jobs[k];
      if (isRunning(j, now)) { if (num(j.startedAt)) st.start[s] = num(j.startedAt); continue; }
      if (mode === 'live' && doneDecision(j, now, st.start[s]) === 'DONE') lines.push(`CLAUDE JOB ${s} DONE ${cleanName(j.name)}`);
      else lines.push(`CLAUDE JOB ${s} END`);
      st.slots[s] = null; st.sent[s] = null; st.start[s] = 0;
    }

    // 2. new running jobs take a free slot, oldest first; with both slots busy they wait
    const waiting = Object.keys(jobs)
      .filter(k => isRunning(jobs[k], now) && !st.slots.includes(k))
      .sort((a, b) => (num(jobs[a].startedAt) || num(jobs[a].updatedAt)) - (num(jobs[b].startedAt) || num(jobs[b].updatedAt)) || (a < b ? -1 : 1));
    for (const k of waiting) {
      const s = st.slots.indexOf(null);
      if (s < 0) break;
      st.slots[s] = k; st.sent[s] = null; st.start[s] = num(jobs[k].startedAt);
    }

    // 3. announce slots: new or renamed jobs; on a (re)load, every slot including empty ones
    const full = mode === 'initial' || mode === 'resync';
    const freed = new Set(lines.map(l => l.split(' ')[2]));   // slots that already got END/DONE above
    for (let s = 0; s < SLOTS; s++) {
      const k = st.slots[s];
      if (k) {
        const name = cleanName(jobs[k].name);
        if (full || st.sent[s] !== name) { lines.push(`CLAUDE JOB ${s} ? ${name}`); st.sent[s] = name; }
      } else if (full && !freed.has(String(s))) {
        lines.push(`CLAUDE JOB ${s} END`);
      }
    }
    return lines;
  }

  // ---------------------------------------------------------------- connection lifecycle
  let write = null;          // writeLine for the connected board
  let linked = false;        // the board has sent EVENT SYNC on this connection
  let user = null, db = null;
  let unsub = null;          // Firestore listener
  let loaded = false;        // a server (not cache) snapshot has been processed on this listener
  let doc = null;            // last doc data (null until the first snapshot)
  let st = newState();
  let lastUsage = '';
  let tickTimer = null;

  function out(lines) { if (write && linked) lines.forEach(l => write(l).catch(() => {})); }
  const say = msg => { if (typeof log === 'function') log(msg); };

  function sendUsage(force) {
    const line = doc && usageLine(doc.usage);
    if (!line || (!force && line === lastUsage)) return;
    lastUsage = line;
    out([line]);
  }

  function onSnap(snap) {
    // A first snapshot from the local cache, and the server one after it, are both "loading":
    // a job that finished while nothing was listening must not chime.
    const mode = loaded ? 'live' : doc ? 'loading' : 'initial';
    if (!snap.metadata || !snap.metadata.fromCache) loaded = true;
    doc = snap.exists ? (snap.data() || {}) : {};
    out(step(st, doc.jobs, Date.now(), mode));
    sendUsage(mode === 'initial');
  }

  function listen() {
    if (unsub || !write || !linked || !user || !db) return;
    loaded = false; doc = null; st = newState(); lastUsage = '';
    unsub = db.doc(`users/${user.uid}/robot/claude`).onSnapshot(onSnap, e => {
      say('! Claude status: ' + (e.message || e.code || e));
      stopListening();
    });
    tickTimer = setInterval(() => {
      if (!doc) return;
      out(step(st, doc.jobs, Date.now(), 'live'));   // jobs going stale -> END
      sendUsage(false);                              // a reset passing turns its label into -
    }, TICK_MS);
  }

  function stopListening() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null;
    clearInterval(tickTimer); tickTimer = null;
    loaded = false; doc = null;
  }

  function attach(writeLine) { detach(); write = writeLine; }

  function detach() {
    stopListening();
    write = null; linked = false;
    st = newState(); lastUsage = '';
  }

  // EVENT SYNC from the board
  function onBoardSync() {
    if (!write) return;
    linked = true;
    if (!unsub) { listen(); return; }        // the first snapshot sends everything
    if (doc) { out(step(st, doc.jobs, Date.now(), 'resync')); sendUsage(true); }
  }

  // signed in or out (sync.js)
  function onAuth(u, d) {
    const same = u && user && u.uid === user.uid;
    user = u; db = d;
    if (same) return;
    if (unsub) {
      stopListening();
      out(st.slots.map((k, s) => (k ? `CLAUDE JOB ${s} END` : null)).filter(Boolean));   // don't leave a job stuck on screen
      st = newState();
    }
    listen();
  }

  return {
    attach, detach, onBoardSync, onAuth,
    // pure helpers (tests.html)
    resetLabel, usageLine, doneDecision, step, newState, cleanName,
    STALE_MS, LIVE_MS, MIN_DONE_MS,
  };
})();
