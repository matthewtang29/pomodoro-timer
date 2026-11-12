const $ = (id) => document.getElementById(id);
const BAUD = 115200;
const RING_C = 2 * Math.PI * 108;

// Does the connected board run the Pomodoro timer?
//   false (now): the board is a display only (tasks, Claude status, usage). The timer always
//                runs in the app, exactly the same whether a board is connected or not; no timer
//                command (START, AUTO, PAUSE, RESUME, EXIT, YES, NO, MUTE, UNMUTE, STATUS) is ever
//                sent to it, and STATE / timer EVENT lines from it are ignored.
//   true:        the old physical-timer mode (the board runs the timer, the app mirrors its STATE).
//                All of that code is kept below, behind boardRunsTimer(), for the robot firmware.
const BOARD_RUNS_TIMER = false;

let port = null;
let reader = null;
// true only when a board is connected AND it runs the timer (never, while the flag is false)
const boardRunsTimer = () => BOARD_RUNS_TIMER && !!port;
let keepReading = false;
let readLoopDone = null;
let sendChain = Promise.resolve();
let status = null;          // last STATE line from the timer, parsed
let audioCtx = null;
let lastRingState = undefined;

const ring = $('ring');
ring.style.strokeDasharray = RING_C;
ring.style.strokeDashoffset = 0;

// ---------------------------------------------------------------- settings
const inputs = { focus: $('focusIn'), brk: $('breakIn'), cycles: $('cyclesIn') };
let customOpen = false;   // the Custom steppers box is open

function clampInput(el) {
  let v = parseInt(el.value, 10);
  if (isNaN(v)) v = parseInt(el.min, 10);
  v = Math.min(parseInt(el.max, 10), Math.max(parseInt(el.min, 10), v));
  el.value = v;
  return v;
}
function settings() {
  return { focus: clampInput(inputs.focus), brk: clampInput(inputs.brk), cycles: clampInput(inputs.cycles) };
}
function saveSettings() {
  try { localStorage.setItem('pomodoro-settings', JSON.stringify(settings())); } catch (e) {}
  updateTotalHint();
  render();
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('pomodoro-settings'));
    if (s) { inputs.focus.value = s.focus; inputs.brk.value = s.brk; inputs.cycles.value = s.cycles; }
  } catch (e) {}
}
function updateTotalHint() {
  const s = settings();
  const mins = s.focus * s.cycles + s.brk * (s.cycles - 1);   // no break after the last cycle
  $('totalHint').textContent = `Total: ${fmtDuration(mins)} · ${fmtDuration(s.focus * s.cycles)} of focus`;
}

document.querySelectorAll('[data-step]').forEach(btn => btn.addEventListener('click', () => {
  const el = $(btn.dataset.step);
  const by = parseInt(btn.dataset.by, 10);
  let v = (parseInt(el.value, 10) || 0) + by;
  if (Math.abs(by) === 5) v = Math.round(v / 5) * 5;   // snap to multiples of 5
  el.value = v;
  clampInput(el);
  saveSettings();
}));
document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
  const [f, b, c] = btn.dataset.preset.split(',');
  inputs.focus.value = f; inputs.brk.value = b; inputs.cycles.value = c;
  customOpen = false;
  saveSettings();
}));
// "Custom" shows the focus / break / cycles steppers
$('customBtn').addEventListener('click', () => { customOpen = !customOpen; render(); });
Object.values(inputs).forEach(el => el.addEventListener('change', saveSettings));

// ---------------------------------------------------------------- serial
// knownPort: a port this site was allowed to use before (the installed app reconnects to it on launch)
async function connect(knownPort) {
  if (BOARD_RUNS_TIMER && LocalTimer.busy()) { toast('Finish or exit the built-in timer session first'); return; }
  try {
    port = knownPort || await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD });
  } catch (e) {
    port = null;
    if (e.name !== 'NotFoundError') toast(portError(e));   // NotFoundError = user closed the picker
    return;
  }
  keepReading = true;
  BoardSync.attach(writeLine);   // waits for the board's EVENT SYNC before sending anything
  ClaudeStatus.attach(writeLine);
  readLoopDone = readLoop();
  if (!BOARD_RUNS_TIMER) {   // display board: the app's timer carries on untouched
    log('— board connected');
    render();
    return;
  }
  ensureAudio();
  status = null;
  log('— connected, waiting for the timer…');
  render();

  // Boards that don't restart on connect won't send READY, so ask for the state.
  setTimeout(() => { if (port && !status) send('STATUS'); }, 3000);
}

