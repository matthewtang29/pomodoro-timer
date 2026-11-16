// ================================================================= JOURNAL
// One entry per day: an optional 1–10 rating of how the day went plus a written blurb.
// Separate from the productivity score. The calendar colors days by this rating:
//   1–3 red · 4–5 orange · 6–8 yellow · 9–10 green

const JOURNAL_KEY = 'pomodoro-journal-v1';
let journal = loadJournal();
let jDate = dayKey(Date.now());
let jRating = null;     // low end of the rating (or the only value)
let jHigh = null;       // high end when the day is rated as a range, e.g. 4–7
let jRange = false;     // range mode in the picker
let jRangeStart = null; // first click of a range, waiting for the second
let jDirty = false;
let jAutoTimer = null;
let jShowAll = false;

// drop anything that isn't an entry object, so a bad backup or old data can't crash rendering
function cleanEntries(entries) {
  const out = {};
  for (const [k, e] of Object.entries(entries || {})) if (e && typeof e === 'object' && !Array.isArray(e)) out[k] = e;
  return out;
}
function loadJournal() {
  try {
    const d = JSON.parse(localStorage.getItem(JOURNAL_KEY));
    if (isPlainObj(d) && isPlainObj(d.entries)) { d.entries = cleanEntries(d.entries); return d; }
  } catch (e) {}
  return { v: 1, entries: {} };
}
function saveJournal() {
  if (typeof Sync !== 'undefined') Sync.stamp('journal');
  safeSetItem(JOURNAL_KEY, JSON.stringify(journal));
}
function restoreJournal(data) {
  data.entries = cleanEntries(data.entries);
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

// The rating is optional: an entry can be written but not rated (rating null).
function isRated(e) { return !!e && Number.isFinite(e.rating); }
// An entry's rating as low/high (same number when it isn't a range); null when unrated
function ratingLo(e) { return isRated(e) ? e.rating : null; }
function ratingHi(e) { return !isRated(e) ? null : e.ratingHigh > e.rating ? e.ratingHigh : e.rating; }
function ratingMid(e) { return isRated(e) ? (ratingLo(e) + ratingHi(e)) / 2 : null; }
function ratingText(lo, hi) { return lo == null ? '' : hi && hi !== lo ? `${lo}–${hi}` : String(lo); }
// worth keeping: a rating, some text, or (later) videos
function entryHasContent(e) {
  return isRated(e) || (typeof e.text === 'string' && e.text.trim() !== '') || (Array.isArray(e.videos) && e.videos.length > 0);
}

// Puts the range's colors on an element: class m-<low band> sets --m, and --m2 is the high end's color.
// No rating gets the neutral m-none.
function paintMood(node, lo, hi) {
  if (lo == null) { node.classList.add('m-none'); return node; }
  node.classList.add(`m-${moodBand(lo)}`);
  if (hi && hi !== lo) {
    node.classList.add('m-range');
    node.style.setProperty('--m2', `var(--m-${moodBand(hi)})`);
    node.style.setProperty('--m2-ink', `var(--m-${moodBand(hi)}-ink)`);
  }
  return node;
}

function moodBadge(r, cls, hi) {
  if (r == null) return el('span', 'j-unrated', 'Not rated');
  const b =paintMood(el('span', cls || 'mood-badge', `${ratingText(r, hi)}/10`), r, hi);
  b.title = hi && hi !== r
    ? `Day rating ${r}–${hi}/10 · ${MOOD_WORD[moodBand(r)]} to ${MOOD_WORD[moodBand(hi)].toLowerCase()}`
    : `Day rating ${r}/10 · ${MOOD_WORD[moodBand(r)]}`;
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
      if (!jRange) {
        jRating = i; jHigh = null;
      } else if (jRangeStart == null) {
        // first click of a range: wait for the other end
        jRangeStart = i; jRating = i; jHigh = null;
      } else {
        jRating = Math.min(jRangeStart, i); jHigh = Math.max(jRangeStart, i);
        if (jHigh === jRating) jHigh = null;
        jRangeStart = null;
      }
      markDirty();
      paintRating();
    });
    box.append(b);
  }
}
function setRangeMode(on) {
  jRange = on;
  jRangeStart = null;
  $('jRangeBtn').setAttribute('aria-pressed', String(on));
  if (!on && jHigh) { jHigh = null; markDirty(); }
  paintRating();
}
function paintRating() {
  const hi = jHigh || jRating;
  $('jRating').querySelectorAll('button').forEach(b => {
    const v = Number(b.dataset.v);
    b.setAttribute('aria-checked', String(v === jRating || v === jHigh));
    b.classList.toggle('in-range', !!jHigh && v > jRating && v < jHigh);
  });
  $('jClearRating').hidden = !jRating;
  const lab = $('jRatingLabel');
  lab.textContent = '';
  if (jRange && jRangeStart != null) lab.append(moodBadge(jRating), ' Now pick the other end');
  else if (jRating && jHigh) lab.append(moodBadge(jRating, null, jHigh), ` ${RATING_WORD[jRating]} to ${RATING_WORD[hi].toLowerCase()}`);
  else if (jRating) lab.append(moodBadge(jRating), ` ${RATING_WORD[jRating]}`);
  else lab.textContent = jRange ? 'Pick the low end, then the high end' : 'Optional: pick a number from 1 to 10';
}
function clearRating() {
  jRating = null; jHigh = null; jRangeStart = null;
  markDirty();
  paintRating();
}

