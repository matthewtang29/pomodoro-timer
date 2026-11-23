// ================================================================= TODAY
// One page that sums up the day and the week before it: focus, score, tasks due,
// last night's sleep, and the past 7 days of focus, sleep, habits and day ratings.
// Everything here is read from the other pages' data; habits can be ticked off
// right here, upcoming tasks can be checked off, and today can be planned out as time blocks.

function dashDays(n) {   // the last n day keys, oldest first, ending today
  const today = todayKey();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftKey(today, -i));
  return out;
}
function dashDayLabel(k) { return k === todayKey() ? 'Today' : WD[keyToDate(k).getDay()].slice(0, 3); }

// Small bar chart: one column per day, value on hover (and always shown for today).
// ref: optional reference line (a goal), drawn as a dashed rule.
function dashBars(container, rows, { max, ref, refLabel }) {
  container.textContent = '';
  const chart = el('div', 'db-bars');
  if (ref && ref <= max) {
    const line = el('div', 'db-ref');
    line.style.bottom = `calc(var(--db-label) + ${(ref / max).toFixed(4)} * var(--db-plot))`;   // sizes in style.css
    if (refLabel) line.append(el('span', null, refLabel));
    chart.append(line);
  }
  rows.forEach(r => {
    const col = el('div', 'db-col' + (r.today ? ' today' : ''));
    col.tabIndex = 0;
    col.dataset.tip = r.tip;
    col.setAttribute('aria-label', `${r.label}: ${r.tip}`);
    const track = el('div', 'db-track');
    const bar = el('i', 'db-bar' + (r.cls ? ' ' + r.cls : '') + (r.value ? '' : ' none'));
    if (r.value) bar.style.height = Math.max(3, Math.min(100, r.value / max * 100)) + '%';
    track.append(bar);
    col.append(track, el('span', 'db-day', r.label));
    chart.append(col);
  });
  container.append(chart);
}