function portError(e) {
  if (e.name === 'InvalidStateError' || /open/i.test(e.message))
    return "Couldn't open the port. Is the Arduino IDE Serial Monitor open?";
  return 'Connection failed: ' + e.message;
}

async function disconnect() {
  BoardSync.detach();   // stop PING / relabel timers; the next connection gets a full set
  ClaudeStatus.detach();   // stop listening to the Claude status doc
  keepReading = false;
  if (reader) { try { await reader.cancel(); } catch (e) {} }
  if (readLoopDone) { try { await readLoopDone; } catch (e) {} }
  if (port) { try { await port.close(); } catch (e) {} }
  const wasTimer = boardRunsTimer();
  port = null;
  if (!wasTimer) {   // display board: the app's timer was never involved
    log('— board disconnected');
    render();
    return;
  }
  trackDisconnect();
  if (typeof LiveSync !== 'undefined') LiveSync.physicalGone();
  status = null;
  log('— disconnected');
  render();
  LocalTimer.announce();   // the built-in timer takes over again
}

async function readLoop() {
  const decoder = new TextDecoder();
  let buffer = '';
  while (port && port.readable && keepReading) {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) handleBoardLine(line);
        }
      }
    } catch (e) {
      if (keepReading) log('! ' + e.message);
    } finally {
      reader.releaseLock();
      reader = null;
    }
  }
}

// One serialized write queue for everything sent to the board (desk-robot lines, and timer
// commands when the board runs the timer), with a short gap after each line. Lines from two senders
// interleaved too tightly make the board answer ERR UNKNOWN.
const LINE_GAP_MS = 50;
function enqueueLine(line, quiet) {
  sendChain = sendChain.then(async () => {
    if (!port || !port.writable) return;   // unplugged meanwhile: drop it
    const writer = port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(line + '\n'));
      if (!quiet) log('> ' + line);
    } finally {
      writer.releaseLock();
    }
    await new Promise(r => setTimeout(r, LINE_GAP_MS));
  }).catch(e => toast('Send failed: ' + e.message));
  return sendChain;
}

// Timer commands. They go to the app's built-in timer, and never to a display-only board.
function send(cmd) {
  if (!boardRunsTimer()) {   // the built-in timer handles it
    log('> ' + cmd + '  (built-in)');
    LocalTimer.command(cmd);
    return Promise.resolve();
  }
  return enqueueLine(cmd);
}

// Board-only lines (desk-robot task sync). Unlike send(), these never go to the built-in
// timer: with nothing connected they're simply dropped. PING isn't written to the log.
function writeLine(line) {
  if (!port) return Promise.resolve();
  return enqueueLine(line, line === 'PING');
}

if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === port) { toast(BOARD_RUNS_TIMER ? 'Timer unplugged' : 'Board unplugged'); disconnect(); }
  });
}

// ---------------------------------------------------------------- messages from the board
// Lines read from the serial port. A display-only board must never drive the timer, so its
// STATE and timer EVENT lines are logged and dropped; the desk-robot lines (EVENT SYNC,
// EVENT ALERT_ACK, ERR, #) go on to handleLine as before.
const BOARD_EVENTS = ['EVENT SYNC', 'EVENT ALERT_ACK'];
function handleBoardLine(line) {
  if (!BOARD_RUNS_TIMER && (line.startsWith('STATE ') || (line.startsWith('EVENT ') && !BOARD_EVENTS.includes(line)))) {
    log('< ' + line + '  (ignored: the timer runs in the app)');
    return;
  }
  // a display board's ERR is about a board line (TASK, CLAUDE, USAGE…), not the timer
  if (!BOARD_RUNS_TIMER && line.startsWith('ERR ')) {
    log('< ' + line);
    toast(`The board rejected a line (${line.slice(4)})`);
    return;
  }
  handleLine(line);
}

