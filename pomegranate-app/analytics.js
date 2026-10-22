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
let lastStatsRender = 0;
let range = 14;

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

  if (!$('analyticsView').hidden && now - lastStatsRender > 3000) renderAnalytics();
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
  if (!$('analyticsView').hidden) renderAnalytics();
}

// ---------------------------------------------------------------- formatting
function fmtSecs(sec) {
  const mins = Math.round(sec / 60);
  if (sec > 0 && mins === 0) return '<1m';
  return fmtDuration(mins);
}
function deltaInfo(cur, prev, isCount, goodUp = true) {
  const diff = cur - prev;
  const small = isCount ? diff === 0 : Math.abs(diff) < 60;
  if (small) return { cls: 'delta-flat', text: '= yesterday', vs: '' };
  const txt = isCount ? String(Math.abs(diff)) : fmtSecs(Math.abs(diff));
  const up = diff > 0;
  const cls = !goodUp ? 'delta-flat' : up ? 'delta-up' : 'delta-down';
  return { cls, text: `${up ? '▲ +' : '▼ −'}${txt}`, vs: ' vs yesterday' };
}
function fmtAxis(min) {
  if (min === 0) return '0';
  if (min < 60) return `${min}m`;
  const h = min / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + 'h';
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

// ---------------------------------------------------------------- render
function renderAnalytics() {
  lastStatsRender = Date.now();
  const today = dayKey(Date.now());
  const yest = shiftKey(today, -1);
  const T = peekDay(today), Y = peekDay(yest);

  $('todayLabel').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  renderScoreCard(today);

  // 7-day averages over days you actually studied (excluding today)
  const prior = [];
  for (let i = 1; i <= 7; i++) { const d = peekDay(shiftKey(today, -i)); if (deskOf(d) >= 60) prior.push(d); }
  const avg = f => prior.length ? prior.reduce((a, d) => a + f(d), 0) / prior.length : null;

  const tiles = [
    { label: 'Desk time', key: null, cur: deskOf(T), prev: deskOf(Y), avg: avg(deskOf) },
    { label: 'Focused', key: 'var(--s1)', cur: T.focus, prev: Y.focus, avg: avg(d => d.focus) },
    { label: 'Break', key: 'var(--s2)', cur: T.brk, prev: Y.brk, avg: avg(d => d.brk), neutral: true },
    { label: 'Focus blocks', key: null, cur: T.blocks, prev: Y.blocks, avg: avg(d => d.blocks), count: true },
  ];
  const box = $('tiles');
  box.textContent = '';
  tiles.forEach(t => {
    const tile = el('div', 'tile');
    const label = el('div', 't-label');
    if (t.key) { const k = el('i', 't-key'); k.style.background = t.key; label.append(k); }
    label.append(t.label);
    const value = el('div', 't-value', t.count ? String(t.cur) : fmtSecs(t.cur));
    const d = deltaInfo(t.cur, t.prev, t.count, !t.neutral);
    const delta = el('div', 't-delta ' + d.cls, d.text);
    if (d.vs) delta.append(el('span', null, d.vs));
    const sub = el('div', 't-sub', t.avg == null ? 'No earlier days yet'
      : `7-day avg ${t.count ? (Math.round(t.avg * 10) / 10) : fmtSecs(t.avg)}`);
    tile.append(label, value, delta, sub);
    box.append(tile);
  });

  // focus rate + streak
  const desk = deskOf(T);
  let streak = 0;
  let k = T.focus >= 60 ? today : yest;
  while (peekDay(k).focus >= 60) { streak++; k = shiftKey(k, -1); }
  const line = $('summaryLine');
  line.textContent = '';
  if (desk >= 60) {
    line.append('Focused for ', el('b', null, Math.round(T.focus / desk * 100) + '%'), ' of your desk time today · ');
  }
  line.append('Streak: ', el('b', null, streak === 1 ? '1 day' : `${streak} days`), ' with focus time');

  renderSessions(T, $('sessionList'), 'No sessions yet today. Sessions you run while connected will show up here.');
  renderWeek(today);
  renderChart(today);
  renderTable(today);
}

function renderScoreCard(today) {
  const r = dayScore(today);
  const y = dayScore(shiftKey(today, -1));
  $('scoreValue').textContent = r ? r.score : '—';
  const delta = $('scoreDelta');
  delta.textContent = '';
  delta.className = 't-delta';
  if (r && y) {
    const diff = r.score - y.score;
    delta.classList.add(diff > 0 ? 'delta-up' : diff < 0 ? 'delta-down' : 'delta-flat');
    delta.append(diff === 0 ? '= yesterday' : `${diff > 0 ? '▲ +' : '▼ −'}${Math.abs(diff)}`);
    if (diff !== 0) delta.append(el('span', null, ' vs yesterday'));
  } else if (!r) {
    delta.classList.add('delta-flat');
    delta.textContent = 'Focus or add tasks due today to get a score';
  }
  const past = [];
  for (let i = 1; i <= 7; i++) { const x = dayScore(shiftKey(today, -i)); if (x) past.push(x.score); }
  $('scoreAvg').textContent = past.length ? `7-day avg ${Math.round(past.reduce((a, b) => a + b, 0) / past.length)}` : '';
  renderScoreParts($('scoreParts'), r || { parts: [
    { label: 'Focus time', value: null, detail: `goal ${fmtDuration(focusGoalMin)}` },
    { label: 'Tasks done', value: null, detail: 'No tasks due' },
    { label: 'Session quality', value: null, detail: 'No sessions' },
  ] });
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

function renderWeek(today) {
  // Monday-to-today this week vs the same weekdays last week (a fair comparison mid-week)
  const d = keyToDate(today);
  const since = (d.getDay() + 6) % 7;   // days since Monday
  const sum = (offset) => {
    const r = { focus: 0, desk: 0, blocks: 0 };
    for (let i = 0; i <= since; i++) {
      const x = peekDay(shiftKey(today, -i - offset));
      r.focus += x.focus; r.desk += deskOf(x); r.blocks += x.blocks;
    }
    return r;
  };
  const cur = sum(0), prev = sum(7);
  $('weekTitle').textContent = since === 0 ? 'Today vs last Monday'
    : `This week vs last week (Mon–${WD[d.getDay()]})`;
  const grid = $('weekGrid');
  grid.textContent = '';
  [['Focused', cur.focus, prev.focus, false], ['Desk time', cur.desk, prev.desk, false], ['Focus blocks', cur.blocks, prev.blocks, true]]
    .forEach(([label, c, p, count]) => {
      const cell = el('div');
      let change = '';
      if (p > 0) {
        const pct = Math.round((c - p) / p * 100);
        change = pct === 0 ? 'no change' : `${pct > 0 ? '▲ +' : '▼ −'}${Math.abs(pct)}%`;
      } else if (c > 0) change = 'new';
      const cls = change.startsWith('▲') ? 'delta-up' : change.startsWith('▼') ? 'delta-down' : 'delta-flat';
      cell.append(
        el('div', 'w-label', label),
        el('div', 'w-value', count ? String(c) : fmtSecs(c)),
        el('div', 'w-prev', `last week ${count ? p : fmtSecs(p)}`),
      );
      if (change) cell.append(el('div', 't-delta ' + cls, change));
      grid.append(cell);
    });
}

function rangeDays(today) {
  const days = [];
  for (let i = range - 1; i >= 0; i--) {
    const k = shiftKey(today, -i);
    days.push({ k, d: peekDay(k) });
  }
  return days;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const a in attrs) e.setAttribute(a, attrs[a]);
  if (text != null) e.textContent = text;
  return e;
}
function topRoundedRect(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderChart(today) {
  const wrap = $('chart');
  const tip = $('tip');
  wrap.querySelectorAll('svg').forEach(n => n.remove());
  const W = Math.max(280, wrap.clientWidth || 560), H = 220;
  const M = { top: 22, right: 4, bottom: 26, left: 38 };
  const pw = W - M.left - M.right, ph = H - M.top - M.bottom;
  const days = rangeDays(today);
  const series = [['focus', 'var(--s1)', 'Focus'], ['brk', 'var(--s2)', 'Break'], ['other', 'var(--s3)', 'Paused & other']];

  const maxMin = Math.max(30, ...days.map(x => deskOf(x.d) / 60));
  const step = [5, 10, 15, 30, 60, 120, 180, 240, 360].find(s => maxMin / s <= 4) || 480;
  const yMax = Math.ceil(maxMin / step) * step;
  const y = min => M.top + ph - (min / yMax) * ph;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img',
    'aria-label': `Stacked columns of desk time per day for the last ${range} days. The same numbers are in the table below.` });

  for (let v = 0; v <= yMax; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    root.append(svg('line', { x1: M.left, x2: W - M.right, y1: yy, y2: yy, class: v === 0 ? 'baseline' : 'gridline' }));
    root.append(svg('text', { x: M.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, fmtAxis(v)));
  }

  const band = pw / days.length;
  const bw = Math.max(4, Math.min(24, band * 0.62));
  const labelEvery = days.length <= 7 ? 1 : days.length <= 14 ? 2 : 5;
  const bars = [];

  days.forEach((x, i) => {
    const cx = M.left + band * i + band / 2;
    const g = svg('g', { class: 'bar' });
    // stack bottom-up with a 2px surface gap between segments
    const segs = series.map(([key, color]) => ({ h: (x.d[key] / 60) / yMax * ph, color })).filter(s => s.h >= 0.5);
    let base = M.top + ph;
    segs.forEach((s, j) => {
      const isTop = j === segs.length - 1;
      const h = isTop ? s.h : Math.max(0, s.h - 2);
      const top = base - h;
      if (h > 0) {
        if (isTop) g.append(svg('path', { d: topRoundedRect(cx - bw / 2, top, bw, h, 4), fill: s.color }));
        else g.append(svg('rect', { x: cx - bw / 2, y: top, width: bw, height: h, fill: s.color }));
      }
      base -= s.h;
    });
    root.append(g);
    bars.push(g);

    // x labels (always include today, count back from it)
    if ((days.length - 1 - i) % labelEvery === 0) {
      const d = keyToDate(x.k);
      const isToday = x.k === today;
      const txt = isToday ? 'Today' : days.length <= 7 ? WD[d.getDay()] : `${MO[d.getMonth()]} ${d.getDate()}`;
      const nearEdge = i === days.length - 1 && band < 44;   // keep "Today" inside the chart
      root.append(svg('text', { x: nearEdge ? W - M.right : cx, y: H - 6, 'text-anchor': nearEdge ? 'end' : 'middle',
        class: 'xlabel' + (isToday ? ' today' : '') }, txt));
    }
  });

  // one selective direct label: today's total on its cap
  const t = days[days.length - 1];
  const tDesk = deskOf(t.d);
  if (tDesk >= 60) {
    const cx = M.left + band * (days.length - 1) + band / 2;
    const edge = cx + 26 > W - M.right;
    root.append(svg('text', { x: edge ? W - M.right : cx, y: y(tDesk / 60) - 6, 'text-anchor': edge ? 'end' : 'middle', class: 'vlabel' }, fmtSecs(tDesk)));
  }

  if (days.every(x => deskOf(x.d) < 1)) {
    root.append(svg('text', { x: M.left + pw / 2, y: M.top + ph / 2, 'text-anchor': 'middle', class: 'empty' },
      'No study time recorded in this range yet'));
  }

  // hover / focus targets: the whole day band, not just the painted bar
  days.forEach((x, i) => {
    const hit = svg('rect', { x: M.left + band * i, y: M.top, width: band, height: ph, class: 'hit', tabindex: 0,
      'aria-label': `${fmtDay(x.k, today)}: ${fmtSecs(deskOf(x.d))} at desk, ${fmtSecs(x.d.focus)} focus` });
    const show = () => {
      wrap.classList.add('hovering');
      bars.forEach((b, j) => b.classList.toggle('hot', j === i));
      tip.textContent = '';
      tip.append(el('div', 'tip-day', fmtDay(x.k, today)));
      if (deskOf(x.d) < 1) tip.append(el('div', 'tip-row', 'No study time'));
      else series.forEach(([key, color, name]) => {
        const row = el('div', 'tip-row');
        const k = el('i'); k.style.background = color;
        row.append(k, el('b', null, fmtSecs(x.d[key])), el('span', null, name));
        tip.append(row);
      });
      if (deskOf(x.d) >= 1) {
        const tot = el('div', 'tip-row tip-total');
        tot.append(el('i'), el('b', null, fmtSecs(deskOf(x.d))), el('span', null, 'desk time'));
        tip.append(tot);
      }
      tip.classList.add('show');
      const cx = M.left + band * i + band / 2;
      const scale = wrap.clientWidth / W;
      let left = cx * scale + 12;
      if (left + tip.offsetWidth > wrap.clientWidth) left = cx * scale - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = (M.top * scale) + 'px';
    };
    const hide = () => { wrap.classList.remove('hovering'); tip.classList.remove('show'); };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    root.append(hit);
  });

  wrap.prepend(root);

  // note: average over studied days in range
  const studied = days.filter(x => x.d.focus >= 60);
  $('chartNote').textContent = studied.length
    ? `Studied on ${studied.length} of the last ${range} days · average ${fmtSecs(studied.reduce((a, x) => a + x.d.focus, 0) / studied.length)} of focus on those days`
    : '';
}

function renderTable(today) {
  const body = $('histBody');
  body.textContent = '';
  const rows = rangeDays(today).filter(x => deskOf(x.d) >= 1 || dayScore(x.k)).reverse();
  $('histEmpty').hidden = rows.length > 0;
  rows.forEach(({ k, d }) => {
    const tr = el('tr');
    const desk = deskOf(d);
    const sc = dayScore(k);
    [[fmtDay(k, today)], [sc ? String(sc.score) : '—'], [fmtSecs(desk)], [fmtSecs(d.focus)], [fmtSecs(d.brk)], [fmtSecs(d.other), 'opt'], [String(d.blocks)],
     [desk >= 60 ? Math.round(d.focus / desk * 100) + '%' : '—', 'opt']]
      .forEach(([v, cls]) => tr.append(el('td', cls, v)));
    body.append(tr);
  });
}


// ---------------------------------------------------------------- range, goal, export, backup
document.querySelectorAll('[data-range]').forEach(btn => btn.addEventListener('click', () => {
  range = Number(btn.dataset.range);
  document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  try { localStorage.setItem('pomodoro-range', range); } catch (e) {}
  renderAnalytics();
}));
try {
  const r = Number(localStorage.getItem('pomodoro-range'));
  if ([7, 14, 30].includes(r)) {
    range = r;
    document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === r)));
  }
} catch (e) {}