function renderDashboard() {
  const today = todayKey();
  const days = dashDays(7);
  $('dashDate').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  // ---------------- headline numbers
  const d = peekDay(today);
  const focusMin = Math.round(d.focus / 60);
  $('dbFocus').textContent = fmtDuration(focusMin);
  $('dbFocusSub').textContent = `of ${fmtDuration(focusGoalMin)} goal`;
  $('dbFocusMeter').style.width = Math.min(100, focusMin / focusGoalMin * 100) + '%';

  const sc = dayScore(today);
  $('dbScore').textContent = sc ? sc.score : '—';
  $('dbScoreSub').textContent = sc ? 'productivity score' : 'nothing to score yet';

  const open = tasks.items.filter(t => !t.done && t.due && t.due <= today);
  const doneToday = tasks.items.filter(t => t.done && dayKey(t.done) === today);
  $('dbTasks').textContent = `${doneToday.length}/${doneToday.length + open.length}`;
  $('dbTasksSub').textContent = open.length ? `${open.length} still due` : (doneToday.length ? 'all done' : 'nothing due');

  const night = sleepEntry(today);
  const nightMin = night ? sleepMinutes(night) : 0;
  $('dbSleep').textContent = night ? fmtSleep(nightMin) : '—';
  $('dbSleepSub').textContent = night ? `${fmtTimeOfDay(night.bed)} – ${fmtTimeOfDay(night.wake)}` : 'last night not logged';

  // ---------------- focus, past 7 days
  const focusRows = days.map(k => {
    const m = Math.round(peekDay(k).focus / 60);
    return { label: dashDayLabel(k), today: k === today, value: m, tip: m ? fmtDuration(m) : 'no focus' };
  });
  const focusMax = Math.max(focusGoalMin, ...focusRows.map(r => r.value));
  dashBars($('dbFocusChart'), focusRows, { max: focusMax, ref: focusGoalMin, refLabel: 'goal' });
  const weekFocus = focusRows.reduce((a, r) => a + r.value, 0);
  $('dbFocusWeek').textContent = weekFocus ? `${fmtDuration(weekFocus)} this week` : '';

  // ---------------- sleep, past 7 nights
  const sleepRows = days.map(k => {
    const e = sleepEntry(k);
    const m = e ? sleepMinutes(e) : 0;
    return { label: dashDayLabel(k), today: k === today, value: m, cls: e ? sleepCls(m) : '', tip: e ? fmtSleep(m) : 'not logged' };
  });
  dashBars($('dbSleepChart'), sleepRows, { max: Math.max(10 * 60, ...sleepRows.map(r => r.value)), ref: SLEEP_GOOD_MIN, refLabel: '7h' });
  const logged = sleepRows.filter(r => r.value);
  $('dbSleepAvg').textContent = logged.length
    ? `avg ${fmtSleep(Math.round(logged.reduce((a, r) => a + r.value, 0) / logged.length))}`
    : '';

  // ---------------- habits, past 7 days
  const hb = $('dbHabits');
  hb.textContent = '';
  const list = habitList();
  $('dbHabitsEmpty').hidden = list.length > 0;
  if (list.length) {
    const grid = el('div', 'db-hgrid');
    grid.append(el('span'));
    days.forEach(k => grid.append(el('span', 'db-hday' + (k === today ? ' today' : ''), dashDayLabel(k) === 'Today' ? 'T' : dashDayLabel(k).charAt(0))));
    grid.append(el('span'));
    let yes = 0;
    list.forEach(h => {
      grid.append(el('span', 'db-hname', h.name));
      let n = 0;
      days.forEach(k => {
        const v = h.checks ? h.checks[k] : undefined;
        if (v === 1) n++;
        const b = el('button', 'db-hcell' + (v === 1 ? ' yes' : v === 0 ? ' no' : '') + (k === today ? ' today' : ''));
        b.type = 'button';
        b.dataset.cell = `${h.id}|${k}`;
        b.setAttribute('aria-label', `${h.name}, ${fmtDay(k, today)}: ${CHECK_LABEL[v] || 'not marked'}`);
        b.addEventListener('click', () => {
          cycleCheck(h.id, k);
          renderDashboard();
          const again = $('dbHabits').querySelector(`[data-cell="${h.id}|${k}"]`);
          if (again) again.focus();
        });
        grid.append(b);
      });
      yes += n;
      grid.append(el('span', 'db-hcount', `${n}/7`));
    });
    hb.append(grid);
    $('dbHabitsPct').textContent = `${Math.round(yes / (list.length * 7) * 100)}% this week`;
  } else $('dbHabitsPct').textContent = '';

  // ---------------- upcoming tasks
  renderUpcoming();

  // ---------------- plan your day
  renderPlan(open);

  // ---------------- day ratings, past 7 days
  const mood = $('dbMood');
  mood.textContent = '';
  let rated = 0, sum = 0;
  days.forEach(k => {
    const e = journalEntry(k);
    const cell = el('button', 'db-mcell');
    cell.type = 'button';
    if (e && e.rating) {
      const mid = ratingMid(e);
      rated++; sum += mid;
      cell.classList.add('m-' + moodBand(mid));
      cell.append(el('b', null, ratingText(ratingLo(e), ratingHi(e))));
      cell.setAttribute('aria-label', `${fmtDay(k, today)}: rated ${ratingText(ratingLo(e), ratingHi(e))}`);
    } else {
      cell.classList.add('empty');
      cell.append(el('b', null, '·'));
      cell.setAttribute('aria-label', `${fmtDay(k, today)}: not rated`);
    }
    cell.append(el('span', null, dashDayLabel(k)));
    cell.addEventListener('click', () => openJournal(k));
    mood.append(cell);
  });
  $('dbMoodAvg').textContent = rated ? `avg ${(sum / rated).toFixed(1)}` : '';
}

// ================================================================= UPCOMING
// Every open task by due date (overdue first, no date last), as many as fit in the box.
// The hidden projects are a view setting kept on this device:
//   { hidden: ['proj', ''] }  ('' = no project). Sorting lives on the Tasks tab (tasks.js).
const UPCOMING_KEY = 'pomodoro-upcoming-v1';
let upcomingPrefs = loadUpcomingPrefs();