// ---------------------------------------------------------------- messages from the timer
// From the built-in timer (LocalTimer), or from the board when it runs the timer.
// at: optional time the line refers to (used by the built-in timer)
function handleLine(line, at) {
  if (line.startsWith('STATE ')) {
    if ($('showStates').checked) log('< ' + line);
    const s = {};
    line.slice(6).split(' ').forEach(kv => {
      const [k, v] = kv.split('=');
      s[k] = isNaN(v) ? v : Number(v);
    });
    trackState(status ? status.state : null, s, at);
    status = s;
    if (boardRunsTimer() && typeof LiveSync !== 'undefined') LiveSync.physical(s);   // show it on your other devices
    render();
    return;
  }
  log('< ' + line);
  if (line.startsWith('#')) return;   // board debug line
  // desk-robot lines: handled here so they never reach the timer's event handling
  // (which would record them as session events and sync that to the cloud every 5 s)
  if (line === 'EVENT SYNC') { if (port) { BoardSync.onSyncRequest(); ClaudeStatus.onBoardSync(); } return; }
  if (line === 'EVENT ALERT_ACK') return;   // logged above; nothing else to do yet
  if (line.startsWith('EVENT ')) onEvent(line.slice(6));
  else if (line.startsWith('ERR ')) toast(errorText(line.slice(4)));
}

function errorText(code) {
  return ({
    BUSY: 'A session is already running. Exit it first.',
    RANGE: 'Those values are out of range.',
    STATE: "The timer can't do that right now.",
    UNKNOWN: "The timer didn't understand that command.",
  })[code] || 'Timer error: ' + code;
}

function onEvent(name) {
  trackEvent(name);
  const lastBlock = status && status.cycles > 0 && status.cycle >= status.cycles;
  if (name === 'FOCUS_DONE' && !lastBlock) chime([784, 659, 523]);   // last block: the session chime plays instead
  else if (name === 'REST_DONE') chime([523, 659, 784]);
  else if (name === 'SESSION_ENDED') chime([523, 659, 784, 1047]);
  Notify.event(name);   // system notification if the app is in the background, message if not
}

function askNotificationPermission() { Notify.ask(); }

// ---------------------------------------------------------------- UI
const PHASES = {
  MENU:         { label: 'Ready',            tone: 'idle' },
  GETREADY:     { label: 'Get ready',        tone: 'focus' },
  FOCUS:        { label: 'Focusing',         tone: 'focus' },
  REST:         { label: 'Break',            tone: 'rest' },
  PAUSED_FOCUS: { label: 'Paused · focus',   tone: 'paused' },
  PAUSED_REST:  { label: 'Paused · break',   tone: 'paused' },
  FOCUS_DONE:   { label: 'Focus complete',   tone: 'rest' },
  CHECKPOINT:   { label: 'Break over',       tone: 'idle' },
  CONTINUE:     { label: 'Cycle complete',   tone: 'idle' },
  ENDED:        { label: 'Session complete', tone: 'idle' },
  EXITED:       { label: 'Timer exited',     tone: 'idle' },
  SUMMARY:      { label: 'Summary',          tone: 'idle' },
};
const IDLE = ['MENU', 'SUMMARY', 'ENDED', 'EXITED'];

