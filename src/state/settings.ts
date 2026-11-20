import { create } from 'zustand';

/** Preferences that persist between launches. Add new ones here with a default. */
export interface Settings {
  /** Name shown to others in a room. */
  displayName: string;
  /** Keep a recovery copy of unsaved mask edits on this device. */
  autosave: boolean;
  /** Whether the first-run tour has been shown. */
  tourSeen: boolean;
  /** Fewer transitions, for shared machines where the OS setting is not the user's to change. */
  reduceMotion: boolean;
  /** Room server address; empty means this computer hosts. */
  server: string;
  /** Natural follows the system: scrolling down goes to the next slice. */
  scrollDirection: 'natural' | 'reversed';
  /** How far a trackpad scroll moves through the slices, 1 (slow) to 10 (fast). */
  trackpadSpeed: number;
  /** What a two-finger scroll on a trackpad does in a slice view. */
  twoFingerScroll: 'slice' | 'pan';
  pinchZoom: boolean;
  /** A plain mouse wheel zooms, and Ctrl/Cmd+wheel changes slice. */
  wheelZooms: boolean;
  /** 1 (slow) to 10 (fast). */
  zoomSpeed: number;
}

/** Settings that are one of a few words, and the words allowed. */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  scrollDirection: ['natural', 'reversed'],
  twoFingerScroll: ['slice', 'pan'],
};

/** Settings on a 1 to 10 scale. */
const SPEEDS: (keyof Settings)[] = ['trackpadSpeed', 'zoomSpeed'];

export const DEFAULT_SETTINGS: Settings = {
  displayName: '',
  autosave: true,
  tourSeen: false,
  reduceMotion: false,
  server: '',
  scrollDirection: 'natural',
  trackpadSpeed: 5,
  twoFingerScroll: 'slice',
  pinchZoom: true,
  wheelZooms: false,
  zoomSpeed: 5,
};

const KEY = 'w-annotator:settings';

export function parseSettings(raw: string | null): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(out) as (keyof Settings)[]) {
      let value = saved[key];
      if (typeof value !== typeof out[key]) continue;
      if (CHOICES[key] && !CHOICES[key].includes(value as string)) continue;
      if (SPEEDS.includes(key)) {
        if (!Number.isFinite(value)) continue;
        value = Math.min(10, Math.max(1, value as number));
      }
      (out as Record<string, unknown>)[key] = value;
    }
  } catch {
    /* unreadable settings fall back to the defaults */
  }
  return out;
}

function load(): Settings {
  try {
    const settings = parseSettings(localStorage.getItem(KEY));
    // Values saved before there was a settings store.
    if (!settings.displayName) settings.displayName = localStorage.getItem('w-annotator:name') ?? '';
    if (!settings.server) settings.server = localStorage.getItem('w-annotator:server') ?? '';
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const useSettings = create<Settings>(() => (typeof localStorage === 'undefined' ? { ...DEFAULT_SETTINGS } : load()));

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  useSettings.setState({ [key]: value } as Pick<Settings, K>);
  try {
    localStorage.setItem(KEY, JSON.stringify(useSettings.getState()));
  } catch {
    /* the change still applies for this session */
  }
}

export const getSettings = () => useSettings.getState();

export const NAME_MAX = 24;

/** A display name as it is stored and sent: trimmed, at most 24 characters. */
export function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.trim().slice(0, NAME_MAX).trim() : '';
}

/** Mirrors the "Reduce motion" setting on <html>, where the stylesheet looks for it. */
export function applyReduceMotion(root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }, on: boolean): void {
  if (on) root.setAttribute('data-reduce-motion', 'true');
  else root.removeAttribute('data-reduce-motion');
}

if (typeof document !== 'undefined') {
  applyReduceMotion(document.documentElement, useSettings.getState().reduceMotion);
  useSettings.subscribe((s, p) => {
    if (s.reduceMotion !== p.reduceMotion) applyReduceMotion(document.documentElement, s.reduceMotion);
  });
}