function loadUpcomingPrefs() {
  const out = { hidden: [] };
  try {
    const d = JSON.parse(localStorage.getItem(UPCOMING_KEY));
    if (isPlainObj(d) && Array.isArray(d.hidden)) out.hidden = d.hidden.filter(p => typeof p === 'string');
  } catch (e) {}
  return out;
}
function saveUpcomingPrefs() { safeSetItem(UPCOMING_KEY, JSON.stringify(upcomingPrefs)); }

function renderUpcoming() {
  const today = todayKey();
  const hidden = new Set(upcomingPrefs.hidden);
  const allOpen = tasks.items.filter(t => !t.done);
  const list = sortTasksBy(allOpen.filter(t => !hidden.has(t.project || '')), 'due');

  // project checklist (only projects that exist; "No project" when some task has none)
  const pop = $('dbProjsList');
  pop.textContent = '';
  const names = projects();
  if (tasks.items.some(t => !t.project)) names.push('');
  names.forEach(p => {
    const lab = el('label', 'db-proj');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hidden.has(p);
    box.addEventListener('change', () => {
      const s = new Set(upcomingPrefs.hidden);
      if (box.checked) s.delete(p); else s.add(p);
      upcomingPrefs.hidden = [...s];
      saveUpcomingPrefs();
      renderUpcoming();
    });
    lab.append(box, el('span', p ? null : 'none', p ? '#' + p : 'No project'));
    pop.append(lab);
  });
  if (!names.length) pop.append(el('p', 'empty-msg', 'No projects yet.'));
  const nHidden = names.filter(p => hidden.has(p)).length;
  $('dbProjsBtn').textContent = nHidden ? `Projects · ${nHidden} hidden` : 'Projects';

  const tl = $('dbTaskList');
  tl.textContent = '';
  $('dbTasksEmpty').hidden = list.length > 0;
  $('dbTasksEmpty').textContent = allOpen.length ? 'Every open task is in a hidden project.' : 'No open tasks. Nice.';
  list.slice(0, 60).forEach(t => {
    const row = el('div', 'db-task');
    const chk = el('button', 'db-check' + (isHigh(t) ? ' hi' : ''));
    chk.type = 'button';
    chk.setAttribute('aria-label', `Mark “${t.title}” done`);
    chk.addEventListener('click', () => { setTaskDone(t.id, true); renderDashboard(); });
    const title = el('span', 'db-ttitle', t.title);
    title.title = `${t.title}\n${priLabel(t.priority || 4)} priority · ${DIFF_LABEL[t.difficulty] || 'Medium'}` + (t.project ? ` · #${t.project}` : '');
    const late = t.due && t.due < today;
    const meta = el('span', 'db-tmeta');
    if (t.project) meta.append(el('span', 'db-tproj', '#' + t.project));
    meta.append(el('span', null, DIFF_LABEL[t.difficulty] || 'Medium'));
    meta.append(el('span', 'db-tdue' + (late ? ' overdue' : ''), late ? 'Overdue' : t.due ? fmtDue(t.due) : 'No date'));
    row.append(chk, title, meta);
    tl.append(row);
  });
  upcomingFit();
}

// Shows only the rows that fit in the box and counts the rest as "+N more".
function upcomingFit() {
  const tl = $('dbTaskList');
  const rows = [...tl.children];
  rows.forEach(r => { r.hidden = false; });
  const room = tl.parentElement.clientHeight;
  let shown = rows.length;
  if (room > 0 && tl.parentElement.offsetParent && getComputedStyle(tl).position === 'absolute') {
    shown = rows.findIndex(r => r.offsetTop + r.offsetHeight > room + 1);
    if (shown < 0) shown = rows.length;
    rows.slice(shown).forEach(r => { r.hidden = true; });
  } else if (rows.length > 8) {   // phone layout: the box isn't a fixed height, so show eight
    shown = 8;
    rows.slice(8).forEach(r => { r.hidden = true; });
  }
  const total = tasks.items.filter(t => !t.done && !upcomingPrefs.hidden.includes(t.project || '')).length;
  $('dbTasksMore').hidden = total <= shown;
  $('dbTasksMore').textContent = `+${total - shown} more`;
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => upcomingFit()).observe(document.querySelector('.db-tfit'));

