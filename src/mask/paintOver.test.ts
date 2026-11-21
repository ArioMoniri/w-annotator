import { describe, expect, it } from 'vitest';
import { diffMask, restoreWhere } from './patch';
import { cleanPaintOver, eraseRule, paintOverLabel, strokeRule, writableValues } from './paintOver';

const seg = (index: number, o: { locked?: boolean; visible?: boolean; name?: string } = {}) => ({
  index,
  name: o.name ?? `Segment ${index}`,
  locked: o.locked ?? false,
  visible: o.visible ?? true,
});

/** A stroke of `label` over every voxel of `before`, then the rule applied the way the session does. */
function stroke(before: number[], label: number, rule: ((b: number, a: number) => boolean) | null): number[] {
  const prev = Uint8Array.from(before);
  const cur = new Uint8Array(before.length).fill(label);
  const patch = diffMask(prev, cur, before.length)!;
  if (rule) restoreWhere(cur, patch, rule);
  return [...cur];
}

describe('paint over, for a stroke made by a tool', () => {
  it('lets a stroke write anywhere with Everything', () => {
    expect(strokeRule('all')).toBeNull();
    expect(stroke([0, 2, 3], 1, strokeRule('all'))).toEqual([1, 1, 1]);
  });

  it('keeps other segments with Empty only', () => {
    expect(stroke([0, 2, 3, 0], 1, strokeRule('empty'))).toEqual([1, 2, 3, 1]);
  });

  it('paints only inside the chosen segment', () => {
    expect(stroke([0, 2, 3, 2], 1, strokeRule(2))).toEqual([0, 1, 3, 1]);
  });

  it('never limits erasing', () => {
    for (const mode of ['empty', 2] as const) expect(stroke([0, 2, 3, 1], 0, strokeRule(mode))).toEqual([0, 0, 0, 0]);
  });

  it('reports how many voxels were put back', () => {
    const prev = Uint8Array.from([0, 2, 2, 3]);
    const cur = Uint8Array.from([1, 1, 1, 1]);
    expect(restoreWhere(cur, diffMask(prev, cur, 4)!, strokeRule('empty')!)).toBe(3);
    expect([...cur]).toEqual([1, 2, 2, 3]);
  });
});

describe('scissors erase', () => {
  it('takes voxels from the active segment only', () => {
    expect(stroke([1, 2, 0, 1, 3], 0, eraseRule(1))).toEqual([0, 2, 0, 0, 3]);
  });
});

describe('paint over, for the app\'s own fills', () => {
  const list = [seg(1), seg(2), seg(3, { locked: true }), seg(4, { visible: false })];
  const allowed = (mode: 'all' | 'empty' | number) => {
    const t = writableValues(mode, list);
    return [0, 1, 2, 3, 4, 9].filter((v) => t[v] === 1);
  };

  it('writes over empty voxels and other segments with Everything', () => {
    // 9 is a value with no row in the list: not locked, so it can be written over.
    expect(allowed('all')).toEqual([0, 1, 2, 9]);
  });

  it('writes over empty voxels only with Empty only', () => {
    expect(allowed('empty')).toEqual([0]);
  });

  it('writes inside the chosen segment only', () => {
    expect(allowed(2)).toEqual([2]);
  });

  it('never writes over a locked or hidden segment, whatever the choice', () => {
    expect(allowed(3)).toEqual([]);
    expect(allowed(4)).toEqual([]);
    expect(allowed('all')).not.toContain(3);
    expect(allowed('all')).not.toContain(4);
  });
});

describe('the paint over choice', () => {
  const list = [seg(1, { name: 'Tumour' }), seg(2, { name: 'Liver' })];

  it('stays as chosen while its segment exists and is not the one being painted', () => {
    expect(cleanPaintOver(2, list, 1)).toBe(2);
    expect(cleanPaintOver('empty', list, 1)).toBe('empty');
  });

  it('goes back to Everything when its segment is deleted or becomes the active one', () => {
    expect(cleanPaintOver(3, list, 1)).toBe('all');
    expect(cleanPaintOver(2, list, 2)).toBe('all');
  });

  it('names the limit for the chip', () => {
    expect(paintOverLabel(2, list, 1)).toBe('Tumour, inside Liver');
    expect(paintOverLabel('empty', list, 1)).toBe('Tumour, empty only');
    expect(paintOverLabel('all', list, 1)).toBe('Tumour');
    expect(paintOverLabel('all', list, 7)).toBe('No segment');
  });
});
