// ================================================================= TASKS
// A small Todoist-style task list: quick add with shortcuts, priorities p1–p4,
// difficulty 1–5, #projects, due dates, and Today / Upcoming / All / Done views.
// Tasks can be linked to the timer so focus time is credited to them.
// Each task can have a checklist of subtasks (stored on the task as
// subtasks: [{ id, title, done }], so they sync and back up with it).

const TASKS_KEY = 'pomodoro-tasks-v1';
let tasks = loadTasks();
let taskView = 'today';
let projFilter = '';
let editingId = null;
let currentTaskId = null;           // task linked to the timer
let qaState = { due: '', priority: 4, difficulty: 3, project: '' };   // values from the form controls

function loadTasks() {
  try {
    const d = JSON.parse(localStorage.getItem(TASKS_KEY));
    if (d && Array.isArray(d.items)) return d;
  } catch (e) {}
  return { v: 1, items: [] };
}
function saveTasks() {
  if (typeof Sync !== 'undefined') Sync.stamp('tasks');
  try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); } catch (e) {}
  renderSideNav();
}
function restoreTasks(data) {
  tasks = data;
  saveTasks();
  renderTasks();
  renderTimerTask();
}
function taskById(id) { return tasks.items.find(t => t.id === id); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayKey() { return dayKey(Date.now()); }

// ---------------------------------------------------------------- quick-add parser
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WD_RE = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?';
const MO_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// "Circuits lab report fri p1 d4 #ECE140" ->
// { title: 'Circuits lab report', due: '2026-10-02', priority: 1, difficulty: 4, project: 'ECE140' }
function parseQuickAdd(text) {
  let t = ` ${text} `;
  const out = {};
  const take = (re, fn) => {
    t = t.replace(re, (...m) => (fn(...m) === false ? m[0] : ' '));
  };
  take(/\s[pP]([1-4])(?=\s)/, (_, n) => { out.priority = +n; });
  take(/\s[dD]([1-5])(?=\s)/, (_, n) => { out.difficulty = +n; });
  take(/\s#([\w\-.]+)(?=\s)/, (_, p) => { out.project = p; });

  const base = new Date(); base.setHours(0, 0, 0, 0);
  const plus = n => { const d = new Date(base); d.setDate(d.getDate() + n); return dayKey(d); };
  const monthDay = (mo, day) => {
    if (day < 1 || day > 31 || mo < 0 || mo > 11) return null;
    const d = new Date(base.getFullYear(), mo, day);
    if (d.getMonth() !== mo) return null;              // e.g. feb 31
    if (d < base) d.setFullYear(d.getFullYear() + 1);  // already passed this year
    return dayKey(d);
  };
  const mo3 = m => MONTHS[m.slice(0, 3).toLowerCase()];
  // Each pattern turns a match into a date. If several date phrases appear,
  // the last one wins (dates are usually typed at the end).
  const patterns = [
    [/\s(?:due\s+)?(?:today|tod)(?=\s)/gi, () => plus(0)],
    [/\s(?:due\s+)?(?:tomorrow|tmrw|tmr)(?=\s)/gi, () => plus(1)],
    [/\s(?:due\s+)?(?:yesterday|yday)(?=\s)/gi, () => plus(-1)],
    [/\sin\s+(\d{1,3})\s+days?(?=\s)/gi, m => plus(+m[1])],
    [/\snext\s+week(?=\s)/gi, () => plus(((8 - base.getDay()) % 7) || 7)],
    [new RegExp(`\\s(?:due\\s+)?(?:on\\s+)?(next\\s+)?(${WD_RE})(?=\\s)`, 'gi'), m => {
      let diff = (WEEKDAYS[m[2].slice(0, 3).toLowerCase()] - base.getDay() + 7) % 7;
      if (m[1] && diff === 0) diff = 7;
      return plus(diff);
    }],
    [new RegExp(`\\s(?:due\\s+)?(?:on\\s+)?(${MO_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?=\\s)`, 'gi'), m => monthDay(mo3(m[1]), +m[2])],
    [new RegExp(`\\s(?:due\\s+)?(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MO_RE})(?=\\s)`, 'gi'), m => monthDay(mo3(m[2]), +m[1])],
    [/\s(?:due\s+)?(\d{1,2})\/(\d{1,2})(?=\s)/g, m => monthDay(+m[1] - 1, +m[2])],
  ];
  let best = null;
  patterns.forEach(([re, fn]) => {
    for (const m of t.matchAll(re)) {
      const due = fn(m);
      if (due && (!best || m.index > best.index)) best = { index: m.index, length: m[0].length, due };
    }
  });
  if (best) {
    out.due = best.due;
    t = t.slice(0, best.index) + ' ' + t.slice(best.index + best.length);
  }

  out.title = t.replace(/\s+/g, ' ').trim();
  return out;
}

// ---------------------------------------------------------------- small formatters
function fmtDue(k) {
  const today = todayKey();
  if (!k) return '';
  if (k === today) return 'Today';
  if (k === shiftKey(today, 1)) return 'Tomorrow';
  if (k === shiftKey(today, -1)) return 'Yesterday';
  const d = keyToDate(k);
  const diff = Math.round((d - keyToDate(today)) / 86400000);
  if (diff > 1 && diff < 7) return WD[d.getDay()];
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${MO[d.getMonth()]} ${d.getDate()}${sameYear ? '' : ', ' + d.getFullYear()}`;
}
function diffDots(n) {
  const wrap = el('span', 'dots');
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 1; i <= 5; i++) wrap.append(el('i', i <= n ? 'on' : ''));
  return wrap;
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';

function projects() {
  return [...new Set(tasks.items.map(t => t.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- mutations
function addTask(fields) {
  const t = {
    id: newId(),
    title: fields.title,
    due: fields.due || null,
    priority: fields.priority || 4,
    difficulty: fields.difficulty || 3,
    project: fields.project || '',
    created: Date.now(),
    done: null,
    focusSec: 0,
  };
  tasks.items.push(t);
  saveTasks();
  refreshTaskViews();
  return t;
}

function setTaskDone(id, done) {
  const t = taskById(id);
  if (!t) return;
  t.done = done ? Date.now() : null;
  // credit a session that's running right now
  if (typeof liveSession !== 'undefined' && liveSession) {
    liveSession.tasksDone = liveSession.tasksDone || [];
    if (done) liveSession.tasksDone.push({ id, difficulty: t.difficulty });
    else liveSession.tasksDone = liveSession.tasksDone.filter(x => x.id !== id);
  }
  if (done && currentTaskId === id) setCurrentTask(null);
  saveTasks();
  refreshTaskViews();
  if (done) toast(`Completed "${t.title}"`, 'Undo', () => setTaskDone(id, false));
}

function deleteTask(id) {
  const i = tasks.items.findIndex(t => t.id === id);
  if (i < 0) return;
  const [removed] = tasks.items.splice(i, 1);
  if (currentTaskId === id) setCurrentTask(null);
  saveTasks();
  refreshTaskViews();
  toast(`Deleted "${removed.title}"`, 'Undo', () => {
    tasks.items.splice(i, 0, removed);
    saveTasks();
    refreshTaskViews();
  });
}

// Called by analytics every focus second-tick
let lastTaskSave = 0;
function onFocusTick(secs) {
  if (!currentTaskId) return;
  const t = taskById(currentTaskId);
  if (!t) return;
  t.focusSec = (t.focusSec || 0) + secs;
  if (liveSession) {
    liveSession.work = liveSession.work || {};
    liveSession.diffs = liveSession.diffs || {};
    liveSession.work[t.id] = (liveSession.work[t.id] || 0) + secs;
    liveSession.diffs[t.id] = t.difficulty;
  }
  if (Date.now() - lastTaskSave > 10000) { lastTaskSave = Date.now(); saveTasks(); }
}
window.addEventListener('pagehide', saveTasks);

function refreshTaskViews() {
  if (!$('tasksView').hidden) renderTasks();
  if (!$('calView').hidden && typeof renderCalendar === 'function') renderCalendar();
  if (!$('analyticsView').hidden) renderAnalytics();
  renderTimerTask();
  renderProjectLists();
  if (focusSub) {   // keep typing: put the cursor back in the "add a subtask" box
    const box = [...document.querySelectorAll('[data-sub-input]')].find(i => i.dataset.subInput === focusSub && i.offsetParent);
    if (box) box.focus();
    focusSub = null;
  }
}

// ---------------------------------------------------------------- subtasks
const openSubs = new Set();   // tasks whose checklist is showing
let focusSub = null;          // task whose "add a subtask" box should get the cursor next
function subsOf(t) { return Array.isArray(t.subtasks) ? t.subtasks : []; }

function addSubtask(id, title) {
  const t = taskById(id);
  if (!t || !title.trim()) return;
  t.subtasks = [...subsOf(t), { id: newId(), title: title.trim(), done: false }];
  openSubs.add(id);
  saveTasks();
  refreshTaskViews();
}
function toggleSubtask(id, sid) {
  const t = taskById(id);
  const s = t && subsOf(t).find(x => x.id === sid);
  if (!s) return;
  s.done = !s.done;
  saveTasks();
  refreshTaskViews();
  if (s.done && !t.done && subsOf(t).every(x => x.done)) {
    toast(`All subtasks of "${t.title}" done`, 'Complete task', () => setTaskDone(id, true));
  }
}
function deleteSubtask(id, sid) {
  const t = taskById(id);
  const list = t ? subsOf(t) : [];
  const i = list.findIndex(x => x.id === sid);
  if (i < 0) return;
  const [gone] = list.splice(i, 1);
  t.subtasks = list;
  saveTasks();
  refreshTaskViews();
  toast(`Deleted subtask "${gone.title}"`, 'Undo', () => {
    const now = subsOf(t);
    now.splice(i, 0, gone);
    t.subtasks = now;
    saveTasks();
    refreshTaskViews();
  });
}

// The checklist under a task (Tasks tab, Calendar day panel, Timer tab)
function subtaskList(t) {
  const box = el('div', 'subtasks');
  subsOf(t).forEach(s => {
    const row = el('div', 'subtask' + (s.done ? ' done' : ''));
    const c = el('button', 'sub-check');
    c.type = 'button';
    c.innerHTML = CHECK_SVG;
    c.setAttribute('aria-pressed', String(!!s.done));
    c.setAttribute('aria-label', `${s.done ? 'Mark not done' : 'Complete'}: ${s.title}`);
    c.addEventListener('click', () => toggleSubtask(t.id, s.id));
    const del = el('button', 'sub-del', '×');
    del.type = 'button';
    del.title = 'Delete subtask';
    del.setAttribute('aria-label', `Delete subtask "${s.title}"`);
    del.addEventListener('click', () => deleteSubtask(t.id, s.id));
    row.append(c, el('span', 'sub-title', s.title), del);
    box.append(row);
  });
  if (!t.done) {
    const f = el('form', 'sub-add');
    f.autocomplete = 'off';
    const i = el('input');
    i.placeholder = 'Add a subtask…';
    i.dataset.subInput = t.id;
    i.setAttribute('aria-label', `New subtask for "${t.title}"`);
    i.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !i.value) { e.preventDefault(); openSubs.delete(t.id); refreshTaskViews(); }
    });
    f.append(i);
    f.addEventListener('submit', e => {
      e.preventDefault();
      if (!i.value.trim()) return;
      focusSub = t.id;
      addSubtask(t.id, i.value);
    });
    box.append(f);
  }
  return box;
}

// The checklist for the task on the timer, under "Working on"
function renderTimerSubs() {
  const box = $('timerSubs');
  if (!box) return;
  const t = currentTaskId ? taskById(currentTaskId) : null;
  const sig = t ? t.id + JSON.stringify(subsOf(t)) : '';
  if (sig === box.dataset.sig) return;   // unchanged: don't rebuild (keeps typing in the box)
  box.dataset.sig = sig;
  box.textContent = '';
  box.hidden = !t;
  if (t) box.append(subtaskList(t));
}

// ---------------------------------------------------------------- task list
function sortTasks(list) {
  return list.slice().sort((a, b) =>
    (a.due || '9999') .localeCompare(b.due || '9999') ||
    a.priority - b.priority ||
    b.difficulty - a.difficulty ||
    a.created - b.created);
}

function renderTasks() {
  const box = $('taskList');
  box.textContent = '';
  const today = todayKey();
  let open = tasks.items.filter(t => !t.done && (!projFilter || t.project === projFilter));
  const groups = [];

  if (taskView === 'today') {
    const overdue = sortTasks(open.filter(t => t.due && t.due < today));
    const due = sortTasks(open.filter(t => t.due === today));
    if (overdue.length) groups.push({ title: 'Overdue', cls: 'overdue', items: overdue });
    groups.push({ title: 'Today', sub: keyToDate(today).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
      items: due, empty: 'Nothing due today. Add a task below, or check Upcoming.' });
  } else if (taskView === 'upcoming') {
    const future = sortTasks(open.filter(t => t.due && t.due > today));
    const byDay = {};
    future.forEach(t => (byDay[t.due] = byDay[t.due] || []).push(t));
    Object.keys(byDay).sort().forEach(k => {
      const d = keyToDate(k);
      groups.push({ title: fmtDue(k), sub: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), items: byDay[k] });
    });
    const nodate = sortTasks(open.filter(t => !t.due));
    if (nodate.length) groups.push({ title: 'No date', items: nodate });
    if (!groups.length) groups.push({ title: 'Upcoming', items: [], empty: 'No upcoming tasks.' });
  } else if (taskView === 'all') {
    const byProj = {};
    sortTasks(open).forEach(t => (byProj[t.project || ''] = byProj[t.project || ''] || []).push(t));
    Object.keys(byProj).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b)).forEach(p => {
      groups.push({ title: p ? '# ' + p : 'No project', items: byProj[p] });
    });
    if (!groups.length) groups.push({ title: 'All tasks', items: [], empty: 'No open tasks. Nice.' });
  } else {
    const done = tasks.items.filter(t => t.done && (!projFilter || t.project === projFilter))
      .sort((a, b) => b.done - a.done).slice(0, 100);
    const byDay = {};
    done.forEach(t => { const k = dayKey(t.done); (byDay[k] = byDay[k] || []).push(t); });
    Object.keys(byDay).sort().reverse().forEach(k => groups.push({ title: fmtDay(k, today), items: byDay[k] }));
    if (!groups.length) groups.push({ title: 'Done', items: [], empty: 'Completed tasks will show up here.' });
  }

  groups.forEach(g => {
    const sec = el('section', 'task-group');
    const h = el('h4', g.cls || '', g.title);
    const pts = g.items.reduce((a, t) => a + t.difficulty, 0);
    if (g.items.length) h.append(el('span', null, `${g.items.length} task${g.items.length > 1 ? 's' : ''} · ${pts} pts`));
    else if (g.sub) h.append(el('span', null, g.sub));
    sec.append(h);
    if (!g.items.length && g.empty) sec.append(el('div', 'task-empty', g.empty));
    g.items.forEach(t => sec.append(t.id === editingId ? taskEditor(t) : taskRow(t)));
    box.append(sec);
  });

  // page header
  const shown = groups.reduce((a, g) => a + g.items.length, 0);
  const doneToday = tasks.items.filter(t => t.done && dayKey(t.done) === today).length;
  $('taskTitle').textContent = { today: 'Today', upcoming: 'Upcoming', all: 'All tasks', done: 'Done' }[taskView];
  $('taskSub').textContent = (projFilter ? `# ${projFilter} · ` : '')
    + `${shown} task${shown === 1 ? '' : 's'}` + (taskView !== 'done' ? ` · ${doneToday} done today` : '');
  renderSideNav();
}

// Sidebar: open-task count on the Tasks tab, and the project list (click to filter)
function renderSideNav() {
  const today = todayKey();
  const open = tasks.items.filter(t => !t.done);
  const dueNow = open.filter(t => t.due && t.due <= today).length;
  $('tabTaskCount').textContent = dueNow || '';
  const ps = projects();
  const box = $('sideProjects');
  box.textContent = '';
  $('sideProjectsWrap').hidden = !ps.length;
  ps.forEach(p => {
    const n = open.filter(t => t.project === p).length;
    const b = el('button', 'side-proj');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!$('tasksView').hidden && projFilter === p));
    b.append(el('span', 'hash', '#'), el('span', 'name', p), el('span', 'count', n ? String(n) : ''));
    b.addEventListener('click', () => {
      projFilter = projFilter === p && !$('tasksView').hidden ? '' : p;
      showTab('tasks');
    });
    box.append(b);
  });
}

