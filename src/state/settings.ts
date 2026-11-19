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
}

export const DEFAULT_SETTINGS: Settings = {
  displayName: '',
  autosave: true,
  tourSeen: false,
  reduceMotion: false,
  server: '',
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
