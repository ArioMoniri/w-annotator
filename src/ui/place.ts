/**
 * Where a menu goes so that every item can be reached: inside the band between `lo` and
 * `hi` (window coordinates), moved up when it would run past the bottom, and scrolling
 * inside itself when it is taller than the band.
 */
export function placeMenu(wanted: number, height: number, lo: number, hi: number): { top: number; maxHeight: number } {
  const maxHeight = Math.max(0, hi - lo);
  const shown = Math.min(height, maxHeight);
  return { top: Math.round(Math.max(lo, Math.min(wanted, hi - shown))), maxHeight: Math.round(maxHeight) };
}

/**
 * How many low-priority items a bar must drop, from the first of `widths` on, before
 * what is left fits. `fixed` is the room taken by everything that always stays.
 */
export function itemsToDrop(widths: number[], fixed: number, available: number): number {
  let total = fixed + widths.reduce((a, b) => a + b, 0);
  let dropped = 0;
  while (dropped < widths.length && total > available) total -= widths[dropped++];
  return dropped;
}
