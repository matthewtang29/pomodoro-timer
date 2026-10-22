// ================================================================= SCORING
// Session score: how productive one timer session was.
// Daily score:   focus time vs goal + difficulty-weighted tasks done + session quality.
// "How the score works" on the Analytics tab explains the same rules to the user.

const DIFF_LABEL = ['', 'Easy', 'Light', 'Moderate', 'Hard', 'Intense'];
const NEUTRAL_DIFFICULTY = 2.5;   // used for focus time not linked to a task

let focusGoalMin = 120;
try {
  const g = Number(localStorage.getItem('pomodoro-goal'));
  if (g >= 30 && g <= 600) focusGoalMin = g;
} catch (e) {}

function setFocusGoal(min) {
  focusGoalMin = min;
  if (typeof Sync !== 'undefined') Sync.stampMeta();
  try { localStorage.setItem('pomodoro-goal', String(min)); } catch (e) {}
}

// ---------------------------------------------------------------- one session
// Returns null for sessions too short to judge (under a minute of focus).
function sessionScore(s) {
  if (!s || (s.focus || 0) < 60) return null;
  const fMin = s.focusMin || 25;
  const bMin = s.breakMin || 5;
  const plannedFocus = s.mode === 'AUTO' ? null : fMin * 60 * (s.cycles || 1);

  // 1. Completion: finished the plan, or finished a task during it
  let completion;
  if ((s.tasksDone || []).length || s.outcome === 'completed') completion = 1;
  else if (plannedFocus) completion = Math.min(1, s.focus / plannedFocus);
  else completion = (s.blocks || 0) / ((s.blocks || 0) + 1);   // auto mode, exited mid-cycle

  // 2. Efficiency: focus share of desk time, relative to what the focus/break plan allows
  const planRatio = fMin / (fMin + bMin);
  const efficiency = s.desk > 0 ? Math.min(1, (s.focus / s.desk) / planRatio) : 0;

  // 3. Intensity: focus-time-weighted difficulty of the tasks worked on
  const work = s.work || {};
  const diffs = s.diffs || {};
  let linked = 0, weighted = 0;
  for (const id in work) {
    linked += work[id];
    weighted += work[id] * (diffs[id] || NEUTRAL_DIFFICULTY);
  }
  const unlinked = Math.max(0, s.focus - linked);
  const avgDiff = (weighted + unlinked * NEUTRAL_DIFFICULTY) / Math.max(1, linked + unlinked);
  const intensity = avgDiff / 5;

  const score = Math.round(100 * (0.45 * completion + 0.35 * efficiency + 0.20 * intensity));
  return { score, completion, efficiency, intensity, avgDiff };
}

// ---------------------------------------------------------------- one day
function taskStatsForDay(k) {
  const items = (typeof tasks !== 'undefined' ? tasks.items : []);
  const planned = items.filter(t => t.due === k || (t.done && dayKey(t.done) === k));
  const isDone = t => t.done && dayKey(t.done) <= k;
  const plannedPts = planned.reduce((a, t) => a + t.difficulty, 0);
  const donePts = planned.filter(isDone).reduce((a, t) => a + t.difficulty, 0);
  return { count: planned.length, doneCount: planned.filter(isDone).length, plannedPts, donePts };
}

// Returns { score, parts: [...] } or null when there's nothing to score (no focus, no tasks)
function dayScore(k) {
  if (k > dayKey(Date.now())) return null;
  const d = peekDay(k);
  const ts = taskStatsForDay(k);
  if (d.focus < 60 && ts.plannedPts === 0) return null;

  const parts = [];
  const goal = focusGoalMin * 60;
  parts.push({
    key: 'focus', label: 'Focus time', weight: 40,
    value: Math.min(1, d.focus / goal),
    detail: `${fmtSecs(d.focus)} of ${fmtDuration(focusGoalMin)} goal`,
  });

  parts.push(ts.plannedPts > 0
    ? { key: 'tasks', label: 'Tasks done', weight: 30, value: ts.donePts / ts.plannedPts,
        detail: `${ts.doneCount} of ${ts.count} · ${ts.donePts}/${ts.plannedPts} difficulty pts` }
    : { key: 'tasks', label: 'Tasks done', weight: 30, value: null, detail: 'No tasks due' });

  let wsum = 0, fsum = 0, n = 0;
  (d.sessions || []).forEach(s => {
    const r = sessionScore(s);
    if (r) { wsum += r.score * s.focus; fsum += s.focus; n++; }
  });
  parts.push(n
    ? { key: 'sessions', label: 'Session quality', weight: 30, value: wsum / fsum / 100,
        detail: `avg ${Math.round(wsum / fsum)} over ${n} session${n > 1 ? 's' : ''}` }
    : { key: 'sessions', label: 'Session quality', weight: 30, value: null, detail: 'No sessions' });

  const used = parts.filter(p => p.value != null);
  const totalW = used.reduce((a, p) => a + p.weight, 0);
  const score = Math.round(100 * used.reduce((a, p) => a + p.weight * p.value, 0) / totalW);
  return { score, parts };
}

function scoreBucket(score) { return Math.min(5, Math.floor(score / 20) + 1); }   // 1..5

// Colored badge for a score (ramp color + readable ink)
function scoreBadge(score, cls) {
  const b = el('span', cls || 'score-badge', String(score));
  const q = scoreBucket(score);
  b.style.background = `var(--q${q})`;
  b.style.color = `var(--q${q}-ink)`;
  return b;
}

// Meter rows used on the Analytics score card and the Calendar day panel
function renderScoreParts(container, result) {
  container.textContent = '';
  if (!result) return;
  result.parts.forEach(p => {
    const row = el('div', 'meter-row' + (p.value == null ? ' off' : ''));
    const head = el('div', 'm-head');
    const left = el('b', null, `${p.label}`);
    const right = el('span', null, p.value == null ? p.detail : `${Math.round(p.value * 100)}% · ${p.detail}`);
    head.append(left, right);
    const meter = el('div', 'meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', p.label);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(Math.round((p.value || 0) * 100)));
    const fill = el('i');
    fill.style.width = `${Math.round((p.value || 0) * 100)}%`;
    meter.append(fill);
    row.append(head, meter);
    container.append(row);
  });
}