// the project list closes on a click outside it or Esc
document.addEventListener('click', e => { const d = $('dbProjs'); if (d.open && !d.contains(e.target)) d.open = false; });
$('dbProjs').addEventListener('keydown', e => { if (e.key === 'Escape') { $('dbProjs').open = false; $('dbProjsBtn').focus(); } });

// ================================================================= PLAN YOUR DAY
// Time blocks for today, drawn as a one-day calendar where each block's height is its length:
//   dayPlan.blocks[id] = { day: 'YYYY-MM-DD', title, start: 'HH:MM', end: 'HH:MM', done: bool, color, u }
// One block per item so two devices editing the same day don't overwrite each other.
// Each block syncs as its own cloud document (users/{uid}/plan/{id}); days older than two
// weeks are dropped on save (and so deleted everywhere).
// An end of 00:00 means midnight at the end of the day.
const PLAN_KEY = 'pomodoro-plan-v2';
const PLAN_KEY_V1 = 'pomodoro-plan-v1';    // { days: { 'YYYY-MM-DD': [block] } }, device-only
const PLAN_HOUR_PX = 48;                   // height of one hour on the calendar
const PLAN_COLORS = ['sage', 'peach', 'butter'];
let dayPlan = loadPlan();
let planScrolledAt = 0;

const planBlockOk = b => isPlainObj(b) && typeof b.day === 'string' && typeof b.title === 'string' &&
  /^\d\d:\d\d$/.test(b.start) && /^\d\d:\d\d$/.test(b.end);
function loadPlan() {
  const out = { blocks: {} };
  try {
    const d = JSON.parse(localStorage.getItem(PLAN_KEY));
    if (isPlainObj(d) && isPlainObj(d.blocks)) {
      for (const [id, b] of Object.entries(d.blocks)) if (planBlockOk(b)) out.blocks[id] = b;
      return out;
    }
    // the first version kept a list per day on this device only: move it over (it uploads on sign-in)
    const old = JSON.parse(localStorage.getItem(PLAN_KEY_V1));
    if (isPlainObj(old) && isPlainObj(old.days)) {
      for (const [day, list] of Object.entries(old.days)) {
        if (!Array.isArray(list)) continue;
        list.forEach(b => {
          if (!isPlainObj(b)) return;
          const id = String(b.id || Math.random().toString(36).slice(2, 10)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
          const blk = { day, title: String(b.title || ''), start: b.start, end: b.end, done: !!b.done, color: b.color || 'sage', u: Date.now() };
          if (id && planBlockOk(blk)) out.blocks[id] = blk;
        });
      }
    }
  } catch (e) {}
  return out;
}
function savePlan() {
  const cut = shiftKey(todayKey(), -14);
  for (const [id, b] of Object.entries(dayPlan.blocks)) if (b.day < cut) delete dayPlan.blocks[id];
  if (typeof Sync !== 'undefined') Sync.stamp('plan');
  if (safeSetItem(PLAN_KEY, JSON.stringify(dayPlan))) { try { localStorage.removeItem(PLAN_KEY_V1); } catch (e) {} }
}
function restorePlan(data) {
  dayPlan = { blocks: { ...data.blocks } };
  savePlan();
  if (!$('todayView').hidden) renderDashboard();
}
function planBlocks(k) {
  return Object.entries(dayPlan.blocks).filter(([, b]) => b.day === k).map(([id, b]) => ({ ...b, id }))
    .sort((a, b) => planStart(a) - planStart(b) || planEnd(a) - planEnd(b));
}
const planStart = b => toMin(b.start);
const planEnd = b => toMin(b.end) || 1440;
function minToHHMM(m) { m = Math.max(0, Math.min(1439, m)); return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; }
function planEndValue(m) { return m >= 1440 ? '00:00' : minToHHMM(m); }
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function fmtHour(h) { return new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }); }
// "2:00 – 4:00 PM" (AM/PM shown once when both times share it)
function fmtSpan(a, b) {
  const s = fmtTimeOfDay(a), e = fmtTimeOfDay(b);
  const tail = x => (x.match(/[^\d:]+$/) || [''])[0];
  const t = tail(s);
  return t.trim() && t === tail(e) ? `${s.slice(0, -t.length)} – ${e}` : `${s} – ${e}`;
}

