// ================================================================= SLEEP
// One entry per night, filed under the morning you woke up:
//   sleepLog.entries['YYYY-MM-DD'] = { bed: 'HH:MM', wake: 'HH:MM', quality: 1–5 | null }
// The Calendar shows each night's hours on the day you woke up.
// Each night syncs as its own cloud document (users/{uid}/sleep/{date}).

const SLEEP_KEY = 'pomodoro-sleep-v1';
const SLEEP_GOOD_MIN = 7 * 60;   // 7h+ shows green, less shows peach
const QUALITY_WORD = ['', 'Awful', 'Poor', 'Okay', 'Good', 'Great'];
let sleepLog = loadSleep();
let sDate = dayKey(Date.now());
let sQuality = null;

function loadSleep() {
  try {
    const d = JSON.parse(localStorage.getItem(SLEEP_KEY));
    if (d && d.entries && typeof d.entries === 'object') return d;
  } catch (e) {}
  return { entries: {} };
}
function saveSleep() {
  if (typeof Sync !== 'undefined') Sync.stamp('sleep');
  try { localStorage.setItem(SLEEP_KEY, JSON.stringify(sleepLog)); } catch (e) {}
}
function restoreSleep(data) {
  sleepLog = { entries: { ...data.entries } };
  saveSleep();
  if (!$('sleepView').hidden) renderSleep();
}

function sleepEntry(k) { return sleepLog.entries[k] || null; }
function toMin(hhmm) { const [h, m] = String(hhmm || '').split(':').map(Number); return h * 60 + m; }
// minutes asleep; bedtime after the wake time means it was the evening before
function sleepMinutes(e) {
  if (!e || !e.bed || !e.wake) return 0;
  return (toMin(e.wake) - toMin(e.bed) + 1440) % 1440;
}
function fmtSleep(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${pad2(m)}m` : `${h}h`;
}
function fmtSleepShort(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${pad2(m)}` : `${h}h`;
}
function fmtTimeOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function sleepCls(min) { return min >= SLEEP_GOOD_MIN ? 'good' : 'short'; }