function render() {
  const connected = boardRunsTimer();   // a board that runs the timer (never while BOARD_RUNS_TIMER is false)
  const ready = !!status;             // the physical timer or the built-in one has reported in
  const local = !connected;
  const st = ready ? status.state : null;
  const s = settings();
  const shared = !connected && ready && status.src === 'REMOTE' && !IDLE.includes(st);   // started on another device

  // header
  const pill = $('pill');
  if (!BOARD_RUNS_TIMER) {
    // the sidebar shows the board link only; it has nothing to do with the timer
    const linked = !!port;
    $('connectBtn').textContent = linked ? 'Disconnect' : 'Connect board';
    $('connectBtn').title = linked ? 'Disconnect the board' : 'Connect your desk board over USB';
    pill.className = 'pill' + (linked ? ' on' : ' local');
    pill.textContent = linked ? 'Connected' : 'Board not connected';
    pill.title = linked ? 'The board shows your tasks and Claude Code status.' : '';
    $('devSub').textContent = linked ? 'Connected over USB' : 'Not connected';
  } else {
    $('connectBtn').textContent = connected ? 'Disconnect' : 'Connect timer';
    $('connectBtn').title = connected ? 'Disconnect the timer' : 'Connect your Pomodoro timer over USB';
    pill.className = 'pill' + (connected ? (ready ? ' on' : ' wait') : shared ? ' shared' : ' local');
    pill.textContent = connected ? (ready ? 'Timer connected' : 'Waiting for timer…') : shared ? 'Synced session' : 'Built-in timer';
    pill.title = connected ? '' : shared ? 'This session was started on another of your devices. You can pause or exit it here too.'
      : 'No timer connected: sessions run in the app. Connect to use your Pomodoro timer.';
    $('devSub').textContent = connected ? (ready ? 'Connected over USB' : 'Connecting…') : 'Device not connected';
  }
  $('soundRow').hidden = local;
  // page subtitle: date and today's focus time
  if (typeof peekDay === 'function') {
    const f = peekDay(dayKey(Date.now())).focus;
    $('timerToday').textContent = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      + (f >= 60 ? ` · ${fmtSecs(f)} focused today` : '');
  }

  // mute toggle (reflects the timer's actual setting)
  const muted = ready && status.muted === 1;
  $('muteBtn').disabled = !ready;
  $('muteBtn').setAttribute('aria-pressed', muted ? 'true' : 'false');
  $('muteLabel').textContent = muted ? 'Muted' : 'Mute';

  // panels
  const idle = !ready || IDLE.includes(st);
  $('setupPanel').hidden = !idle;
  $('setupFields').hidden = !idle || !customOpen;
  $('continuePanel').hidden = st !== 'CONTINUE';
  $('sessionPanel').hidden = idle || st === 'CONTINUE';
  document.querySelectorAll('#setupPanel button, #setupFields button, #setupFields input').forEach(el => el.disabled = !ready);
  // preset pills: highlight the one in use (or Custom); locked while a session runs
  const key = `${s.focus},${s.brk},${s.cycles}`;
  const presetBtns = [...document.querySelectorAll('#presetBar [data-preset]')];
  const match = presetBtns.some(b => b.dataset.preset === key);
  presetBtns.forEach(b => { b.setAttribute('aria-pressed', String(!customOpen && b.dataset.preset === key)); b.disabled = !idle || !ready; });
  $('customBtn').setAttribute('aria-pressed', String(customOpen || !match));
  $('customBtn').setAttribute('aria-expanded', String(customOpen));
  $('customBtn').textContent = match ? 'Custom' : `Custom ${s.focus}/${s.brk} × ${s.cycles}`;
  $('customBtn').disabled = !idle || !ready;

  const paused = st === 'PAUSED_FOCUS' || st === 'PAUSED_REST';
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  $('pauseBtn').disabled = !(paused || st === 'FOCUS' || st === 'REST');

  // dial
  const phase = ready ? (PHASES[st] || { label: st, tone: 'idle' }) : null;
  $('card').dataset.phase = phase ? phase.tone : 'idle';
  // "Focus · cycle 2 of 4" while a block runs
  const cyc = ready && status.cycles > 0 ? ` · cycle ${status.cycle} of ${status.cycles}` : ready ? ` · cycle ${status.cycle}` : '';
  const phaseText = !ready ? 'Connecting'
    : st === 'FOCUS' ? 'Focus' + cyc
    : st === 'REST' ? 'Break' + cyc
    : phase.label;
  $('phase').textContent = phaseText;

  let secs, total;
  if (ready && ['GETREADY', 'FOCUS', 'REST', 'PAUSED_FOCUS', 'PAUSED_REST'].includes(st)) {
    secs = status.left;
    total = st === 'GETREADY' ? 6
          : (st === 'FOCUS' || st === 'PAUSED_FOCUS') ? status.focus * 60
          : status.break * 60;
  } else if (ready && !IDLE.includes(st)) {
    secs = 0; total = 1;
  } else {
    secs = s.focus * 60; total = secs;
  }
  $('time').textContent = st === 'GETREADY' ? String(secs) : fmtClock(secs);
  // Animate smoothly within a phase, but jump when the phase changes
  if (st !== lastRingState) {
    ring.style.transition = 'none';
    ring.getBoundingClientRect();
    lastRingState = st;
  }
  ring.style.strokeDashoffset = RING_C * (1 - Math.max(0, Math.min(1, secs / total)));
  requestAnimationFrame(() => { ring.style.transition = ''; });

  let sub = '';
  if (!ready) sub = 'Restarting the timer…';
  else if (IDLE.includes(st)) sub = `${fmtDuration(s.focus)} focus · ${fmtDuration(s.brk)} break`;
  else if (st === 'FOCUS_DONE') sub = 'Break starts in a moment';
  else if (st === 'FOCUS' || st === 'PAUSED_FOCUS') {
    const last = status.cycles > 0 && status.cycle >= status.cycles;
    sub = last ? 'Last focus block' : `Break next · ${status.break} min`;
  } else if (st === 'REST' || st === 'PAUSED_REST') sub = `Focus next · ${status.focus} min`;
  else sub = status.cycles > 0 ? `Cycle ${status.cycle} of ${status.cycles}` : `Cycle ${status.cycle} · auto mode`;
  // the sidebar pill no longer says "Synced session" (it's about the board now), so say it here
  if (shared && !BOARD_RUNS_TIMER) sub = 'From another device · ' + sub;
  $('sub').textContent = sub;

  // stats
  $('doneStat').textContent = ready ? status.done : 0;
  $('totalStat').textContent = fmtDuration(ready ? status.total : 0);
  if (typeof dayScore === 'function') {
    const sc = dayScore(dayKey(Date.now()));
    $('todayScoreStat').textContent = sc ? sc.score : '—';
  }

  // tab title
  const running = ready && !IDLE.includes(st) && st !== 'CONTINUE';
  document.title = running ? `${fmtClock(secs)} · ${phase.label} — Pomegranate` : 'Pomegranate';
  if (typeof renderTimerTask === 'function') renderTimerTask();
  if (typeof Notify !== 'undefined') Notify.update(status);
}