$('goalSelect').value = String(focusGoalMin);
if ($('goalSelect').value !== String(focusGoalMin)) {   // a custom goal not in the list
  $('goalSelect').append(new Option(fmtDuration(focusGoalMin), String(focusGoalMin), true, true));
}
$('goalSelect').addEventListener('change', () => {
  setFocusGoal(Number($('goalSelect').value));
  renderAnalytics();
});

new ResizeObserver(() => { if (!$('analyticsView').hidden) renderChart(dayKey(Date.now())); }).observe($('chart'));

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('exportBtn').addEventListener('click', () => {
  const rows = [['date', 'score', 'day_rating', 'desk_minutes', 'focus_minutes', 'break_minutes', 'paused_other_minutes', 'focus_blocks', 'sessions', 'tasks_done']];
  const keys = typeof Sync !== 'undefined' ? Sync.allDayKeys() : new Set(Object.keys(store.days));
  (typeof tasks !== 'undefined' ? tasks.items : []).forEach(t => { if (t.done) keys.add(dayKey(t.done)); });
  if (typeof journal !== 'undefined') Object.keys(journal.entries).forEach(k => keys.add(k));
  [...keys].sort().forEach(k => {
    const d = peekDay(k);
    const m = v => (v / 60).toFixed(1);
    const sc = dayScore(k);
    const je = typeof journalEntry === 'function' ? journalEntry(k) : null;
    rows.push([k, sc ? sc.score : '', je ? je.rating : '', m(deskOf(d)), m(d.focus), m(d.brk), m(d.other), d.blocks,
      (d.sessions || []).length, taskStatsForDay(k).doneCount]);
  });
  download(`pomodoro-history-${dayKey(Date.now())}.csv`, rows.map(r => r.join(',')).join('\n'), 'text/csv');
});

$('backupBtn').addEventListener('click', () => {
  saveStore(true);
  const data = { app: 'pomodoro', version: 1, exported: new Date().toISOString(),
    analytics: store, tasks: typeof tasks !== 'undefined' ? tasks : null,
    journal: typeof journal !== 'undefined' ? journal : null, goal: focusGoalMin };
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
    if (data.goal) { setFocusGoal(Number(data.goal)); $('goalSelect').value = String(data.goal); }
    renderAnalytics();
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
  renderAnalytics();
  toast('Study history cleared (tasks kept)');
});