// One task row. Used on the Tasks tab and in the Calendar day panel.
function taskRow(t, opts = {}) {
  const today = todayKey();
  const row = el('div', 'task' + (t.done ? ' done' : '') + (t.id === currentTaskId ? ' linked' : ''));
  row.dataset.id = t.id;

  const check = el('button', 'check p' + t.priority);
  check.type = 'button';
  check.innerHTML = CHECK_SVG;
  check.setAttribute('aria-label', t.done ? `Mark "${t.title}" not done` : `Complete "${t.title}"`);
  check.addEventListener('click', () => setTaskDone(t.id, !t.done));

  const body = el('div', 't-body');
  body.append(el('div', 't-title', t.title));
  const meta = el('div', 't-meta');
  if (t.due && !opts.hideDue) {
    const cls = !t.done && t.due < today ? ' overdue' : t.due === today ? ' today' : '';
    meta.append(el('span', 'due' + cls, '📅 ' + fmtDue(t.due)));
  }
  const diff = el('span', 'diff');
  diff.title = `Difficulty ${t.difficulty} of 5`;
  diff.append(diffDots(t.difficulty), DIFF_LABEL[t.difficulty]);
  meta.append(diff);
  if (t.priority < 4) meta.append(el('span', 'pflag', 'P' + t.priority));
  if (t.focusSec >= 60) meta.append(el('span', null, '⏱ ' + fmtSecs(t.focusSec)));
  if (t.id === currentTaskId) meta.append(el('span', 'pflag', '● on the timer'));
  const subs = subsOf(t);
  if (subs.length) {
    const open = openSubs.has(t.id);
    const n = subs.filter(s => s.done).length;
    const tog = el('button', 'sub-toggle' + (open ? ' open' : '') + (n === subs.length ? ' all' : ''), `${n}/${subs.length}`);
    tog.type = 'button';
    tog.title = open ? 'Hide subtasks' : 'Show subtasks';
    tog.setAttribute('aria-expanded', String(open));
    tog.setAttribute('aria-label', `${n} of ${subs.length} subtasks done. ${open ? 'Hide' : 'Show'} subtasks`);
    tog.addEventListener('click', () => { if (open) openSubs.delete(t.id); else openSubs.add(t.id); refreshTaskViews(); });
    meta.prepend(tog);
  }
  body.append(meta);
  if (openSubs.has(t.id)) body.append(subtaskList(t));

  const actions = el('div', 't-actions');
  if (!t.done) {
    const focus = el('button', 't-focus', '▶ Focus');
    focus.type = 'button';
    focus.title = 'Work on this with the timer';
    focus.addEventListener('click', () => { setCurrentTask(t.id); showTab('timer'); });
    actions.append(focus);
  }
  if (!t.done) {
    const sub = el('button', 't-sub');
    sub.type = 'button';
    sub.append('＋', el('span', 't-edit-label', ' Subtask'));
    sub.title = 'Add a subtask';
    sub.setAttribute('aria-label', `Add a subtask to "${t.title}"`);
    sub.addEventListener('click', () => { openSubs.add(t.id); focusSub = t.id; refreshTaskViews(); });
    actions.append(sub);
  }
  const edit = el('button', 't-edit');
  edit.type = 'button';
  edit.append('✎', el('span', 't-edit-label', ' Edit'));
  edit.setAttribute('aria-label', `Edit "${t.title}"`);
  edit.addEventListener('click', () => { editingId = t.id; if (opts.onEdit) opts.onEdit(); else renderTasks(); });
  actions.append(edit);

  row.append(check, body);
  if (t.project) row.append(el('span', 't-proj', '# ' + t.project));
  row.append(actions);
  return row;
}

