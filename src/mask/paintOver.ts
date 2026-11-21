/**
 * "Paint over": which voxels a tool that adds to a segment may take.
 * `all` is everything that is not locked, `empty` is empty voxels only, and a
 * number is the index of the one segment painting stays inside. Erasing is
 * never limited.
 */
export type PaintOver = 'all' | 'empty' | number;

interface Row {
  index: number;
  name: string;
  locked: boolean;
  visible: boolean;
}

/**
 * For a stroke a tool has already written: the changes to take back
 * (see `restoreWhere`). Null when nothing needs taking back.
 */
export function strokeRule(mode: PaintOver): ((before: number, after: number) => boolean) | null {
  if (mode === 'all') return null;
  if (mode === 'empty') return (before, after) => before !== 0 && after !== 0;
  return (before, after) => after !== 0 && before !== mode;
}

/** For a scissors erase a tool has already written: voxels of other segments go back. */
export function eraseRule(active: number): (before: number, after: number) => boolean {
  return (before, after) => after === 0 && before !== active;
}

/**
 * For fills the app writes itself: 1 at every value that may be written over.
 * Locked and hidden segments are never written over, whatever the choice.
 */
export function writableValues(mode: PaintOver, segments: readonly Row[]): Uint8Array {
  const table = new Uint8Array(256);
  if (mode === 'all') table.fill(1);
  else if (mode === 'empty') table[0] = 1;
  else if (mode >= 0 && mode < 256) table[mode] = 1;
  for (const seg of segments) if (seg.locked || !seg.visible) table[seg.index] = 0;
  return table;
}

/** The choice, or Everything when its segment is gone or is the one being painted. */
export function cleanPaintOver(mode: PaintOver, segments: readonly Row[], active: number): PaintOver {
  if (typeof mode !== 'number') return mode;
  return mode !== active && segments.some((seg) => seg.index === mode) ? mode : 'all';
}

/** What the chip in the options strip says: the segment being painted and any limit on it. */
export function paintOverLabel(mode: PaintOver, segments: readonly Row[], active: number): string {
  const seg = segments.find((x) => x.index === active);
  if (!seg) return 'No segment';
  if (mode === 'empty') return `${seg.name}, empty only`;
  const inside = typeof mode === 'number' ? segments.find((x) => x.index === mode) : undefined;
  return inside ? `${seg.name}, inside ${inside.name}` : seg.name;
}
