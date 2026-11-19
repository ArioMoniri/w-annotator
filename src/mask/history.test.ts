import { describe, expect, it } from 'vitest';
import { History } from './history';
import { diffMask, type Patch } from './patch';

function patch(index: number, value: number): Patch {
  const a = new Uint8Array(8);
  const b = new Uint8Array(8);
  b[index] = value;
  return diffMask(a, b, 8)!;
}

describe('History', () => {
  it('groups patches of one stroke into one undo step', () => {
    const h = new History();
    h.add(patch(0, 1));
    h.add(patch(1, 1));
    h.commit();
    h.add(patch(2, 1));
    h.commit();
    expect(h.canUndo).toBe(true);
    expect(h.undo()!.length).toBe(1);
    expect(h.undo()!.length).toBe(2);
    expect(h.undo()).toBeNull();
  });

  it('undo returns patches newest first', () => {
    const h = new History();
    const first = patch(0, 1);
    const second = patch(1, 1);
    h.add(first);
    h.add(second);
    h.commit();
    expect(h.undo()).toEqual([second, first]);
  });

  it('redo replays in the original order and a new edit clears it', () => {
    const h = new History();
    const first = patch(0, 1);
    const second = patch(1, 1);
    h.add(first);
    h.add(second);
    h.commit();
    h.undo();
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toEqual([first, second]);
    h.undo();
    h.add(patch(3, 1));
    h.commit();
    expect(h.canRedo).toBe(false);
  });

  it('commit with nothing pending adds no step', () => {
    const h = new History();
    h.commit();
    expect(h.canUndo).toBe(false);
  });

  it('drops the oldest steps past the limit', () => {
    const h = new History(2);
    for (let i = 0; i < 3; i++) {
      h.add(patch(i, 1));
      h.commit();
    }
    expect(h.undo()).not.toBeNull();
    expect(h.undo()).not.toBeNull();
    expect(h.undo()).toBeNull();
  });

  it('clear empties everything', () => {
    const h = new History();
    h.add(patch(0, 1));
    h.commit();
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
