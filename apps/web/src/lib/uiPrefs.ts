export type ThemePref = 'system' | 'light' | 'dark';

export type LayoutDir = 'a' | 'b';

/** '' means "no explicit choice yet", so the context default applies. */
export type ItemsView = 'cards' | 'tiles' | 'list' | '';

export type UiPrefs = {
  themePref: ThemePref;
  dir: LayoutDir;
  navFull: boolean;
  navHide: boolean;
  mapBg: boolean;
  pa: number;
  itemsView: ItemsView;
};

export const STORAGE_KEY = 'rsgim.ui';

export const PANEL_OPACITY_MIN = 60;
export const PANEL_OPACITY_MAX = 100;
export const PANEL_OPACITY_STEP = 2;
export const DEFAULT_PANEL_OPACITY = 94;

export const DEFAULT_UI_PREFS: UiPrefs = {
  themePref: 'dark',
  dir: 'a',
  navFull: false,
  navHide: false,
  mapBg: true,
  pa: DEFAULT_PANEL_OPACITY,
  itemsView: '',
};

export function clampPanelOpacity(
  value: number,
  fallback: number = DEFAULT_PANEL_OPACITY,
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(PANEL_OPACITY_MAX, Math.max(PANEL_OPACITY_MIN, Math.round(value)));
}

export function panelOpacityToAlpha(percent: number) {
  return clampPanelOpacity(percent) / 100;
}

const LEGACY_THEME_KEY = 'rsgim.theme';
const LEGACY_OPACITY_KEY = 'rsgim.panelOpacity';

function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isItemsView(value: unknown): value is ItemsView {
  return value === 'cards' || value === 'tiles' || value === 'list' || value === '';
}

function readLegacy(): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {};
  try {
    const theme = localStorage.getItem(LEGACY_THEME_KEY);
    if (isThemePref(theme)) out.themePref = theme;
    const pa = localStorage.getItem(LEGACY_OPACITY_KEY);
    if (pa) out.pa = clampPanelOpacity(Number(pa));
  } catch {
    return out;
  }
  return out;
}

function parse(raw: string | null): UiPrefs {
  const legacy = readLegacy();
  const base: UiPrefs = { ...DEFAULT_UI_PREFS, ...legacy };
  if (!raw) return base;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Record<string, unknown>;
  return {
    themePref: isThemePref(s.themePref) ? s.themePref : base.themePref,
    dir: s.dir === 'b' ? 'b' : s.dir === 'a' ? 'a' : base.dir,
    navFull: typeof s.navFull === 'boolean' ? s.navFull : base.navFull,
    navHide: typeof s.navHide === 'boolean' ? s.navHide : base.navHide,
    mapBg: typeof s.mapBg === 'boolean' ? s.mapBg : base.mapBg,
    pa: typeof s.pa === 'number' ? clampPanelOpacity(s.pa, base.pa) : base.pa,
    itemsView: isItemsView(s.itemsView) ? s.itemsView : base.itemsView,
  };
}

let current: UiPrefs | null = null;
const listeners = new Set<(prefs: UiPrefs) => void>();

export function readUiPrefs(): UiPrefs {
  if (current) return current;
  try {
    current = parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    current = { ...DEFAULT_UI_PREFS };
  }
  return current;
}

const WRITE_DEBOUNCE_MS = 150;
let writeTimer: number | null = null;

function flush() {
  writeTimer = null;
  if (!current) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    localStorage.removeItem(LEGACY_THEME_KEY);
    localStorage.removeItem(LEGACY_OPACITY_KEY);
  } catch {
    /* private browsing: preferences just will not persist */
  }
}

export function writeUiPrefs(patch: Partial<UiPrefs>): UiPrefs {
  const next: UiPrefs = { ...readUiPrefs(), ...patch };
  if (patch.pa !== undefined) next.pa = clampPanelOpacity(patch.pa, DEFAULT_PANEL_OPACITY);
  current = next;
  if (writeTimer != null) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(flush, WRITE_DEBOUNCE_MS);
  listeners.forEach((fn) => fn(next));
  return next;
}

export function subscribeUiPrefs(fn: (prefs: UiPrefs) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  root.classList.toggle('theme-dark', pref === 'dark');
  root.classList.toggle('theme-light', pref === 'light');
}

export function resolvedTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