// ---------------------------------------------------------------- editor
function loadSleepEditor(k) {
  sDate = k;
  $('sDate').value = k;
  $('sDate').max = todayKey();
  const e = sleepEntry(k);
  // a new night starts from the last times you logged
  const last = e || Object.keys(sleepLog.entries).sort().reverse().map(sleepEntry)[0];
  $('sBed').value = last ? last.bed : '23:00';
  $('sWake').value = last ? last.wake : '07:00';
  sQuality = e ? e.quality || null : null;
  $('sDelete').hidden = !e;
  $('sSave').textContent = e ? 'Update' : 'Save night';
  $('sNight').textContent = nightLabel(k);
  paintSleepEditor();
}
function nightLabel(k) {
  const wake = keyToDate(k), bed = keyToDate(shiftKey(k, -1));
  const f = d => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `Night of ${f(bed)} → ${f(wake)}`;
}
function paintSleepEditor() {
  const min = sleepMinutes({ bed: $('sBed').value, wake: $('sWake').value });
  const dur = $('sDur');
  dur.textContent = $('sBed').value && $('sWake').value ? fmtSleep(min) : '—';
  dur.className = 's-dur ' + sleepCls(min);
  document.querySelectorAll('#sQuality button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.q) === sQuality)));
}

function saveSleepEntry() {
  const k = $('sDate').value || sDate;
  if (!$('sBed').value || !$('sWake').value) { toast('Set a bedtime and a wake-up time'); return; }
  if (k > todayKey()) { toast("That night hasn't happened yet"); return; }
  sleepLog.entries[k] = { bed: $('sBed').value, wake: $('sWake').value, quality: sQuality };
  saveSleep();
  toast(`Saved ${fmtSleep(sleepMinutes(sleepLog.entries[k]))} of sleep`);
  renderSleep();
}
function deleteSleepEntry() {
  const k = sDate;
  const old = sleepLog.entries[k];
  if (!old) return;
  delete sleepLog.entries[k];
  saveSleep();
  renderSleep();
  toast('Night deleted', 'Undo', () => { sleepLog.entries[k] = old; saveSleep(); renderSleep(); });
}

// ---------------------------------------------------------------- page
function renderSleep() {
  loadSleepEditor(sDate);
  const today = todayKey();

  // averages
  const avgOver = n => {
    const v = [];
    for (let i = 0; i < n; i++) { const e = sleepEntry(shiftKey(today, -i)); if (e) v.push(sleepMinutes(e)); }
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const a7 = avgOver(7), a30 = avgOver(30);
  $('sleepSub').textContent = a7 != null
    ? `Average ${fmtSleep(a7)} over the last 7 nights` + (a30 != null && a30 !== a7 ? ` · ${fmtSleep(a30)} over 30` : '')
    : 'Log last night to get started';

  // last 14 nights as bars
  const chart = $('sleepChart');
  chart.textContent = '';
  const maxMin = 11 * 60;
  for (let i = 13; i >= 0; i--) {
    const k = shiftKey(today, -i);
    const e = sleepEntry(k);
    const min = sleepMinutes(e);
    const col = el('button', 'sc-col' + (k === sDate ? ' sel' : ''));
    col.type = 'button';
    const bar = el('i', 'sc-bar ' + (e ? sleepCls(min) : 'none'));
    if (e) bar.style.height = Math.max(4, Math.min(100, min / maxMin * 100)) + '%';
    const d = keyToDate(k);
    col.append(el('span', 'sc-val', e ? fmtSleepShort(min) : ''), el('span', 'sc-track', null), el('span', 'sc-day', i === 0 ? 'Today' : WD[d.getDay()].charAt(0) + ' ' + d.getDate()));
    col.querySelector('.sc-track').append(bar);
    col.setAttribute('aria-label', `${fmtDay(k, today)}: ${e ? fmtSleep(min) + ' of sleep' : 'not logged'}`);
    col.addEventListener('click', () => { sDate = k; renderSleep(); });
    chart.append(col);
  }

  // recent nights
  const list = $('sleepList');
  list.textContent = '';
  const keys = Object.keys(sleepLog.entries).sort().reverse().slice(0, 30);
  $('sleepEmpty').hidden = keys.length > 0;
  keys.forEach(k => {
    const e = sleepEntry(k);
    const min = sleepMinutes(e);
    const row = el('button', 's-row' + (k === sDate ? ' sel' : ''));
    row.type = 'button';
    row.append(
      el('b', null, fmtDay(k, today)),
      el('span', 's-times', `${fmtTimeOfDay(e.bed)} – ${fmtTimeOfDay(e.wake)}`),
      el('span', 's-q', e.quality ? QUALITY_WORD[e.quality] : ''),
      el('span', 's-badge ' + sleepCls(min), fmtSleep(min)),
    );
    row.addEventListener('click', () => { sDate = k; renderSleep(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    list.append(row);
  });
}

// from the Calendar's day panel
function openSleep(k) {
  sDate = k;
  showTab('sleep');
  $('sBed').focus();
}

// ---------------------------------------------------------------- controls
QUALITY_WORD.slice(1).forEach((w, i) => {
  const b = el('button', null, w);
  b.type = 'button';
  b.dataset.q = String(i + 1);
  b.addEventListener('click', () => { sQuality = sQuality === i + 1 ? null : i + 1; paintSleepEditor(); });
  $('sQuality').append(b);
});
$('sBed').addEventListener('input', paintSleepEditor);
$('sWake').addEventListener('input', paintSleepEditor);
$('sDate').addEventListener('change', () => { if ($('sDate').value) { sDate = $('sDate').value; renderSleep(); } });
$('sleepForm').addEventListener('submit', e => { e.preventDefault(); saveSleepEntry(); });
$('sDelete').addEventListener('click', deleteSleepEntry);
