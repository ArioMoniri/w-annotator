import { describe, expect, it } from 'vitest';
import type { SegmentInfo } from './protocol';
import { applySegOp, parseSegOp, segmentOps } from './segops';

const seg = (index: number, name = `Segment ${index}`, more: Partial<SegmentInfo> = {}): SegmentInfo => ({ index, name, color: '#E69F00', visible: true, locked: false, ...more });

describe('segmentOps', () => {
  it('is empty when nothing a room cares about changed', () => {
    expect(segmentOps([seg(1)], [seg(1)])).toEqual([]);
    // Showing or hiding a segment is a personal view setting.
    expect(segmentOps([seg(1)], [seg(1, 'Segment 1', { visible: false })])).toEqual([]);
  });

  it('describes an added, a changed and a deleted segment, one small message each', () => {
    const ops = segmentOps([seg(1), seg(2)], [seg(1, 'Liver'), seg(3)]);
    expect(ops).toEqual([
      { op: 'set', seg: { index: 1, name: 'Liver', color: '#E69F00', locked: false } },
      { op: 'set', seg: { index: 3, name: 'Segment 3', color: '#E69F00', locked: false } },
      { op: 'del', index: 2 },
    ]);
  });
});

describe('applySegOp', () => {
  it('adds in index order and keeps my own visibility on a change', () => {
    let list = applySegOp([seg(1, 'A', { visible: false }), seg(3)], { op: 'set', seg: { index: 2, name: 'B', color: '#000000', locked: true } });
    expect(list.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(list[1]).toEqual({ index: 2, name: 'B', color: '#000000', locked: true, visible: true });
    list = applySegOp(list, { op: 'set', seg: { index: 1, name: 'Liver', color: '#111111', locked: false } });
    expect(list[0]).toEqual({ index: 1, name: 'Liver', color: '#111111', locked: false, visible: false });
  });

  it('deletes', () => {
    expect(applySegOp([seg(1), seg(2)], { op: 'del', index: 1 }).map((s) => s.index)).toEqual([2]);
  });

  it('a rename and an add made at the same moment both survive, in either order', () => {
    const start = [seg(1)];
    const rename = segmentOps(start, [seg(1, 'Liver')])[0];
    const add = segmentOps(start, [seg(1), seg(2, 'Spleen')])[0];
    const one = applySegOp(applySegOp(start, rename), add);
    const other = applySegOp(applySegOp(start, add), rename);
    expect(one).toEqual(other);
    expect(one.map((s) => s.name)).toEqual(['Liver', 'Spleen']);
  });
});

describe('parseSegOp', () => {
  it('accepts well-formed messages and trims what they carry', () => {
    expect(parseSegOp({ op: 'del', index: 4 })).toEqual({ op: 'del', index: 4 });
    expect(parseSegOp({ op: 'set', seg: { index: 2, name: `  ${'x'.repeat(200)}`, color: '#abcdef', locked: 1, extra: 'no' } })).toEqual({
      op: 'set',
      seg: { index: 2, name: 'x'.repeat(64), color: '#abcdef', locked: true },
    });
    expect(parseSegOp({ op: 'window' })).toEqual({ op: 'window' });
  });

  it('rejects anything else', () => {
    expect(parseSegOp({ op: 'del', index: 0 })).toBeNull();
    expect(parseSegOp({ op: 'del', index: 300 })).toBeNull();
    expect(parseSegOp({ op: 'set', seg: { index: 2, name: '', color: '#abcdef' } })).toBeNull();
    expect(parseSegOp({ op: 'set', seg: { index: 2, name: 'A', color: 'red; background: url(x)' } })).toBeNull();
    expect(parseSegOp({ op: 'nope' })).toBeNull();
  });
});
