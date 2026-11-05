// ================================================================= THEME
// Appearance (system / light / dark) and accent color. Saved in the browser.
// The <head> of index.html applies the saved theme before the page draws.

const THEME_KEY = 'pomodoro-theme';
const DEFAULT_ACCENT = '#8fb996';   // sage (the stylesheet uses a lighter sage in dark mode)
const ACCENTS = [
  ['Sage', '#8fb996'], ['Peach', '#f4a582'], ['Periwinkle', '#8ea6e8'], ['Teal', '#7fbfb6'],
  ['Lavender', '#b3a2dc'], ['Rose', '#e3a1b8'], ['Sand', '#d9c08f'], ['Pomegranate', '#c4473b'],
];
let theme = { mode: 'system', accent: null };
try { theme = { ...theme, ...JSON.parse(localStorage.getItem(THEME_KEY) || '{}') }; } catch (e) {}

// Pick white or near-black text for a background color, whichever is more readable
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#ffffff' : '#111111';
}

function applyTheme() {
  const root = document.documentElement;
  if (theme.mode === 'light' || theme.mode === 'dark') root.dataset.theme = theme.mode;
  else delete root.dataset.theme;
  if (theme.accent) {
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--focus', theme.accent);     // timer ring while focusing
    root.style.setProperty('--accent-text', inkFor(theme.accent));
  } else {
    ['--accent', '--focus', '--accent-text'].forEach(p => root.style.removeProperty(p));
  }
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
  const cur = (theme.accent || DEFAULT_ACCENT).toLowerCase();
  document.querySelectorAll('#swatches button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === cur)));
  $('customColor').value = cur;
}

// swatches
ACCENTS.forEach(([name, color]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.color = color;
  b.title = name;
  b.setAttribute('aria-label', name);
  b.style.background = color;
  b.addEventListener('click', () => { theme.accent = color === DEFAULT_ACCENT ? null : color; saveTheme(); });
  $('swatches').append(b);
});
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { theme.mode = b.dataset.mode; saveTheme(); }));
$('customColor').addEventListener('input', () => { theme.accent = $('customColor').value; applyTheme(); });
$('customColor').addEventListener('change', () => { theme.accent = $('customColor').value; saveTheme(); });
$('themeReset').addEventListener('click', () => { theme = { mode: 'system', accent: null }; saveTheme(); });

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
