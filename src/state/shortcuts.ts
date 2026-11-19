import { create } from 'zustand';

/** Everything that has a keyboard shortcut, with its default key. */
export const ACTIONS = [
  { id: 'tool.crosshair', label: 'Crosshair', group: 'Tools', key: 'c' },
  { id: 'tool.pan', label: 'Pan', group: 'Tools', key: 'h' },
  { id: 'tool.zoom', label: 'Zoom', group: 'Tools', key: 'z' },
  { id: 'tool.window', label: 'Window / Level', group: 'Tools', key: 'w' },
  { id: 'tool.measure', label: 'Ruler', group: 'Tools', key: 'r' },
  { id: 'tool.brush', label: 'Brush', group: 'Tools', key: 'b' },
  { id: 'tool.eraser', label: 'Eraser', group: 'Tools', key: 'e' },
  { id: 'tool.threshold', label: 'Threshold brush', group: 'Tools', key: 't' },
  { id: 'tool.scissors', label: 'Scissors', group: 'Tools', key: 's' },
  { id: 'tool.fill', label: 'Fill', group: 'Tools', key: 'f' },
  { id: 'tool.last', label: 'Last tool', group: 'Tools', key: 'space' },
  { id: 'brush.smaller', label: 'Smaller brush', group: 'Tools', key: '[' },
  { id: 'brush.larger', label: 'Larger brush', group: 'Tools', key: ']' },
  { id: 'mask.interpolate', label: 'Fill between slices', group: 'Tools', key: 'i' },
  { id: 'segment.new', label: 'New segment', group: 'Segments', key: 'n' },
  { id: 'segment.next', label: 'Next segment', group: 'Segments', key: '.' },
  { id: 'segment.previous', label: 'Previous segment', group: 'Segments', key: ',' },
  { id: 'mask.outline', label: 'Outline only', group: 'Segments', key: 'o' },
  { id: 'mask.toggle', label: 'Hide or show the mask', group: 'Segments', key: 'x' },
  { id: 'slice.previous', label: 'Previous slice', group: 'View and file', key: 'arrowup' },
  { id: 'slice.next', label: 'Next slice', group: 'View and file', key: 'arrowdown' },
  { id: 'slice.back5', label: 'Back 5 slices', group: 'View and file', key: 'pageup' },
  { id: 'slice.forward5', label: 'Forward 5 slices', group: 'View and file', key: 'pagedown' },
  { id: 'view.maximise', label: 'Maximise or restore', group: 'View and file', key: 'm' },
  { id: 'view.panel', label: 'Show or hide segments', group: 'View and file', key: 'mod+\\' },
  { id: 'edit.undo', label: 'Undo', group: 'View and file', key: 'mod+z' },
  { id: 'edit.redo', label: 'Redo', group: 'View and file', key: 'mod+shift+z' },
  { id: 'file.openImage', label: 'Open image', group: 'View and file', key: 'mod+o' },
  { id: 'file.openMask', label: 'Open mask', group: 'View and file', key: 'mod+shift+o' },
  { id: 'file.save', label: 'Save mask', group: 'View and file', key: 'mod+s' },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', group: 'View and file', key: '?' },
  { id: 'app.settings', label: 'Settings', group: 'View and file', key: 'mod+,' },
] as const;

export type ActionId = (typeof ACTIONS)[number]['id'];
export type Bindings = Record<ActionId, string>;

/** Keys that stay fixed: digits pick segments, Escape closes and cancels. */
const RESERVED = new Set(['escape', 'enter', 'tab', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

const STORAGE_KEY = 'w-annotator:shortcuts';

export function defaultBindings(): Bindings {
  const out = {} as Bindings;
  for (const a of ACTIONS) out[a.id] = a.key;
  return out;
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** One spelling for a key press, e.g. "mod+shift+z", "[", "space", "arrowup". Null for bare modifiers. */
export function comboFromEvent(e: KeyLike): string | null {
  let key = e.key;
  if (key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'Alt' || key === 'Dead' || key === 'Unidentified') return null;
  if (key === ' ') key = 'space';
  key = key.toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  // Shift is part of typing a symbol such as "?" or "{", so it only counts for named keys and letters.
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (e.shiftKey && !symbol) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export function isReserved(combo: string): boolean {
  return RESERVED.has(combo);
}

export function actionFor(bindings: Bindings, combo: string): ActionId | null {
  for (const a of ACTIONS) if (bindings[a.id] === combo) return a.id;
  return null;
}

/**
 * Gives `combo` to `id`. If another action had it, that action is left without
 * a key and its id is returned so the caller can say so.
 */
export function rebind(bindings: Bindings, id: ActionId, combo: string): { bindings: Bindings; displaced: ActionId | null } {
  const next = { ...bindings };
  const displaced = actionFor(bindings, combo);
  if (displaced && displaced !== id) next[displaced] = '';
  next[id] = combo;
  return { bindings: next, displaced: displaced && displaced !== id ? displaced : null };
}

const NAMES: Record<string, string> = {
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
};

export function formatCombo(combo: string, mac: boolean): string {
  if (!combo) return '—';
  return combo
    .split('+')
    .map((part, i, all) => {
      if (part === '' && i === all.length - 1) return '+';
      if (part === 'mod') return mac ? '⌘' : 'Ctrl';
      if (part === 'alt') return mac ? '⌥' : 'Alt';
      if (part === 'shift') return 'Shift';
      return NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1));
    })
    .join(mac ? ' ' : '+');
}

function load(): Bindings {
  const base = defaultBindings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    for (const a of ACTIONS) {
      const v = saved[a.id];
      if (typeof v === 'string') base[a.id] = v;
    }
  } catch {
    /* no saved shortcuts, or storage is unavailable */
  }
  return base;
}

function save(bindings: Bindings): void {
  try {
    const changed: Record<string, string> = {};
    for (const a of ACTIONS) if (bindings[a.id] !== a.key) changed[a.id] = bindings[a.id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
  } catch {
    /* the change still applies for this session */
  }
}

export const useShortcuts = create<{ bindings: Bindings }>(() => ({
  bindings: typeof localStorage === 'undefined' ? defaultBindings() : load(),
}));

export function setShortcut(id: ActionId, combo: string): ActionId | null {
  const { bindings, displaced } = rebind(useShortcuts.getState().bindings, id, combo);
  useShortcuts.setState({ bindings });
  save(bindings);
  return displaced;
}

export function resetShortcuts(): void {
  const bindings = defaultBindings();
  useShortcuts.setState({ bindings });
  save(bindings);
}

export function labelOf(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id;
}
