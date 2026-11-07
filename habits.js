// ================================================================= HABITS
// A monthly habit grid: one row per habit, one box per day of the month.
// Click a box to cycle it: empty -> ✓ yes -> ✕ no -> empty.
// Stored as { items: { id: { id, name, created, order, checks: { 'YYYY-MM-DD': 1 | 0 } } } }
// (1 = yes, 0 = no, missing = not marked). Each habit syncs as its own cloud document.

const HABITS_KEY = 'pomodoro-habits-v1';
let habits = loadHabits();
let habitMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();

function loadHabits() {
  try {
    const d = JSON.parse(localStorage.getItem(HABITS_KEY));
    if (d && d.items && typeof d.items === 'object') return d;
  } catch (e) {}
  return { items: {} };
}
function saveHabits() {
  if (typeof Sync !== 'undefined') Sync.stamp('habits');
  try { localStorage.setItem(HABITS_KEY, JSON.stringify(habits)); } catch (e) {}
}
function restoreHabits(data) {
  habits = { items: { ...data.items } };
  saveHabits();
  if (!$('habitsView').hidden) renderHabits();
}

function habitList() {
  return Object.values(habits.items).sort((a, b) => (a.order || 0) - (b.order || 0) || a.created - b.created);
}

function addHabit(name) {
  name = name.trim().slice(0, 60);
  if (!name) return null;
  const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const order = Math.max(0, ...habitList().map(h => h.order || 0)) + 1;
  habits.items[id] = { id, name, created: Date.now(), order, checks: {} };
  saveHabits();
  return habits.items[id];
}

function deleteHabit(id) {
  const h = habits.items[id];
  if (!h) return;
  delete habits.items[id];
  saveHabits();
  renderHabits();
  toast(`Deleted “${h.name}”`, 'Undo', () => { habits.items[id] = h; saveHabits(); renderHabits(); });
}

function renameHabit(id) {
  const h = habits.items[id];
  if (!h) return;
  const name = prompt('Rename habit', h.name);
  if (name == null || !name.trim()) return;
  h.name = name.trim().slice(0, 60);
  saveHabits();
  renderHabits();
}

// empty -> yes -> no -> empty
function cycleCheck(id, k) {
  const h = habits.items[id];
  if (!h) return;
  h.checks = { ...(h.checks || {}) };
  const v = h.checks[k];
  if (v === undefined) h.checks[k] = 1;
  else if (v === 1) h.checks[k] = 0;
  else delete h.checks[k];
  saveHabits();
}

// Days in a row marked yes, ending today (or yesterday if today isn't marked yet)
function habitStreak(h) {
  const today = todayKey();
  let k = h.checks[today] === 1 ? today : shiftKey(today, -1);
  let n = 0;
  while (h.checks[k] === 1) { n++; k = shiftKey(k, -1); }
  return n;
}

const CHECK_LABEL = { 1: 'yes', 0: 'no' };

function paintHabitCell(b, h, k, dayNum, dow) {
  const v = h.checks ? h.checks[k] : undefined;
  b.className = 'hb-cell' + (v === 1 ? ' yes' : v === 0 ? ' no' : '') + (k === todayKey() ? ' today' : '');
  b.textContent = '';
  b.append(el('span', 'hb-d', String(dayNum)), el('span', 'hb-m', v === 1 ? '✓' : v === 0 ? '✕' : WD[dow].charAt(0)));
  b.setAttribute('aria-label', `${h.name}, ${WD[dow]} ${MO[habitMonth.getMonth()]} ${dayNum}: ${CHECK_LABEL[v] || 'not marked'}`);
  b.setAttribute('aria-pressed', v === 1 ? 'true' : v === 0 ? 'mixed' : 'false');
}

// One card per habit; the days wrap onto as many rows as the screen needs (no sideways scrolling)
function renderHabits() {
  const y = habitMonth.getFullYear(), m = habitMonth.getMonth();
  const days = new Date(y, m + 1, 0).getDate();
  const today = todayKey();
  const keyOf = d => `${y}-${pad2(m + 1)}-${pad2(d)}`;
  $('habitTitle').textContent = habitMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const list = habitList();
  const wrap = $('habitGrid');
  wrap.textContent = '';
  $('habitEmpty').hidden = list.length > 0;
  if (!list.length) { $('habitSub').textContent = 'Add a habit to start tracking'; return; }

  let monthYes = 0, monthPossible = 0;
  list.forEach(h => {
    const card = el('section', 'hb-card box');
    const head = el('div', 'hb-head');
    const name = el('button', 'hb-name-btn', h.name);
    name.type = 'button';
    name.title = 'Rename';
    name.addEventListener('click', () => renameHabit(h.id));
    head.append(name);
    const streak = habitStreak(h);
    if (streak >= 2) head.append(el('span', 'hb-streak', `🔥 ${streak} days`));
    const stat = el('span', 'hb-stat');
    head.append(stat);
    const del = el('button', 'hb-del', '×');
    del.type = 'button';
    del.title = `Delete “${h.name}”`;
    del.setAttribute('aria-label', `Delete habit ${h.name}`);
    del.addEventListener('click', () => deleteHabit(h.id));
    head.append(del);

    const grid = el('div', 'hb-days');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', h.name);
    let yes = 0, possible = 0;
    for (let d = 1; d <= days; d++) {
      const k = keyOf(d);
      const b = el('button');
      b.type = 'button';
      b.dataset.cell = `${h.id}|${k}`;
      paintHabitCell(b, h, k, d, new Date(y, m, d).getDay());
      if (k > today) b.disabled = true;
      else possible++;
      if (h.checks && h.checks[k] === 1) yes++;
      b.addEventListener('click', () => {
        cycleCheck(h.id, k);
        renderHabits();
        const again = $('habitGrid').querySelector(`[data-cell="${h.id}|${k}"]`);
        if (again) again.focus();
      });
      grid.append(b);
    }
    stat.textContent = `${yes}/${possible} days`;
    monthYes += yes; monthPossible += possible;
    card.append(head, grid);
    wrap.append(card);
  });

  $('habitSub').textContent = monthPossible
    ? `${list.length} habit${list.length === 1 ? '' : 's'} · ${Math.round(monthYes / monthPossible * 100)}% done this month`
    : `${list.length} habit${list.length === 1 ? '' : 's'}`;
}

function shiftHabitMonth(n) {
  habitMonth = new Date(habitMonth.getFullYear(), habitMonth.getMonth() + n, 1);
  renderHabits();
}
$('habitPrev').addEventListener('click', () => shiftHabitMonth(-1));
$('habitNext').addEventListener('click', () => shiftHabitMonth(1));
$('habitToday').addEventListener('click', () => {
  const d = new Date();
  habitMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  renderHabits();
});
$('habitForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('habitInput');
  if (!inp.value.trim()) { inp.focus(); return; }
  addHabit(inp.value);
  inp.value = '';
  renderHabits();
  inp.focus();
});
