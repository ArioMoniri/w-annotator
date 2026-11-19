/**
 * The masks open on one image. Exactly one is active: the one the tools, undo,
 * the segments list, saving, autosave and rooms work on. The others are shown
 * read-only, as outlines, for comparison.
 *
 * This file holds the rules only; `session.ts` owns the voxels.
 */

import { baseName } from '../io/names';

/** Each mask is a full-size volume in memory and on the graphics card, so there is a limit. */
export const MAX_MASKS = 4;

export const TOO_MANY_MASKS = `Up to ${MAX_MASKS} masks can be open at once. Close one in Files to add another.`;

/** Outline colours of comparison masks, in the order they are opened. Neutral, so segment colours stay with the active mask. */
export const COMPARE_COLORS = ['#FFFFFF', '#9BE7FF', '#FFC2DD'];

export class MaskSet<T extends { id: string }> {
  private items: T[] = [];
  private activeId: string | null = null;

  constructor(private readonly limit = MAX_MASKS) {}

  get size(): number {
    return this.items.length;
  }

  get all(): readonly T[] {
    return this.items;
  }

  get active(): T | null {
    return this.items.find((x) => x.id === this.activeId) ?? null;
  }

  /** The masks shown for comparison: every one but the active. */
  get others(): T[] {
    return this.items.filter((x) => x.id !== this.activeId);
  }

  get full(): boolean {
    return this.items.length >= this.limit;
  }

  get(id: string): T | null {
    return this.items.find((x) => x.id === id) ?? null;
  }

  /** Adds a mask at the end. The first one is active whatever is asked. False when the set is full. */
  add(item: T, makeActive: boolean): boolean {
    if (this.full || this.get(item.id)) return false;
    this.items.push(item);
    if (makeActive || this.activeId === null) this.activeId = item.id;
    return true;
  }

  /** Puts `item` where the mask `id` was, keeping its place in the list and whether it is active. */
  replace(id: string, item: T): boolean {
    const at = this.items.findIndex((x) => x.id === id);
    if (at < 0) return false;
    this.items[at] = item;
    if (this.activeId === id) this.activeId = item.id;
    return true;
  }

  /** Makes a mask the active one. False when it is not in the set or already active. */
  activate(id: string): boolean {
    if (id === this.activeId || !this.get(id)) return false;
    this.activeId = id;
    return true;
  }

  /**
   * Takes a mask out. When it was the active one, the next in the list becomes
   * active (the previous one if it was last), so there is always one to edit
   * while any remain.
   */
  remove(id: string): T | null {
    const at = this.items.findIndex((x) => x.id === id);
    if (at < 0) return null;
    const [gone] = this.items.splice(at, 1);
    if (this.activeId === id) this.activeId = (this.items[at] ?? this.items[at - 1])?.id ?? null;
    return gone;
  }

  clear(): void {
    this.items = [];
    this.activeId = null;
  }
}

/** Colour of the `n`th comparison mask (0-based among the non-active ones). */
export function compareColor(n: number): string {
  return COMPARE_COLORS[n % COMPARE_COLORS.length];
}

/**
 * A file name short enough for a 264 px panel: no folder, no extension, and the
 * middle cut out when it is long, since the start and the end tell files apart.
 */
export function shortName(name: string, max = 22): string {
  const base = baseName(name);
  if (base.length <= max) return base;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${base.slice(0, head)}…${base.slice(base.length - tail)}`;
}

export interface MaskRow {
  id: string;
  /** File name, or null for a mask that has never been in a file. */
  name: string | null;
  dirty: boolean;
  visible: boolean;
  /** Where the file is on disk, when the desktop app knows. */
  path?: string;
}

export interface FileRow {
  id: string;
  kind: 'image' | 'mask';
  /** What the row shows. */
  label: string;
  /** Full name and size, for the tooltip. */
  detail: string;
  active: boolean;
  visible: boolean;
  dirty: boolean;
  /** Outline colour of a comparison mask; null for the image and the active mask. */
  color: string | null;
  path?: string;
}

export const IMAGE_ROW = 'image';

interface ListState {
  image: { name: string; dims: readonly number[]; path?: string } | null;
  masks: readonly MaskRow[];
  activeMask: string | null;
  /** Live state of the active mask, which changes with every edit. */
  maskName: string | null;
  dirty: boolean;
  maskHidden: boolean;
  imageDimmed: boolean;
}

/** The rows of the Files section: the image, then every mask in the order opened. */
export function fileRows(s: ListState): FileRow[] {
  if (!s.image) return [];
  const size = s.image.dims.join(' × ');
  const rows: FileRow[] = [
    {
      id: IMAGE_ROW,
      kind: 'image',
      label: shortName(s.image.name),
      detail: `${s.image.name}\n${size}`,
      active: false,
      visible: !s.imageDimmed,
      dirty: false,
      color: null,
      path: s.image.path,
    },
  ];
  let compared = 0;
  for (const m of s.masks) {
    const active = m.id === s.activeMask;
    const name = active ? s.maskName : m.name;
    rows.push({
      id: m.id,
      kind: 'mask',
      label: name ? shortName(name) : 'New mask',
      // Every mask is on the image grid, resampled when it was opened.
      detail: `${name ?? 'New mask, not saved yet'}\n${size}`,
      active,
      visible: active ? !s.maskHidden : m.visible,
      dirty: active ? s.dirty : m.dirty,
      color: active ? null : compareColor(compared++),
      path: m.path,
    });
  }
  return rows;
}