// Inline editor for a task
function taskEditor(t, onClose) {
  const close = () => { editingId = null; if (onClose) onClose(); else renderTasks(); };
  const box = el('form', 'task-edit');
  const title = el('input', 'te-title');
  title.value = t.title;
  title.setAttribute('aria-label', 'Task name');
  const opts = el('div', 'qa-opts');
  const due = el('input'); due.type = 'date'; due.value = t.due || '';
  const pri = el('select');
  [['1', 'P1 · urgent'], ['2', 'P2 · high'], ['3', 'P3 · medium'], ['4', 'P4 · normal']].forEach(([v, l]) => pri.append(new Option(l, v)));
  pri.value = String(t.priority);
  const proj = el('input'); proj.setAttribute('list', 'projList'); proj.value = t.project || ''; proj.size = 10; proj.placeholder = 'none';
  let diffVal = t.difficulty;
  const diffPick = el('div', 'diff-pick');
  diffPick.setAttribute('role', 'radiogroup');
  diffPick.setAttribute('aria-label', 'Difficulty');
  buildDiffPicker(diffPick, () => diffVal, v => { diffVal = v; });

  const lab = (text, input) => { const l = el('label', null, text + ' '); l.append(input); return l; };
  const dwrap = el('div', 'diff-field'); dwrap.append(el('span', null, 'Difficulty'), diffPick);
  opts.append(lab('Due', due), lab('Priority', pri), dwrap, lab('Project', proj));

  const buttons = el('div', 'te-buttons');
  const save = el('button', 'primary small', 'Save'); save.type = 'submit';
  const cancel = el('button', 'small', 'Cancel'); cancel.type = 'button';
  const del = el('button', 'small danger', 'Delete'); del.type = 'button';
  cancel.addEventListener('click', close);
  del.addEventListener('click', () => { editingId = null; deleteTask(t.id); });
  buttons.append(save, cancel, el('span', 'spacer'), del);

  box.addEventListener('submit', e => {
    e.preventDefault();
    const name = title.value.trim();
    if (!name) { title.focus(); return; }
    t.title = name;
    t.due = due.value || null;
    t.priority = Number(pri.value);
    t.difficulty = diffVal;
    t.project = proj.value.trim().replace(/^#/, '');
    saveTasks();
    editingId = null;
    refreshTaskViews();
    if (onClose) onClose();
  });
  box.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  box.append(title, opts, buttons);
  setTimeout(() => title.focus(), 0);
  return box;
}

// Five 1–5 buttons + a label ("Hard")
function buildDiffPicker(container, get, set) {
  container.textContent = '';
  const name = el('span', 'diff-name');
  const paint = () => {
    container.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.v) === get())));
    name.textContent = DIFF_LABEL[get()];
  };
  for (let i = 1; i <= 5; i++) {
    const b = el('button', null, String(i));
    b.type = 'button';
    b.dataset.v = i;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `${i} – ${DIFF_LABEL[i]}`);
    b.addEventListener('click', () => { set(i); paint(); });
    container.append(b);
  }
  container.append(name);
  paint();
  return paint;
}