function fmtClock(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function fmtDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function log(text) {
  const el = $('log');
  const lines = (el.textContent + text + '\n').split('\n');
  el.textContent = lines.slice(-300).join('\n');
  el.scrollTop = el.scrollHeight;
}

let toastTimer;
// toast('Saved') or toast('Task done', 'Undo', () => ...)
function toast(msg, actionLabel, action) {
  const t = $('toast');
  t.textContent = msg;
  if (actionLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = actionLabel;
    b.addEventListener('click', () => { t.classList.remove('show'); action(); });
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 6000 : 3500);
}

// ---------------------------------------------------------------- sound
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
function chime(notes) {
  if (!audioCtx) return;
  // built-in timer: follows the Mute button; physical timer: follows the checkbox
  if (boardRunsTimer() ? !$('soundChk').checked : (status && status.muted === 1)) return;
  const t0 = audioCtx.currentTime;
  notes.forEach((hz, i) => {
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const t = t0 + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.55);
  });
}

// ---------------------------------------------------------------- buttons
$('connectBtn').addEventListener('click', () => port ? disconnect() : connect());
$('startBtn').addEventListener('click', () => {
  const s = settings();
  ensureAudio();
  askNotificationPermission();
  send(`START ${s.focus} ${s.brk} ${s.cycles}`);
});
$('autoBtn').addEventListener('click', () => { ensureAudio(); askNotificationPermission(); send('AUTO'); });
$('muteBtn').addEventListener('click', () => {
  if (status) send(status.muted === 1 ? 'UNMUTE' : 'MUTE');
});
$('pauseBtn').addEventListener('click', togglePause);
$('exitBtn').addEventListener('click', () => send('EXIT'));
$('yesBtn').addEventListener('click', () => send('YES'));
$('noBtn').addEventListener('click', () => send('NO'));
$('cmdBtn').addEventListener('click', sendTyped);
$('cmdIn').addEventListener('keydown', e => { if (e.key === 'Enter') sendTyped(); });

function sendTyped() {
  const v = $('cmdIn').value.trim();
  if (v) { send(v); $('cmdIn').value = ''; }
}
function togglePause() {
  if (!status) return;
  if (status.state === 'FOCUS' || status.state === 'REST') send('PAUSE');
  else if (status.state.startsWith('PAUSED')) send('RESUME');
}
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !$('timerView').hidden &&
      !['INPUT', 'BUTTON', 'SUMMARY', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
    e.preventDefault();
    togglePause();
  }
});


