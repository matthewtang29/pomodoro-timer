// ================================================================= CALENDAR
// Month view: each day shows its productivity score (color = score band) and the
// tasks due that day. Clicking a day opens its details below the grid.

let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let calSelected = dayKey(Date.now());
let calMode = 'both';   // what the calendar colors: 'both', 'score' (productivity) or 'mood' (journal rating)
try { const m = localStorage.getItem('pomodoro-calmode'); if (['both', 'score', 'mood'].includes(m)) calMode = m; } catch (e) {}
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function tasksDueOn(k) {
  return sortTasks(tasks.items.filter(t => t.due === k));
}

function renderCalendar() {
  const today = dayKey(Date.now());
  $('calTitle').textContent = `${MONTH_NAMES[calMonth.getMonth()]} ${calMonth.getFullYear()}`;
  document.querySelectorAll('[data-calmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.calmode === calMode)));
  $('legendScore').hidden = calMode === 'mood';
  $('legendMood').hidden = calMode === 'score';
  const grid = $('calGrid');
  grid.textContent = '';
  DOW.forEach(d => grid.append(el('div', 'cal-dow', d)));

  // start on the Monday on/before the 1st; show whole weeks
  const start = new Date(calMonth);
  start.setDate(1 - ((calMonth.getDay() + 6) % 7));
  const last = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0);
  const cells = Math.ceil((((calMonth.getDay() + 6) % 7) + last.getDate()) / 7) * 7;

  for (let i = 0; i < cells; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = dayKey(d);
    const inMonth = d.getMonth() === calMonth.getMonth();
    const cell = el('button', 'cal-cell' + (inMonth ? '' : ' out') + (k === today ? ' today' : '') + (k === calSelected ? ' sel' : ''));
    cell.type = 'button';

    const top = el('div', 'c-top');
    top.append(el('span', 'c-date', String(d.getDate())));
    const badges = el('span', 'c-badges');
    const sc = calMode !== 'mood' ? dayScore(k) : null;
    const je = calMode !== 'score' && typeof journalEntry === 'function' ? journalEntry(k) : null;
    if (je) {
      cell.classList.add('mood', `m-${moodBand(je.rating)}`);
      const mb = moodBadge(je.rating, 'c-mood');
      mb.textContent = String(je.rating);
      mb.append(el('small', 'of10', '/10'));   // hidden on narrow screens
      badges.append(mb);
    }
    if (sc) badges.append(scoreBadge(sc.score, 'c-score'));
    top.append(badges);
    cell.append(top);

    const due = tasksDueOn(k);
    due.slice(0, 3).forEach(t => {
      const row = el('div', 'c-task' + (t.done ? ' done' : ''));
      const dot = el('i');
      dot.style.background = `var(--p${t.priority})`;
      row.append(dot, t.title);
      cell.append(row);
    });
    if (due.length > 3) cell.append(el('div', 'c-more', `+${due.length - 3} more`));
    if (due.length) {
      const dots = el('div', 'c-dots');
      due.slice(0, 6).forEach(t => { const i2 = el('i'); i2.style.background = t.done ? 'var(--line)' : `var(--p${t.priority})`; dots.append(i2); });
      cell.append(dots);
    }

    const label = [d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })];
    if (je) label.push(`day rated ${je.rating} out of 10`);
    if (sc) label.push(`productivity score ${sc.score}`);
    if (due.length) label.push(`${due.length} task${due.length > 1 ? 's' : ''} due`);
    cell.setAttribute('aria-label', label.join(', '));
    cell.setAttribute('aria-pressed', String(k === calSelected));
    cell.addEventListener('click', () => {
      calSelected = k;
      editingId = null;
      if (!inMonth) calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      renderCalendar();
    });
    grid.append(cell);
  }
  renderCalDay();
}