// ---------------------------------------------------------------- quick add form
let qaParsed = {};
// The picker shows the difficulty that will be saved; clicking it removes a typed d1–d5 shortcut
const qaPaintDiff = buildDiffPicker($('qaDiff'), () => qaParsed.difficulty || qaState.difficulty, v => {
  qaState.difficulty = v;
  const inp = $('qaInput');
  inp.value = (' ' + inp.value + ' ').replace(/\s[dD][1-5](?=\s)/, ' ').replace(/\s+/g, ' ').trimStart();
});

function qaDefaults() {
  qaState = { due: taskView === 'today' ? todayKey() : '', priority: 4, difficulty: 3, project: projFilter || '' };
  syncQaControls(qaState);
}
function syncQaControls(v) {
  $('qaDue').value = v.due || '';
  $('qaPri').value = String(v.priority);
  $('qaProj').value = v.project || '';
  qaPaintDiff();
}
function qaCombined() {
  const parsed = parseQuickAdd($('qaInput').value);
  qaParsed = parsed;
  return {
    title: parsed.title,
    due: parsed.due || qaState.due,
    priority: parsed.priority || qaState.priority,
    difficulty: parsed.difficulty || qaState.difficulty,
    project: parsed.project || qaState.project,
    parsed,
  };
}
function renderQaPreview() {
  const c = qaCombined();
  // controls always show what will be saved (typed shortcuts win over the controls)
  $('qaDue').value = c.due || '';
  $('qaPri').value = String(c.priority);
  $('qaProj').value = c.project || '';
  qaPaintDiff();
  const prev = $('qaPreview');
  prev.textContent = '';
  if (!$('qaInput').value.trim()) return;
  prev.append(el('span', 'chip title', c.title ? `“${c.title}”` : 'Add a task name'));
  if (c.due) prev.append(el('span', 'chip', '📅 ' + fmtDue(c.due)));
  prev.append(el('span', 'chip', 'P' + c.priority));
  const dc = el('span', 'chip'); dc.append(diffDots(c.difficulty), DIFF_LABEL[c.difficulty]); prev.append(dc);
  if (c.project) prev.append(el('span', 'chip', '# ' + c.project));
}

