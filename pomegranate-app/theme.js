// ================================================================= THEME
// Appearance (system / light / dark) and accent color. Saved in the browser.
// The <head> of index.html applies the saved theme before the page draws.

const THEME_KEY = 'pomodoro-theme';
const DEFAULT_ACCENT = '#c4473b';
const ACCENTS = [
  ['Pomegranate', '#c4473b'], ['Periwinkle', '#5b78d6'], ['Sage', '#4f9a68'], ['Amber', '#d0802f'],
  ['Teal', '#3a9e94'], ['Grape', '#7b62b8'], ['Rose', '#c2507e'], ['Graphite', '#5b6170'],
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

// open / close the menu
function setThemeMenu(open) {
  const menu = $('themeMenu');
  menu.hidden = !open;
  $('themeBtn').setAttribute('aria-expanded', String(open));
  // on narrow screens, pin the menu to the screen edges just below the button
  if (open && window.innerWidth < 600) {
    menu.classList.add('pinned');
    menu.style.top = ($('themeBtn').getBoundingClientRect().bottom + 8) + 'px';
  } else {
    menu.classList.remove('pinned');
    menu.style.top = '';
  }
}
$('themeBtn').addEventListener('click', e => {
  e.stopPropagation();
  const opening = $('themeMenu').hidden;
  setThemeMenu(opening);
  if (opening && typeof Sync !== 'undefined' && !Sync.signedIn) Sync.prefetch();   // get sign-in ready
});
document.addEventListener('click', e => { if (!$('themeMenu').hidden && !e.target.closest('.theme-wrap')) setThemeMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('themeMenu').hidden) { setThemeMenu(false); $('themeBtn').focus(); } });

applyTheme();