function renderCalDay() {
  const k = calSelected;
  const today = dayKey(Date.now());
  const box = $('calDay');
  box.textContent = '';
  const d = keyToDate(k);

  const head = el('div', 'day-head');
  head.append(el('h3', null, d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })));
  const sc = dayScore(k);
  if (sc) {
    const s = el('span', 'score-label');
    s.append('Score ', scoreBadge(sc.score));
    head.append(s);
  } else if (k > today) {
    head.append(el('span', 'score-label', 'Upcoming'));
  }
  box.append(head);

  // journal entry for the day
  const je = typeof journalEntry === 'function' ? journalEntry(k) : null;
  if (je || k <= today) {
    const jbox = el('div', 'day-journal' + (je ? ` m-${moodBand(je.rating)}` : ''));
    const jh = el('div', 'day-journal-head');
    const jt = el('b', null, 'Journal');
    jh.append(jt);
    if (je) jh.append(moodBadge(je.rating));
    const jbtn = el('button', 'small', je ? 'Edit' : 'Write about this day');
    jbtn.type = 'button';
    jbtn.addEventListener('click', () => openJournal(k));
    jh.append(jbtn);
    jbox.append(jh);
    if (je && je.text) jbox.append(el('p', 'day-journal-text', je.text));
    box.append(jbox);
  }

  const day = peekDay(k);
  if (deskOf(day) >= 1) {
    const stats = el('div', 'day-stats');
    [['Desk time', fmtSecs(deskOf(day))], ['Focused', fmtSecs(day.focus)], ['Break', fmtSecs(day.brk)], ['Focus blocks', String(day.blocks)]]
      .forEach(([l, v]) => { const c = el('div'); c.append(el('b', null, v), el('span', null, l)); stats.append(c); });
    box.append(stats);
  }
  if (sc) {
    const parts = el('div', 'score-parts');
    parts.style.marginTop = '12px';
    renderScoreParts(parts, sc);
    box.append(parts);
  }

  // tasks due that day
  const due = tasksDueOn(k);
  box.append(el('h4', 'day-sub', due.length ? `Tasks due (${due.filter(t => t.done).length}/${due.length} done)` : 'Tasks due'));
  if (!due.length) box.append(el('div', 'task-empty', k < today ? 'No tasks were due this day.' : 'Nothing due yet.'));
  due.forEach(t => box.append(t.id === editingId
    ? taskEditor(t, renderCalendar)
    : taskRow(t, { hideDue: true, onEdit: renderCalendar })));

  // tasks finished that day but due another day
  const extra = tasks.items.filter(t => t.done && dayKey(t.done) === k && t.due !== k);
  if (extra.length) {
    box.append(el('h4', 'day-sub', 'Also finished'));
    extra.forEach(t => box.append(taskRow(t, { onEdit: renderCalendar })));
  }

  // quick add for this day
  if (k >= today) {
    const form = el('form', 'day-add');
    const input = el('input');
    input.placeholder = `Add a task for ${fmtDue(k)}… (p1 d4 #course work too)`;
    input.setAttribute('aria-label', 'New task for this day');
    const btn = el('button', 'small primary', 'Add');
    btn.type = 'submit';
    form.append(input, btn);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const p = parseQuickAdd(input.value);
      if (!p.title) return;
      addTask({ title: p.title, due: p.due || k, priority: p.priority, difficulty: p.difficulty, project: p.project });
      renderCalendar();
      setTimeout(() => { const i = $('calDay').querySelector('.day-add input'); if (i) i.focus(); }, 0);
    });
    box.append(form);
  }

  // sessions
  if ((day.sessions || []).length) {
    box.append(el('h4', 'day-sub', 'Sessions'));
    const ul = el('ul', 'sessions');
    renderSessions(day, ul, '');
    box.append(ul);
  }
}

$('calPrev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
$('calNext').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });
$('calToday').addEventListener('click', () => {
  const d = new Date();
  calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  calSelected = dayKey(d);
  renderCalendar();
});

document.querySelectorAll('[data-calmode]').forEach(b => b.addEventListener('click', () => {
  calMode = b.dataset.calmode;
  try { localStorage.setItem('pomodoro-calmode', calMode); } catch (e) {}
  renderCalendar();
}));