$('qaInput').addEventListener('input', renderQaPreview);
$('qaDue').addEventListener('change', () => { qaState.due = $('qaDue').value; renderQaPreview(); });
$('qaPri').addEventListener('change', () => { qaState.priority = Number($('qaPri').value); renderQaPreview(); });
$('qaProj').addEventListener('change', () => { qaState.project = $('qaProj').value.trim().replace(/^#/, ''); renderQaPreview(); });
$('qaDiff').addEventListener('click', renderQaPreview);

$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const c = qaCombined();
  if (!c.title) { $('qaInput').focus(); toast('Give the task a name'); return; }
  const t = addTask(c);
  $('qaInput').value = '';
  renderQaPreview();
  qaDefaults();
  $('qaInput').focus();
  if (t.due && t.due > todayKey() && taskView === 'today') toast(`Added to ${fmtDue(t.due)}`, 'View', () => setTaskView('upcoming'));
});
$('qaCancel').addEventListener('click', () => {
  $('qaInput').value = '';
  renderQaPreview();
  qaDefaults();
});

// ---------------------------------------------------------------- toolbar
function setTaskView(v) {
  taskView = v;
  editingId = null;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  if (!$('qaInput').value) qaDefaults();
  renderTasks();
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setTaskView(b.dataset.view)));
$('projFilter').addEventListener('change', () => { projFilter = $('projFilter').value; renderTasks(); });

