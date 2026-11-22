/**
 * Changes to the segment list as small messages in the room's order (`ROOMS.md` C6).
 * One message per segment, so a rename by one person and an add by another both survive;
 * for the same segment the later one wins.
 */

import { cleanText, type Meta, type SegmentInfo } from './protocol';

/** A segment as the room knows it. Whether it is shown is each person's own setting. */
export type SharedSegment = Omit<SegmentInfo, 'visible'>;

export type SegOp =
  | { op: 'set'; seg: SharedSegment }
  | { op: 'del'; index: number }
  /** View-through-host only: the host changed the window, so the pictures guests hold are out of date. */
  | { op: 'window'; voi?: [lower: number, upper: number] };

const shared = ({ index, name, color, locked }: SegmentInfo): SharedSegment => ({ index, name, color, locked });
const same = (a: SegmentInfo, b: SegmentInfo) => a.name === b.name && a.color === b.color && a.locked === b.locked;

/** What to tell the room after the list went from `before` to `after`. */
export function segmentOps(before: SegmentInfo[], after: SegmentInfo[]): SegOp[] {
  const old = new Map(before.map((s) => [s.index, s]));
  const kept = new Set(after.map((s) => s.index));
  const ops: SegOp[] = [];
  for (const s of after) {
    const was = old.get(s.index);
    if (!was || !same(was, s)) ops.push({ op: 'set', seg: shared(s) });
  }
  for (const s of before) if (!kept.has(s.index)) ops.push({ op: 'del', index: s.index });
  return ops;
}

export function applySegOp(list: SegmentInfo[], op: SegOp): SegmentInfo[] {
  if (op.op === 'del') return list.filter((s) => s.index !== op.index);
  if (op.op !== 'set') return list;
  const mine = list.find((s) => s.index === op.seg.index);
  const next = { ...op.seg, visible: mine?.visible ?? true };
  return [...list.filter((s) => s.index !== op.seg.index), next].sort((a, b) => a.index - b.index);
}

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 255;

/** A segment message from someone else, checked before it touches the list. */
export function parseSegOp(meta: Meta): SegOp | null {
  if (meta.op === 'window') {
    // The host's window is two numbers about how the host looks at the image, shown to guests read-only.
    const v = meta.voi;
    const ok = Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && v[1] > v[0];
    return ok ? { op: 'window', voi: [v[0], v[1]] } : { op: 'window' };
  }
  if (meta.op === 'del') return isIndex(meta.index) ? { op: 'del', index: meta.index } : null;
  if (meta.op !== 'set' || !meta.seg || typeof meta.seg !== 'object') return null;
  const s = meta.seg as Record<string, unknown>;
  // Names come from other people: no control characters, nothing that hides or reorders letters.
  const name = typeof s.name === 'string' ? cleanText(s.name, 64) : '';
  if (!isIndex(s.index) || !name || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  return { op: 'set', seg: { index: s.index, name, color: s.color, locked: !!s.locked } };
}
