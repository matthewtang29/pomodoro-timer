// ================================================================= ANALYTICS
// Every STATE line (about once a second) adds the time since the previous one
// to today's totals, filed under whatever the timer was doing.
const STORE_KEY = 'pomodoro-analytics-v1';
const CATEGORY = {
  FOCUS: 'focus', REST: 'brk',
  PAUSED_FOCUS: 'other', PAUSED_REST: 'other',
  GETREADY: 'other', FOCUS_DONE: 'other', CHECKPOINT: 'other', CONTINUE: 'other',
};
const MAX_GAP_MS = 5000;   // ignore gaps (sleep, unplugged) longer than this

let store = loadStore();
let tick = null;            // { t, state } of the previous STATE line
let liveSession = null;     // session record being filled in
let sessionExited = false;
let lastSave = 0;

function loadStore() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}
  if (!data || typeof data.days !== 'object') data = { v: 1, days: {} };
  // A session still marked running means the page closed mid-session
  Object.values(data.days).forEach(d => (d.sessions || []).forEach(x => {
    if (x.outcome === 'running') x.outcome = 'interrupted';
  }));
  return data;
}
function saveStore(force) {
  const now = Date.now();
  if (!force && now - lastSave < 10000) return;
  lastSave = now;
  if (typeof Sync !== 'undefined') Sync.stamp('days');
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
}
window.addEventListener('pagehide', () => saveStore(true));

