import { create } from 'zustand';
import { DEFAULT_ORDER, formatOrder, parseLayout, parseOrder } from '../viewer/layout';

/** When the lines that mark the other two planes are drawn in a view. */
export type ReferenceLines = 'always' | 'hover' | 'crosshair';

export function parseReferenceLines(raw: string): ReferenceLines {
  return raw === 'always' || raw === 'crosshair' ? raw : 'hover';
}

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
  /** How the views are arranged: a LayoutId from viewer/layout. */
  layout: string;
  /** Which view each pane shows, as a comma-separated list in pane order. */
  viewOrder: string;
  /** A ReferenceLines value. */
  referenceLines: string;
}

export const DEFAULT_SETTINGS: Settings = {
  displayName: '',
  autosave: true,
  tourSeen: false,
  reduceMotion: false,
  server: '',
  layout: 'grid',
  viewOrder: formatOrder(DEFAULT_ORDER),
  referenceLines: 'hover',
};

const KEY = 'w-annotator:settings';

export function parseSettings(raw: string | null): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(out) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof out[key]) (out as Record<string, unknown>)[key] = saved[key];
    }
  } catch {
    /* unreadable settings fall back to the defaults */
  }
  // Choices saved by another version, or edited by hand, fall back rather than break the views.
  out.layout = parseLayout(out.layout);
  out.viewOrder = formatOrder(parseOrder(out.viewOrder));
  out.referenceLines = parseReferenceLines(out.referenceLines);
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