function loadEditor(k) {
  jDate = k;
  const e = journalEntry(k);
  jRating = e ? ratingLo(e) : null;
  jHigh = e && ratingHi(e) !== ratingLo(e) ? ratingHi(e) : null;
  jRange = !!jHigh;
  jRangeStart = null;
  $('jRangeBtn').setAttribute('aria-pressed', String(jRange));
  $('jText').value = e && typeof e.text === 'string' ? e.text : '';
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
  setStatus('Unsaved changes…');
  // auto-save shortly after you stop typing (not while half-way through picking a range)
  clearTimeout(jAutoTimer);
  if (jRangeStart == null) jAutoTimer = setTimeout(() => saveEntry(true), 1500);
}

// Saves the editor into the day's entry. Only the fields the editor owns are touched, so
// anything else on the entry (e.g. videos) is kept. An entry left with nothing in it is deleted.
function saveEntry(auto) {
  clearTimeout(jAutoTimer);
  const k = jDate;
  const old = journalEntry(k);
  const next = { ...(old || {}), rating: jRating || null, text: $('jText').value.trim(), updated: Date.now() };
  if (jHigh && jHigh > jRating) next.ratingHigh = jHigh; else delete next.ratingHigh;

  if (!entryHasContent(next)) {
    jDirty = false;
    if (old) { deleteEntry(); return true; }
    setStatus('');
    if (!auto) { toast('Write something or rate the day first'); $('jText').focus(); }
    return false;
  }
  // update in place: the entry object stays the same one other code may hold
  const e = old || (journal.entries[k] = {});
  Object.assign(e, next);
  if (!('ratingHigh' in next)) delete e.ratingHigh;
  saveJournal();
  jDirty = false;
  if (k === jDate) {
    $('jDelete').hidden = false;
    $('jSave').textContent = 'Update entry';
    setStatus(`Saved ${fmtSavedTime(e.updated)}`);
  }
  renderJournalLists();
  if (!auto && !old) toast(isRated(e) ? `Saved · ${MOOD_WORD[moodBand(ratingMid(e))]}` : 'Saved');
  return true;
}
// save unsaved edits now (leaving the tab or date, closing the app)
function flushJournal() { if (jDirty) saveEntry(true); }

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

// switching dates keeps what you wrote
function switchDate(k) {
  if (k === jDate) return;
  flushJournal();
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
    const cell = el('button', 'j-day' + (e ? '' : ' empty') + (k === jDate ? ' sel' : ''));
    if (e) paintMood(cell, ratingLo(e), ratingHi(e));
    cell.type = 'button';
    const txt = ratingText(ratingLo(e), ratingHi(e));
    const what = !e ? 'no entry' : isRated(e) ? `rated ${txt} out of 10` : 'written, not rated';
    cell.append(el('b', null, !e ? '–' : isRated(e) ? txt : '✎'), el('span', null, k === today ? 'Today' : WD[d.getDay()].slice(0, 2) + ' ' + d.getDate()));
    cell.setAttribute('aria-label', `${fmtDay(k, today)}: ${what}`);
    cell.title = `${fmtDay(k, today)} · ${isRated(e) ? `${txt}/10` : what}`;
    cell.addEventListener('click', () => { switchDate(k); renderJournalLists(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    strip.append(cell);
    if (isRated(e)) vals.push(ratingMid(e));
  }
  // a range counts as its midpoint in the averages; unrated entries are left out
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
  const last30 = [];
  for (let i = 0; i < 30; i++) { const e = journalEntry(shiftKey(today, -i)); if (isRated(e)) last30.push(ratingMid(e)); }
  const parts = [];
  if (vals.length) parts.push(`14-day avg ${avg(vals)}`);
  if (last30.length) parts.push(`30-day avg ${avg(last30)}`);
  $('jAvg').textContent = parts.join(' · ') || 'No ratings yet';

  // entries, newest first
  const list = $('jList');
  list.textContent = '';
  const keys = Object.keys(journal.entries).sort().reverse();
  if (!keys.length) {
    list.append(el('div', 'task-empty', 'No entries yet. Write a few lines or rate your day above.'));
    return;
  }
  const shown = jShowAll ? keys : keys.slice(0, 20);
  shown.forEach(k => {
    const e = journal.entries[k];
    const item = paintMood(el('button', 'j-entry' + (k === jDate ? ' sel' : '')), ratingLo(e), ratingHi(e));
    item.type = 'button';
    const head = el('div', 'j-entry-head');
    head.append(el('b', null, fmtDay(k, today)), moodBadge(ratingLo(e), null, ratingHi(e)));
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
  flushJournal();
  jDate = k;
  jDirty = false;
  showTab('journal');
  setTimeout(() => $('jText').focus(), 0);
}

// ---------------------------------------------------------------- events
buildRatingPicker();
$('jRangeBtn').addEventListener('click', () => setRangeMode(!jRange));
$('jClearRating').addEventListener('click', clearRating);
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
window.addEventListener('pagehide', flushJournal);
// phones often background the app without a pagehide
document.addEventListener('visibilitychange', () => { if (document.hidden) flushJournal(); });
