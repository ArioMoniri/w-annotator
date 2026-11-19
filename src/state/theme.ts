/**
 * Appearance: light, dark, or whatever the operating system uses.
 *
 * The chosen mode is kept in localStorage and the resolved theme is written to
 * `data-theme` on <html>, which is what the tokens in styles.css key off. The
 * same key and attribute are used by the inline script in index.html that sets
 * the theme before the first paint.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'w-annotator:theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** The parts of the browser the theme needs. All optional, so it runs anywhere. */
export interface ThemeEnv {
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** The `prefers-color-scheme: dark` media query. */
  query?: {
    matches: boolean;
    addEventListener(type: 'change', fn: () => void): void;
    removeEventListener(type: 'change', fn: () => void): void;
  };
  root?: { setAttribute(name: string, value: string): void };
  /** Called after every apply, for anything outside the page such as the native window. */
  onApply?: (theme: Theme, mode: ThemeMode) => void;
}

export function parseMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): Theme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

export interface ThemeController {
  mode(): ThemeMode;
  theme(): Theme;
  setMode(mode: ThemeMode): void;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

export function createTheme(env: ThemeEnv): ThemeController {
  const subscribers = new Set<() => void>();
  let mode: ThemeMode = 'system';
  try {
    mode = parseMode(env.storage?.getItem(THEME_KEY));
  } catch {
    /* storage is unavailable; start from the system theme */
  }
  // With no way to ask the OS, stay with the dark interface the app was designed around.
  const resolve = () => resolveTheme(mode, env.query?.matches ?? true);
  let theme = resolve();

  const apply = () => {
    theme = resolve();
    env.root?.setAttribute('data-theme', theme);
    env.onApply?.(theme, mode);
  };
  const onOsChange = () => {
    if (mode !== 'system') return;
    apply();
    for (const fn of [...subscribers]) fn();
  };

  env.query?.addEventListener('change', onOsChange);
  apply();

  return {
    mode: () => mode,
    theme: () => theme,
    setMode(next) {
      if (next === mode) return;
      mode = next;
      try {
        env.storage?.setItem(THEME_KEY, next);
      } catch {
        /* the change still applies for this session */
      }
      apply();
      for (const fn of [...subscribers]) fn();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    dispose() {
      env.query?.removeEventListener('change', onOsChange);
      subscribers.clear();
    },
  };
}

/** Keeps the desktop window's title bar and native menus in step. Does nothing in a browser tab. */
function syncNativeWindow(mode: ThemeMode): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(mode === 'system' ? null : mode))
    .catch(() => {
      /* the page theme still applies */
    });
}

function browserEnv(): ThemeEnv {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {};
  let storage: ThemeEnv['storage'];
  try {
    storage = window.localStorage;
  } catch {
    /* storage is blocked; the choice lasts for this session only */
  }
  return {
    storage,
    query: typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined,
    root: document.documentElement,
    onApply: (_theme, mode) => syncNativeWindow(mode),
  };
}

/** The app's one theme. Creating it applies the saved mode straight away. */
export const theme = createTheme(browserEnv());