// Default times: right after the last block that is still running or ahead, else the next half hour.
function planDefaultTimes() {
  const n = nowMin();
  let s = Math.ceil(n / 30) * 30;
  const ends = planBlocks(todayKey()).map(planEnd).filter(e => e > n);
  if (ends.length) s = Math.max(s, Math.max(...ends));
  planSetTimes(Math.min(s, 1380));
}
// Fills in start and an end an hour later. The end then follows the start (an hour after it)
// until the person picks an end themselves; after that it is left alone.
let planEndTouched = false;
function planSetTimes(startMin) {
  $('plStart').value = minToHHMM(startMin);
  $('plEnd').value = planEndValue(startMin + 60);
  planEndTouched = false;
}

// Blocks that overlap sit side by side: each cluster of overlapping blocks is
// split into as many columns as it needs.
function planLayout(list) {
  const sorted = list.slice().sort((a, b) => planStart(a) - planStart(b) || planEnd(b) - planEnd(a));
  const out = new Map();
  let cluster = [], cols = [], clusterEnd = -1;
  const close = () => { cluster.forEach(b => { out.get(b).n = cols.length; }); cluster = []; cols = []; };
  sorted.forEach(b => {
    if (planStart(b) >= clusterEnd) close();
    let c = cols.findIndex(end => end <= planStart(b));
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = planEnd(b);
    out.set(b, { col: c, n: 1 });
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, planEnd(b));
  });
  close();
  return out;
}

