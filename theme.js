// ================================================================= THEME
// Appearance (system / light / dark). Saved in the browser.
// The colors are fixed: sage green and peach, set in style.css.
// The <head> of index.html applies the saved theme before the page draws.

const THEME_KEY = 'pomodoro-theme';
let theme = { mode: 'system' };
try { theme.mode = JSON.parse(localStorage.getItem(THEME_KEY) || '{}').mode || 'system'; } catch (e) {}

function applyTheme() {
  const root = document.documentElement;
  if (theme.mode === 'light' || theme.mode === 'dark') root.dataset.theme = theme.mode;
  else delete root.dataset.theme;
  // clear any accent color left over from the old color picker
  ['--accent', '--focus', '--accent-text'].forEach(p => root.style.removeProperty(p));
  // title bar color of the installed app: matches the sidebar
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--side').trim() || '#252525';
  paintThemeMenu();
}

function saveTheme() {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch (e) {}
  applyTheme();
  // charts read colors when drawn, so redraw whatever is open
  const open = Object.entries(VIEWS).find(([, id]) => !$(id).hidden);
  if (open && open[0] !== 'timer') showTab(open[0]);
}

function paintThemeMenu() {
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === theme.mode)));
}

document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { theme.mode = b.dataset.mode; saveTheme(); }));

// open / close settings: a solid full-screen page over the app until Done (or Esc)
document.body.append($('themeMenu'));   // out of the sidebar so nothing in the app can show over it
function setThemeMenu(open) {
  $('themeMenu').hidden = !open;
  $('themeBtn').setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';   // the page behind doesn't scroll while it's open
  if (open) $('themeClose').focus();
}
$('themeBtn').addEventListener('click', () => {
  const opening = $('themeMenu').hidden;
  setThemeMenu(opening);
  if (opening && typeof Sync !== 'undefined' && !Sync.signedIn) Sync.prefetch();   // get sign-in ready
});
$('themeClose').addEventListener('click', () => { setThemeMenu(false); $('themeBtn').focus(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('themeMenu').hidden) { setThemeMenu(false); $('themeBtn').focus(); } });

applyTheme();
