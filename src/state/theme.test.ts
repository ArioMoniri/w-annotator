import { describe, expect, it } from 'vitest';
import { THEME_KEY, createTheme, parseMode, resolveTheme, type ThemeEnv } from './theme';

/** A stand-in for the browser: storage, the dark-scheme media query and the <html> element. */
function fakeEnv(opts: { saved?: string | null; dark?: boolean } = {}) {
  const store = new Map<string, string>();
  if (opts.saved != null) store.set(THEME_KEY, opts.saved);
  const listeners = new Set<() => void>();
  const attrs: Record<string, string> = {};
  const query = {
    matches: opts.dark ?? true,
    addEventListener: (_: 'change', fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: 'change', fn: () => void) => void listeners.delete(fn),
  };
  const env: ThemeEnv = {
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    query,
    root: { setAttribute: (k, v) => void (attrs[k] = v) },
  };
  const setOs = (dark: boolean) => {
    query.matches = dark;
    for (const fn of [...listeners]) fn();
  };
  return { env, store, attrs, listeners, setOs };
}

describe('parseMode', () => {
  it('accepts the three modes', () => {
    expect(parseMode('light')).toBe('light');
    expect(parseMode('dark')).toBe('dark');
    expect(parseMode('system')).toBe('system');
  });
  it('falls back to system for anything else', () => {
    expect(parseMode(null)).toBe('system');
    expect(parseMode('')).toBe('system');
    expect(parseMode('sepia')).toBe('system');
    expect(parseMode(1)).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('uses the chosen theme whatever the OS says', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('follows the OS in system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('createTheme', () => {
  it('defaults to system and applies the OS theme to the root', () => {
    const f = fakeEnv({ dark: false });
    const t = createTheme(f.env);
    expect(t.mode()).toBe('system');
    expect(t.theme()).toBe('light');
    expect(f.attrs['data-theme']).toBe('light');
  });
  it('starts from the saved mode', () => {
    const f = fakeEnv({ saved: 'light', dark: true });
    const t = createTheme(f.env);
    expect(t.mode()).toBe('light');
    expect(f.attrs['data-theme']).toBe('light');
  });
  it('ignores a saved value it does not know', () => {
    const f = fakeEnv({ saved: 'purple', dark: true });
    expect(createTheme(f.env).mode()).toBe('system');
    expect(f.attrs['data-theme']).toBe('dark');
  });
  it('applies and saves a new mode', () => {
    const f = fakeEnv({ dark: true });
    const t = createTheme(f.env);
    t.setMode('light');
    expect(t.theme()).toBe('light');
    expect(f.attrs['data-theme']).toBe('light');
    expect(f.store.get(THEME_KEY)).toBe('light');
    t.setMode('system');
    expect(f.attrs['data-theme']).toBe('dark');
    expect(f.store.get(THEME_KEY)).toBe('system');
  });
  it('follows OS changes live in system mode', () => {
    const f = fakeEnv({ dark: true });
    const t = createTheme(f.env);
    f.setOs(false);
    expect(t.theme()).toBe('light');
    expect(f.attrs['data-theme']).toBe('light');
    f.setOs(true);
    expect(f.attrs['data-theme']).toBe('dark');
  });
  it('ignores OS changes when a theme is chosen', () => {
    const f = fakeEnv({ saved: 'dark', dark: true });
    const t = createTheme(f.env);
    f.setOs(false);
    expect(t.theme()).toBe('dark');
    expect(f.attrs['data-theme']).toBe('dark');
  });
  it('picks up the current OS theme when going back to system', () => {
    const f = fakeEnv({ saved: 'dark', dark: true });
    const t = createTheme(f.env);
    f.setOs(false);
    t.setMode('system');
    expect(f.attrs['data-theme']).toBe('light');
  });
  it('tells subscribers about changes, and stops after unsubscribe', () => {
    const f = fakeEnv({ dark: true });
    const t = createTheme(f.env);
    let calls = 0;
    const off = t.subscribe(() => calls++);
    t.setMode('light');
    expect(calls).toBe(1);
    t.setMode('light');
    expect(calls).toBe(1);
    t.setMode('system');
    f.setOs(false);
    expect(calls).toBe(3);
    off();
    t.setMode('dark');
    expect(calls).toBe(3);
  });
  it('reports each applied theme to the host window', () => {
    const f = fakeEnv({ dark: true });
    const seen: string[] = [];
    const t = createTheme({ ...f.env, onApply: (theme, mode) => seen.push(`${mode}:${theme}`) });
    t.setMode('light');
    expect(seen).toEqual(['system:dark', 'light:light']);
  });
  it('still works for the session when storage throws', () => {
    const f = fakeEnv({ dark: true });
    const t = createTheme({
      ...f.env,
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(t.mode()).toBe('system');
    t.setMode('light');
    expect(f.attrs['data-theme']).toBe('light');
  });
  it('is dark when there is nothing to ask', () => {
    const t = createTheme({});
    expect(t.mode()).toBe('system');
    expect(t.theme()).toBe('dark');
  });
  it('stops listening to the OS when disposed', () => {
    const f = fakeEnv({ dark: true });
    const t = createTheme(f.env);
    expect(f.listeners.size).toBe(1);
    t.dispose();
    expect(f.listeners.size).toBe(0);
  });
});
