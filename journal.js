// ================================================================= JOURNAL
// One entry per day: a 1–10 rating of how the day went plus a written blurb.
// Separate from the productivity score. The calendar colors days by this rating:
//   1–3 red · 4–5 orange · 6–8 yellow · 9–10 green

const JOURNAL_KEY = 'pomodoro-journal-v1';
let journal = loadJournal();
let jDate = dayKey(Date.now());
let jRating = null;
let jDirty = false;
let jAutoTimer = null;
let jShowAll = false;

function loadJournal() {
  try {
    const d = JSON.parse(localStorage.getItem(JOURNAL_KEY));
    if (d && d.entries && typeof d.entries === 'object') return d;
  } catch (e) {}
  return { v: 1, entries: {} };
}
function saveJournal() {
  if (typeof Sync !== 'undefined') Sync.stamp('journal');
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal)); } catch (e) {}
}
function restoreJournal(data) {
  journal = data;
  saveJournal();
  jDirty = false;
  if (!$('journalView').hidden) renderJournal();
}
function journalEntry(k) { return journal.entries[k] || null; }

// ---------------------------------------------------------------- rating colors
function moodBand(r) { return r <= 3 ? 'red' : r <= 5 ? 'orange' : r <= 8 ? 'yellow' : 'green'; }
const MOOD_WORD = { red: 'Rough day', orange: 'So-so day', yellow: 'Good day', green: 'Great day' };
const RATING_WORD = ['', 'Awful', 'Really bad', 'Bad', 'Meh', 'Okay', 'Decent', 'Good', 'Really good', 'Great', 'Amazing'];

function moodBadge(r, cls) {
  const b = el('span', `${cls || 'mood-badge'} m-${moodBand(r)}`, `${r}/10`);
  b.title = `Day rating ${r}/10 · ${MOOD_WORD[moodBand(r)]}`;
  return b;
}

// ---------------------------------------------------------------- editor
function buildRatingPicker() {
  const box = $('jRating');
  box.textContent = '';
  for (let i = 1; i <= 10; i++) {
    const b = el('button', `m-${moodBand(i)}`, String(i));
    b.type = 'button';
    b.dataset.v = i;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `${i} out of 10 – ${RATING_WORD[i]}`);
    b.addEventListener('click', () => {
      jRating = i;
      markDirty();
      paintRating();
    });
    box.append(b);
  }
}
function paintRating() {
  $('jRating').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.v) === jRating)));
  const lab = $('jRatingLabel');
  lab.textContent = '';
  if (jRating) lab.append(moodBadge(jRating), ` ${RATING_WORD[jRating]}`);
  else lab.textContent = 'Pick a number from 1 to 10';
}

function loadEditor(k) {
  jDate = k;
  const e = journalEntry(k);
  jRating = e ? e.rating : null;
  $('jText').value = e ? e.text : '';
  $('jDate').value = k;
  $('jDate').max = dayKey(Date.now());
  const today = dayKey(Date.now());
  $('jHeading').textContent = keyToDate(k).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  $('jTitle').textContent = k === today ? 'How was today?'
    : k === shiftKey(today, -1) ? 'How was yesterday?'
    : `How was ${keyToDate(k).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}?`;
  $('jDelete').hidden = !e;
  $('jSave').textContent = e ? 'Update entry' : 'Save entry';
  jDirty = false;
  setStatus(e ? `Saved ${fmtSavedTime(e.updated)}` : '');
  paintRating();
}

function fmtSavedTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return dayKey(d) === dayKey(Date.now())
    ? `at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}
function setStatus(text) { $('jStatus').textContent = text; }

function markDirty() {
  jDirty = true;
  setStatus(jRating ? 'Unsaved changes…' : 'Rate the day to save');
  // auto-save shortly after you stop typing, once the day has a rating
  clearTimeout(jAutoTimer);
  if (jRating) jAutoTimer = setTimeout(() => saveEntry(true), 1500);
}

function saveEntry(auto) {
  clearTimeout(jAutoTimer);
  if (!jRating) {
    if (!auto) { toast('Rate your day from 1 to 10 first'); $('jRating').querySelector('button').focus(); }
    return false;
  }
  const existed = !!journalEntry(jDate);
  journal.entries[jDate] = { rating: jRating, text: $('jText').value.trim(), updated: Date.now() };
  saveJournal();
  jDirty = false;
  $('jDelete').hidden = false;
  $('jSave').textContent = 'Update entry';
  setStatus(`Saved ${fmtSavedTime(Date.now())}`);
  renderJournalLists();
  if (!auto && !existed) toast(`Saved · ${MOOD_WORD[moodBand(jRating)]}`);
  return true;
}

function deleteEntry() {
  const k = jDate;
  const old = journalEntry(k);
  if (!old) return;
  delete journal.entries[k];
  saveJournal();
  loadEditor(k);
  renderJournalLists();
  toast('Entry deleted', 'Undo', () => {
    journal.entries[k] = old;
    saveJournal();
    if (jDate === k) loadEditor(k);
    renderJournalLists();
  });
}

// switching dates keeps what you wrote if it can be saved
function switchDate(k) {
  if (k === jDate) return;
  if (jDirty && jRating) saveEntry(true);
  loadEditor(k);
}

// ---------------------------------------------------------------- lists
function renderJournal() {
  if (!jDirty) loadEditor(jDate);
  renderJournalLists();
}

function renderJournalLists() {
  const today = dayKey(Date.now());

  // last 14 days strip
  const strip = $('jStrip');
  strip.textContent = '';
  const vals = [];
  for (let i = 13; i >= 0; i--) {
    const k = shiftKey(today, -i);
    const e = journalEntry(k);
    const d = keyToDate(k);
    const cell = el('button', 'j-day' + (e ? ` m-${moodBand(e.rating)}` : ' empty') + (k === jDate ? ' sel' : ''));
    cell.type = 'button';
    cell.append(el('b', null, e ? String(e.rating) : '–'), el('span', null, k === today ? 'Today' : WD[d.getDay()].slice(0, 2) + ' ' + d.getDate()));
    cell.setAttribute('aria-label', `${fmtDay(k, today)}: ${e ? `rated ${e.rating} out of 10` : 'no entry'}`);
    cell.title = e ? `${fmtDay(k, today)} · ${e.rating}/10` : `${fmtDay(k, today)} · no entry`;
    cell.addEventListener('click', () => { switchDate(k); renderJournalLists(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    strip.append(cell);
    if (e) vals.push(e.rating);
  }
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
  const last30 = [];
  for (let i = 0; i < 30; i++) { const e = journalEntry(shiftKey(today, -i)); if (e) last30.push(e.rating); }
  const parts = [];
  if (vals.length) parts.push(`14-day avg ${avg(vals)}`);
  if (last30.length) parts.push(`30-day avg ${avg(last30)}`);
  $('jAvg').textContent = parts.join(' · ') || 'No ratings yet';

  // entries, newest first
  const list = $('jList');
  list.textContent = '';
  const keys = Object.keys(journal.entries).sort().reverse();
  if (!keys.length) {
    list.append(el('div', 'task-empty', 'No entries yet. Rate your day and write a few lines above.'));
    return;
  }
  const shown = jShowAll ? keys : keys.slice(0, 20);
  shown.forEach(k => {
    const e = journal.entries[k];
    const item = el('button', `j-entry m-${moodBand(e.rating)}` + (k === jDate ? ' sel' : ''));
    item.type = 'button';
    const head = el('div', 'j-entry-head');
    head.append(el('b', null, fmtDay(k, today)), moodBadge(e.rating));
    item.append(head, el('p', 'j-entry-text', e.text || 'No notes'));
    item.addEventListener('click', () => { switchDate(k); renderJournalLists(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    list.append(item);
  });
  if (keys.length > shown.length) {
    const more = el('button', 'small', `Show all ${keys.length} entries`);
    more.type = 'button';
    more.style.marginTop = '10px';
    more.addEventListener('click', () => { jShowAll = true; renderJournalLists(); });
    list.append(more);
  }
}

// open the journal on a given day (used by the calendar)
function openJournal(k) {
  jDate = k;
  jDirty = false;
  showTab('journal');
  setTimeout(() => $('jText').focus(), 0);
}

// ---------------------------------------------------------------- events
buildRatingPicker();
$('jText').addEventListener('input', markDirty);
$('jDate').addEventListener('change', () => {
  const k = $('jDate').value;
  if (!k) { $('jDate').value = jDate; return; }
  if (k > dayKey(Date.now())) { toast("You can't journal about a future day yet"); $('jDate').value = jDate; return; }
  switchDate(k);
  renderJournalLists();
});
$('jForm').addEventListener('submit', e => { e.preventDefault(); saveEntry(false); });
$('jText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEntry(false); } });
$('jDelete').addEventListener('click', deleteEntry);
window.addEventListener('pagehide', () => { if (jDirty && jRating) saveEntry(true); });
