// ================================================================= TODAY
// One page that sums up the day and the week before it: focus, score, tasks due,
// last night's sleep, and the past 7 days of focus, sleep, habits and day ratings.
// Everything here is read from the other pages' data; habits can be ticked off
// right here, and tasks due today can be checked.

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

  // ---------------- tasks due today (and overdue)
  const tl = $('dbTaskList');
  tl.textContent = '';
  const due = sortTasks(open).slice(0, 6);
  $('dbTasksEmpty').hidden = due.length > 0;
  $('dbTasksEmpty').textContent = doneToday.length ? 'Everything due today is done.' : 'Nothing due today.';
  due.forEach(t => {
    const row = el('div', 'db-task');
    const chk = el('button', 'db-check');
    chk.type = 'button';
    chk.setAttribute('aria-label', `Mark “${t.title}” done`);
    chk.addEventListener('click', () => { setTaskDone(t.id, true); renderDashboard(); });
    const meta = t.due < today ? 'overdue' : DIFF_LABEL[t.difficulty] || '';
    row.append(chk, el('span', 'db-ttitle', t.title), el('span', 'db-tmeta' + (t.due < today ? ' overdue' : ''), meta));
    tl.append(row);
  });
  $('dbTasksMore').hidden = open.length <= due.length;
  $('dbTasksMore').textContent = `+${open.length - due.length} more`;

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

document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.goto)));
