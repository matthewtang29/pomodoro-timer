// ================================================================= KEYBOARD SHORTCUTS
//   Ctrl+Space  add a task from any tab (a small quick-add box; Esc closes it)
//   Ctrl+0      start a 25/5 session (auto mode), from any tab
//   Space       pause / resume (on the Timer tab, handled in app.js)
// The installed app also offers "Start 25/5 session" and "Add a task" when you
// right-click its taskbar icon (or long-press it on Android): see manifest.webmanifest
// and handleLaunchAction() below.

function startClassicSession() {
  if (!status) { toast("The timer isn't ready yet"); return; }
  if (!IDLE.includes(status.state)) { toast('A session is already running'); showTab('timer'); return; }
  showTab('timer');
  ensureAudio();
  askNotificationPermission();
  send('AUTO');
  toast('Started a 25/5 session');
}

// ---------------------------------------------------------------- quick-add box
function quickAddPreview() {
  const box = $('qaDialogPreview');
  box.textContent = '';
  const raw = $('qaDialogInput').value;
  if (!raw.trim()) return;
  const p = parseQuickAdd(raw);
  const due = p.due || todayKey();
  box.append(el('span', 'chip title', p.title ? `“${p.title}”` : 'Add a task name'));
  box.append(el('span', 'chip', '📅 ' + fmtDue(due)));
  if (p.repeat) box.append(el('span', 'chip', '🔁 ' + REPEAT_LABEL[p.repeat]));
  box.append(el('span', 'chip pri-chip ' + ((p.priority || 4) <= 2 ? 'hi' : 'lo'), priLabel(p.priority || 4)));
  const d = p.difficulty || 3;
  const dc = el('span', 'chip'); dc.append(diffDots(d), DIFF_LABEL[d]); box.append(dc);
  if (p.project) box.append(el('span', 'chip', '# ' + p.project));
}

function openQuickAdd() {
  const dlg = $('qaDialog');
  if (dlg.open) return;
  $('qaDialogInput').value = '';
  quickAddPreview();
  dlg.showModal();
  $('qaDialogInput').focus();
}

$('qaDialogInput').addEventListener('input', quickAddPreview);
$('qaDialogForm').addEventListener('submit', e => {
  e.preventDefault();
  const p = parseQuickAdd($('qaDialogInput').value);
  if (!p.title) { $('qaDialogInput').focus(); return; }
  const t = addTask({ title: p.title, due: p.due || todayKey(), priority: p.priority, difficulty: p.difficulty, project: p.project, repeat: p.repeat });
  $('qaDialog').close();
  toast(`Added “${t.title}” · ${fmtDue(t.due)}`, 'View', () => showTab('tasks'));
});
$('qaDialogCancel').addEventListener('click', () => $('qaDialog').close());
// click on the dimmed background closes it
$('qaDialog').addEventListener('click', e => { if (e.target === $('qaDialog')) $('qaDialog').close(); });

// ---------------------------------------------------------------- keys
document.addEventListener('keydown', e => {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
  if (e.code === 'Space') {            // add a task (press again to close the box)
    e.preventDefault();
    if ($('qaDialog').open) $('qaDialog').close();
    else openQuickAdd();
  } else if (e.code === 'Digit0' || e.code === 'Numpad0') {   // start 25/5 (instead of the browser's zoom reset)
    e.preventDefault();
    if ($('qaDialog').open) $('qaDialog').close();
    startClassicSession();
  }
});

// ---------------------------------------------------------------- no zooming
// The layout is built for 100%, so page zoom is turned off: Ctrl/⌘ + plus/minus/0,
// Ctrl/⌘ + scroll wheel or trackpad pinch, and pinch / double-tap on iPhone
// (the viewport tag and touch-action in style.css cover the rest).
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['=', '+', '-', '_', '0'].includes(e.key)) e.preventDefault();
});
document.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach(n => document.addEventListener(n, e => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------- taskbar / home-screen shortcuts
// The app is opened as ./?do=focus or ./?do=add from the shortcut menu
function handleLaunchAction() {
  const params = new URLSearchParams(location.search);
  const action = params.get('do');
  if (!action) return;
  params.delete('do');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  // give the timer a moment to report in (a physical timer reconnects on launch)
  setTimeout(() => {
    if (action === 'focus') startClassicSession();
    else if (action === 'add') openQuickAdd();
  }, 600);
}