function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function keyToDate(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftKey(k, days) { const d = keyToDate(k); d.setDate(d.getDate() + days); return dayKey(d); }
function emptyDay() { return { focus: 0, brk: 0, other: 0, blocks: 0, sessions: [] }; }
function getDay(k) { return store.days[k] || (store.days[k] = emptyDay()); }
// Read-only view of a day: this device's time plus other synced devices'
function peekDay(k) {
  const own = store.days[k];
  const merged = typeof Sync !== 'undefined' ? Sync.mergedDay(k, own) : own;
  return merged || emptyDay();
}
function deskOf(d) { return d.focus + d.brk + d.other; }

// at: when the state actually changed (the built-in timer passes exact times so
// a throttled background tab still records the right amount of time)
function trackState(prev, next, at) {
  // a session shared from another device: that device records it, not this one
  if (next.src === 'REMOTE') {
    if (liveSession) finishSession('exited');
    tick = null;
    return;
  }
  const now = at || Date.now();
  const local = next.src === 'LOCAL';
  // gaps longer than this are ignored (unplugged, laptop asleep). The built-in timer
  // can be throttled to one update a minute in a background tab, so it gets more room.
  const maxGap = local ? 70000 : MAX_GAP_MS;
  if (tick && CATEGORY[tick.state]) {
    const secs = Math.max(0, Math.min(now - tick.t, maxGap)) / 1000;
    const cat = CATEGORY[tick.state];
    getDay(dayKey(now))[cat] += secs;
    if (liveSession) {
      liveSession.desk += secs;
      if (cat === 'focus') liveSession.focus += secs;
    }
    if (cat === 'focus' && typeof onFocusTick === 'function') onFocusTick(secs);   // credit the linked task
  }
  tick = { t: now, state: next.state };

  const wasIn = prev != null && prev in CATEGORY;
  const isIn = next.state in CATEGORY;
  if (!wasIn && isIn) {
    sessionExited = false;
    // a built-in timer session that survived a page reload continues its old record
    const resumed = local && next.sstart ? findSession(next.sstart) : null;
    if (resumed) {
      liveSession = resumed;
      liveSession.outcome = 'running';
      liveSession.end = null;
    } else {
      liveSession = {
        start: local && next.sstart ? next.sstart : now, end: null, mode: next.mode,
        focusMin: next.focus, breakMin: next.break, cycles: next.cycles,
        focus: 0, desk: 0, blocks: 0, outcome: 'running', source: local ? 'built-in' : 'timer',
        work: {}, diffs: {}, tasksDone: [],   // focus seconds per task, task difficulty, tasks checked off
      };
      getDay(dayKey(liveSession.start)).sessions.push(liveSession);
    }
    saveStore(true);
  } else if (wasIn && !isIn) {
    finishSession(sessionExited ? 'exited' : 'completed');
  }
  saveStore(false);

}

function findSession(start) {
  const day = store.days[dayKey(start)];
  return day ? (day.sessions || []).find(x => x.start === start) || null : null;
}

function trackEvent(name) {
  if (status && status.src === 'REMOTE') return;   // recorded by the device that started it
  if (name === 'FOCUS_DONE') {
    getDay(dayKey(Date.now())).blocks++;
    if (liveSession) liveSession.blocks++;
  }
  if (name === 'EXITED') sessionExited = true;
  saveStore(true);
}

function trackDisconnect() {
  if (liveSession) finishSession('disconnected');
  tick = null;
  saveStore(true);
}

function finishSession(outcome) {
  if (!liveSession) return;
  liveSession.end = Date.now();
  liveSession.outcome = outcome;
  liveSession = null;
  saveStore(true);
}

// ---------------------------------------------------------------- formatting
function fmtSecs(sec) {
  const mins = Math.round(sec / 60);
  if (sec > 0 && mins === 0) return '<1m';
  return fmtDuration(mins);
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(k, today) {
  if (k === today) return 'Today';
  if (k === shiftKey(today, -1)) return 'Yesterday';
  const d = keyToDate(k);
  return `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}`;
}
function fmtClockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderSessions(T, list, emptyText) {
  list.textContent = '';
  const sessions = (T.sessions || []).slice().reverse();
  if (!sessions.length) {
    list.append(el('li', 'empty-msg', emptyText));
    return;
  }
  const OUT = {
    running: ['● In progress', 'live'], completed: ['✓ Completed', 'ok'],
    exited: ['✕ Exited early', ''], disconnected: ['⚠ Disconnected', ''], interrupted: ['⚠ Page closed', ''],
  };
  sessions.forEach(x => {
    const li = el('li');
    const plan = x.mode === 'AUTO' ? 'Auto 25/5'
      : `${x.focusMin}/${x.breakMin} × ${x.cycles}`;
    const end = x.end ? ` – ${fmtClockTime(x.end)}` : '';
    const [label, cls] = OUT[x.outcome] || [x.outcome, ''];
    const planEl = el('span', 's-plan', `${plan}${x.source === 'built-in' ? ' · built-in timer' : ''} · ${fmtSecs(x.desk)} at desk${end}`);
    const names = Object.keys(x.work || {})
      .sort((a, b) => x.work[b] - x.work[a])
      .map(id => (typeof taskById === 'function' && taskById(id)) ? taskById(id).title : null)
      .filter(Boolean);
    if (names.length) planEl.append(el('span', 's-task', 'On: ' + names.join(', ')));
    li.append(
      el('span', 's-time', fmtClockTime(x.start)),
      planEl,
      el('span', 's-focus', `${fmtSecs(x.focus)} focus`),
    );
    const sc = sessionScore(x);
    if (sc) {
      const b = scoreBadge(sc.score);
      b.title = `Session score ${sc.score}: completion ${Math.round(sc.completion * 100)}%, efficiency ${Math.round(sc.efficiency * 100)}%, intensity ${sc.avgDiff.toFixed(1)}/5`;
      li.append(b);
    }
    li.append(el('span', 'badge ' + cls, label));
    list.append(li);
  });
}

// ---------------------------------------------------------------- goal, export, backup (in Settings)
$('goalSelect').value = String(focusGoalMin);
if ($('goalSelect').value !== String(focusGoalMin)) {   // a custom goal not in the list
  $('goalSelect').append(new Option(fmtDuration(focusGoalMin), String(focusGoalMin), true, true));
}
$('goalSelect').addEventListener('change', () => {
  setFocusGoal(Number($('goalSelect').value));
  refreshView();
});

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('exportBtn').addEventListener('click', () => {
  const rows = [['date', 'score', 'day_rating', 'day_rating_high', 'desk_minutes', 'focus_minutes', 'break_minutes', 'paused_other_minutes', 'focus_blocks', 'sessions', 'tasks_done', 'sleep_hours']];
  const keys = typeof Sync !== 'undefined' ? Sync.allDayKeys() : new Set(Object.keys(store.days));
  (typeof tasks !== 'undefined' ? tasks.items : []).forEach(t => { if (t.done) keys.add(dayKey(t.done)); });
  if (typeof journal !== 'undefined') Object.keys(journal.entries).forEach(k => keys.add(k));
  if (typeof sleepLog !== 'undefined') Object.keys(sleepLog.entries).forEach(k => keys.add(k));
  [...keys].sort().forEach(k => {
    const d = peekDay(k);
    const m = v => (v / 60).toFixed(1);
    const sc = dayScore(k);
    const je = typeof journalEntry === 'function' ? journalEntry(k) : null;
    const sl = typeof sleepEntry === 'function' ? sleepEntry(k) : null;
    rows.push([k, sc ? sc.score : '', je ? ratingLo(je) : '', je ? ratingHi(je) : '', m(deskOf(d)), m(d.focus), m(d.brk), m(d.other), d.blocks,
      (d.sessions || []).length, taskStatsForDay(k).doneCount, sl ? (sleepMinutes(sl) / 60).toFixed(2) : '']);
  });
  download(`pomodoro-history-${dayKey(Date.now())}.csv`, rows.map(r => r.join(',')).join('\n'), 'text/csv');
});

$('backupBtn').addEventListener('click', () => {
  saveStore(true);
  const data = { app: 'pomodoro', version: 1, exported: new Date().toISOString(),
    analytics: store, tasks: typeof tasks !== 'undefined' ? tasks : null,
    journal: typeof journal !== 'undefined' ? journal : null,
    habits: typeof habits !== 'undefined' ? habits : null,
    sleep: typeof sleepLog !== 'undefined' ? sleepLog : null, goal: focusGoalMin };
  download(`pomodoro-backup-${dayKey(Date.now())}.json`, JSON.stringify(data), 'application/json');
});
$('restoreBtn').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async () => {
  const file = $('restoreFile').files[0];
  $('restoreFile').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'pomodoro' || !data.analytics || typeof data.analytics.days !== 'object') throw new Error('not a backup');
    store = data.analytics;
    saveStore(true);
    if (data.tasks && Array.isArray(data.tasks.items) && typeof restoreTasks === 'function') restoreTasks(data.tasks);
    if (data.journal && data.journal.entries && typeof restoreJournal === 'function') restoreJournal(data.journal);
    if (data.habits && data.habits.items && typeof restoreHabits === 'function') restoreHabits(data.habits);
    if (data.sleep && data.sleep.entries && typeof restoreSleep === 'function') restoreSleep(data.sleep);
    if (data.goal) { setFocusGoal(Number(data.goal)); $('goalSelect').value = String(data.goal); }
    refreshView();
    toast('Backup restored');
  } catch (e) {
    toast("That file isn't a Pomegranate backup");
  }
});

let clearArmed = null;
$('clearBtn').addEventListener('click', () => {
  const btn = $('clearBtn');
  if (!clearArmed) {
    btn.textContent = 'Click again to delete study history';
    clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = 'Clear study history'; }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = 'Clear study history';
  store = { v: 1, days: {} };
  liveSession = null;
  saveStore(true);
  if (typeof Sync !== 'undefined') Sync.clearDays();   // also from other synced devices
  refreshView();
  toast('Study history cleared (tasks kept)');
});