function renderProjectLists() {
  const ps = projects();
  const dl = $('projList');
  dl.textContent = '';
  ps.forEach(p => dl.append(new Option(p)));
  const sel = $('projFilter');
  const cur = projFilter;
  sel.textContent = '';
  sel.append(new Option('All projects', ''));
  ps.forEach(p => sel.append(new Option('# ' + p, p)));
  sel.value = ps.includes(cur) ? cur : '';
  projFilter = sel.value;
  renderSideNav();
}

// ---------------------------------------------------------------- timer link
function setCurrentTask(id) {
  currentTaskId = id && taskById(id) && !taskById(id).done ? id : null;
  try { localStorage.setItem('pomodoro-current-task', currentTaskId || ''); } catch (e) {}
  renderTimerTask();
  if (!$('tasksView').hidden) renderTasks();
}
try { currentTaskId = localStorage.getItem('pomodoro-current-task') || null; } catch (e) {}
if (currentTaskId && (!taskById(currentTaskId) || taskById(currentTaskId).done)) currentTaskId = null;

function renderTimerTask() {
  renderTimerSubs();
  const sel = $('taskSelect');
  if (!sel || document.activeElement === sel) return;   // don't rebuild while the user is choosing
  const today = todayKey();
  const open = sortTasks(tasks.items.filter(t => !t.done));
  sel.textContent = '';
  sel.append(new Option(open.length ? 'No task' : 'No task (add some in Tasks)', ''));
  const add = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    list.forEach(t => g.append(new Option(`${t.title} · ${DIFF_LABEL[t.difficulty]}`, t.id)));
    sel.append(g);
  };
  add('Today & overdue', open.filter(t => t.due && t.due <= today));
  add('Upcoming', open.filter(t => t.due && t.due > today));
  add('No date', open.filter(t => !t.due));
  sel.value = currentTaskId || '';
  $('taskDoneBtn').hidden = !currentTaskId;
}
$('taskSelect').addEventListener('change', () => { setCurrentTask($('taskSelect').value || null); $('taskSelect').blur(); });
$('taskDoneBtn').addEventListener('click', () => { if (currentTaskId) setTaskDone(currentTaskId, true); });