function renderPlan(openTasks) {
  const today = todayKey();
  const list = planBlocks(today);
  const cal = $('plCal');

  const total = list.reduce((a, b) => a + planEnd(b) - planStart(b), 0);
  $('dbPlanSum').textContent = total ? `${fmtDuration(total)} planned` : '';

  // open task titles to pick from while typing
  const dl = $('plTaskList');
  dl.textContent = '';
  sortTasks(openTasks || []).slice(0, 30).forEach(t => { const o = document.createElement('option'); o.value = t.title; dl.append(o); });
  const editing = $('plForm').contains(document.activeElement) || $('plTitle').value;
  if (!$('plStart').value || (!editing && !planEndTouched)) planDefaultTimes();

  // the hour grid is built once; blocks and the now line are redrawn
  let grid = cal.querySelector('.pl-grid');
  if (!grid) {
    grid = el('div', 'pl-grid');
    grid.style.height = 24 * PLAN_HOUR_PX + 'px';
    for (let h = 0; h < 24; h++) {
      const row = el('div', 'pl-hour');
      row.style.top = h * PLAN_HOUR_PX + 'px';
      row.append(el('span', 'pl-hlabel', h ? fmtHour(h) : ''));
      grid.append(row);
    }
    grid.append(el('div', 'pl-blocks'));
    const now = el('div', 'pl-now');
    now.append(el('span'));
    grid.append(now);
    // clicking an empty spot starts a block at that half hour
    grid.addEventListener('click', e => {
      if (e.target.closest('.pl-block')) return;
      const m = Math.min(1410, Math.floor((e.clientY - grid.getBoundingClientRect().top) / PLAN_HOUR_PX * 2) * 30);
      planSetTimes(m);
      $('plErr').hidden = true;
      $('plTitle').focus();
    });
    cal.append(grid);
  }

  const layer = grid.querySelector('.pl-blocks');
  layer.textContent = '';
  const n = nowMin();
  const lay = planLayout(list);
  list.forEach(b => {
    const s = planStart(b), e = planEnd(b), { col, n: cols } = lay.get(b);
    const h = (e - s) / 60 * PLAN_HOUR_PX;
    const blk = el('div', `pl-block c-${PLAN_COLORS.includes(b.color) ? b.color : 'sage'}` +
      (b.done ? ' done' : '') + (e <= n ? ' past' : '') + (s <= n && n < e ? ' current' : '') + (h < 44 ? ' short' : ''));
    blk.style.top = s / 60 * PLAN_HOUR_PX + 1 + 'px';
    blk.style.height = Math.max(h, 20) - 2 + 'px';
    blk.style.left = `calc(${col} * 100% / ${cols})`;
    blk.style.width = `calc(100% / ${cols} - 4px)`;
    blk.title = `${b.title}\n${fmtSpan(b.start, b.end)}`;

    const chk = el('button', 'pl-check');
    chk.type = 'button';
    chk.setAttribute('aria-pressed', b.done ? 'true' : 'false');
    chk.setAttribute('aria-label', `${b.done ? 'Not done' : 'Done'}: ${b.title}`);
    chk.addEventListener('click', () => {
      const it = dayPlan.blocks[b.id];
      if (it) { it.done = !it.done; savePlan(); }
      renderPlan(openTasks);
    });
    const del = el('button', 'pl-del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', `Remove ${b.title}`);
    del.addEventListener('click', () => {
      delete dayPlan.blocks[b.id];
      savePlan();
      renderDashboard();
    });
    const txt = el('div', 'pl-txt');
    txt.append(el('b', null, b.title), el('span', null, fmtSpan(b.start, b.end)));
    blk.append(chk, txt, del);
    layer.append(blk);
  });
  planNowLine();

  // bring the current hour into view when the page is opened (not on every redraw)
  if (Date.now() - planScrolledAt > 5 * 60e3 && cal.offsetParent) {
    planScrolledAt = Date.now();
    cal.scrollTop = Math.max(0, (n / 60 - 1.5) * PLAN_HOUR_PX);
  }
}
function planNowLine() {
  const line = document.querySelector('#plCal .pl-now');
  if (!line) return;
  const n = nowMin();
  line.style.top = n / 60 * PLAN_HOUR_PX + 'px';
  line.firstChild.textContent = fmtTimeOfDay(minToHHMM(n));
  // the hour label right under the now label would peek out behind it
  document.querySelectorAll('#plCal .pl-hlabel').forEach((l, h) => { l.style.visibility = Math.abs(h * 60 - n) < 16 ? 'hidden' : ''; });
}
setInterval(() => { if (!$('todayView').hidden) planNowLine(); }, 30e3);

$('plForm').addEventListener('submit', e => {
  e.preventDefault();
  const err = msg => { $('plErr').textContent = msg; $('plErr').hidden = false; };
  const title = $('plTitle').value.trim();
  const start = $('plStart').value, end = $('plEnd').value;
  if (!title) return err('Give the block a name.');
  if (!start || !end) return err('Pick a start and an end time.');
  const b = { day: todayKey(), title, start, end, done: false };
  if (planEnd(b) <= planStart(b)) return err('The end time has to be after the start.');
  b.color = PLAN_COLORS[planBlocks(b.day).length % PLAN_COLORS.length];
  dayPlan.blocks[Date.now().toString(36) + Math.random().toString(36).slice(2, 6)] = b;
  savePlan();
  $('plErr').hidden = true;
  $('plTitle').value = '';
  // the next block starts where this one ended
  const next = planEnd(b);
  if (next < 1440) planSetTimes(next);
  renderDashboard();
  const cal = $('plCal');
  const top = planStart(b) / 60 * PLAN_HOUR_PX;
  if (top < cal.scrollTop || top > cal.scrollTop + cal.clientHeight - 40) cal.scrollTop = Math.max(0, top - PLAN_HOUR_PX);
  $('plTitle').focus();
});
['plStart', 'plEnd', 'plTitle'].forEach(id => $(id).addEventListener('input', () => { $('plErr').hidden = true; }));
$('plEnd').addEventListener('input', () => { planEndTouched = !!$('plEnd').value; });
$('plStart').addEventListener('input', () => {
  if (planEndTouched || !$('plStart').value) return;
  $('plEnd').value = planEndValue(toMin($('plStart').value) + 60);
});

document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.goto)));
