// ================================================================= DESK-ROBOT TASK SYNC
// Sends the top 4 dated, unfinished tasks to the desk robot's OLED TASKS screen.
//
// Board protocol (on top of the timer's commands, which are unchanged):
//   app -> board   TASKS CLR          clear the list (always first; also marks the board synced)
//                  TASK <due> <title> due <= 5 chars, no spaces; title cut at 15; max 4
//                  PING               keep-alive (the board shows "no link" after 15 s of silence)
//   board -> app   EVENT SYNC         "send me everything" (boot, every 5 s until TASKS CLR, after a timeout)
//                  EVENT ALERT_ACK    user dismissed an alert (logged only)
//
// Nothing is sent until the board has said EVENT SYNC on this connection. The plain
// Pomodoro timer speaks the same protocol but doesn't know these lines, so it never
// gets them (it would answer ERR UNKNOWN to each one).
//
// Transport-agnostic: attach() takes a writeLine(line) function. app.js passes one that
// goes through the serial write queue; a BLE writer can be passed the same way later.
// Loads standalone (no other app file is needed until it actually syncs), so tests.html
// can test the pure functions on their own.

const BoardSync = (() => {
  const DAY = 86400000;
  const MAX_TASKS = 4;
  const PING_MS = 10000;
  const RELABEL_MS = 60000;
  const CHANGE_DEBOUNCE_MS = 150;   // several saves in a row (e.g. a repeating task) -> one send

  const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // Tasks store due dates as 'YYYY-MM-DD' (local calendar day). Parse as local midnight:
  // new Date('2026-11-14') would be UTC midnight, i.e. the evening before in the Americas.
  function parseDue(due) {
    if (due instanceof Date) return due;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function dueLabel(due, now = new Date()) {
    due = parseDue(due);
    // Math.round absorbs the 23 h / 25 h days at daylight-saving changes
    const days = Math.round((midnight(due) - midnight(now)) / DAY);
    if (days < 0) return 'Late';
    if (days === 0) return 'Today';
    if (days === 1) return 'Tmrw';
    if (days < 7) return due.toLocaleDateString('en-US', { weekday: 'short' });
    return `${due.getMonth() + 1}/${due.getDate()}`;
  }

  // printable ASCII only, trimmed, max 15 chars ('-' if nothing is left)
  const cleanTitle = s => String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').trim().slice(0, 15).trim() || '-';

  function taskLines(items, now = new Date()) {
    const top = (items || [])
      .filter(t => t && !t.done && parseDue(t.due))
      .sort((a, b) => parseDue(a.due) - parseDue(b.due) || (a.created || 0) - (b.created || 0))
      .slice(0, MAX_TASKS);
    return ['TASKS CLR', ...top.map(t => `TASK ${dueLabel(t.due, now)} ${cleanTitle(t.title)}`)];
  }

  let lastSent = '';
  // All lines are queued in one go (not awaited one by one), so another sender's line
  // can't land in the middle of a set. The write queue adds the 50 ms gap between lines.
  function syncTasksToBoard(items, writeLine, force = false, now = new Date()) {
    const lines = taskLines(items, now);
    const key = lines.join('\n');
    if (!force && key === lastSent) return Promise.resolve(false);
    lastSent = key;
    return Promise.all(lines.map(l => writeLine(l))).then(() => true);
  }

  // ---------------------------------------------------------------- connection lifecycle
  let write = null;        // writeLine for the connected board, or null
  let linked = false;      // the board has asked for tasks on this connection
  let pingTimer = null, relabelTimer = null, changeTimer = null;

  const currentTasks = () => (typeof tasks !== 'undefined' && tasks && tasks.items) || [];
  function push(force) {
    if (!write || !linked) return;
    syncTasksToBoard(currentTasks(), write, force).catch(() => {});
  }

  function attach(writeLine) {
    detach();
    write = writeLine;
  }

  function detach() {
    clearInterval(pingTimer); clearInterval(relabelTimer); clearTimeout(changeTimer);
    pingTimer = relabelTimer = changeTimer = null;
    write = null;
    linked = false;
    lastSent = '';         // the next connection always gets a full set
  }

  // EVENT SYNC from the board: send everything, even if unchanged
  function onSyncRequest() {
    if (!write) return;
    if (!linked) {
      linked = true;
      pingTimer = setInterval(() => { if (write) write('PING').catch(() => {}); }, PING_MS);
      relabelTimer = setInterval(() => push(false), RELABEL_MS);   // Tmrw -> Today at midnight
    }
    clearTimeout(changeTimer);
    push(true);
  }

  // the task list changed (called from saveTasks, which every local and synced change goes through)
  function changed() {
    if (!write || !linked) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => push(false), CHANGE_DEBOUNCE_MS);
  }

  return {
    attach, detach, onSyncRequest, changed,
    // pure helpers (tests.html)
    dueLabel, cleanTitle, taskLines, syncTasksToBoard,
    _resetLastSent: () => { lastSent = ''; },
    get linked() { return linked; },
  };
})();
