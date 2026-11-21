import { describe, expect, it } from 'vitest';
import { countIslands, islandAt, splitIslands } from './ops';

type Dims = [number, number, number];

function volume(dims: Dims) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const at = (x: number, y: number, z: number) => x + y * dims[0] + z * dims[0] * dims[1];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, label = 1) => {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[at(x, y, z)] = label;
  };
  const count = (label = 1) => mask.reduce((n, v) => n + (v === label ? 1 : 0), 0);
  return { mask, at, box, count };
}

/**
 * Four pieces of segment 1: a 2 × 2 × 2 block, a voxel touching it by a face on the next
 * slice, a voxel touching it only by an edge, and a voxel touching only by a corner.
 */
function phantom() {
  const dims: Dims = [8, 8, 5];
  const v = volume(dims);
  v.box(1, 1, 1, 2, 2, 2);
  v.mask[v.at(2, 2, 3)] = 1; // face
  v.mask[v.at(3, 3, 1)] = 1; // edge
  v.mask[v.at(3, 3, 3)] = 1; // corner
  v.box(6, 6, 0, 6, 6, 0, 2);
  return { dims, ...v };
}

describe('the island under a click', () => {
  it('removes the clicked island and what joins it by a face, nothing else', () => {
    const { dims, mask, at, count } = phantom();
    expect(islandAt(mask, dims, 1, [1, 1, 1], 'remove')).toBe(9);
    expect(count()).toBe(2);
    expect(mask[at(3, 3, 1)]).toBe(1);
    expect(mask[at(3, 3, 3)]).toBe(1);
    expect(count(2)).toBe(1);
  });

  it('removes a one-voxel island that only touches by an edge', () => {
    const { dims, mask, at, count } = phantom();
    expect(islandAt(mask, dims, 1, [3, 3, 1], 'remove')).toBe(1);
    expect(mask[at(3, 3, 1)]).toBe(0);
    expect(count()).toBe(10);
  });

  it('keeps the clicked island and removes the others of that segment', () => {
    const { dims, mask, at, count } = phantom();
    expect(islandAt(mask, dims, 1, [2, 2, 3], 'keep')).toBe(2);
    expect(count()).toBe(9);
    expect(mask[at(2, 2, 3)]).toBe(1);
    expect(count(2)).toBe(1);
  });

  it('does nothing when the click is not on the segment', () => {
    const { dims, mask } = phantom();
    const before = mask.slice();
    expect(islandAt(mask, dims, 1, [5, 5, 4], 'remove')).toBe(0);
    expect(islandAt(mask, dims, 1, [6, 6, 0], 'keep')).toBe(0);
    expect(islandAt(mask, dims, 1, [-1, 0, 0], 'remove')).toBe(0);
    expect(islandAt(mask, dims, 1, [0, 0, 9], 'keep')).toBe(0);
    expect(mask).toEqual(before);
  });

  it('has nothing to remove when the kept island is the only one', () => {
    const dims: Dims = [4, 4, 4];
    const { mask, box } = volume(dims);
    box(1, 1, 1, 2, 2, 2);
    expect(islandAt(mask, dims, 1, [1, 1, 1], 'keep')).toBe(0);
  });
});

describe('splitting islands into segments', () => {
  it('counts islands joined by faces only', () => {
    const { dims, mask } = phantom();
    expect(countIslands(mask, dims, 1)).toBe(3);
    expect(countIslands(mask, dims, 2)).toBe(1);
    expect(countIslands(mask, dims, 9)).toBe(0);
  });

  it('leaves the largest island and gives each other one its own label, largest first', () => {
    const dims: Dims = [12, 4, 4];
    const { mask, at, box, count } = volume(dims);
    box(0, 0, 0, 0, 0, 0); // 1 voxel
    box(2, 0, 0, 4, 2, 2); // 27 voxels
    box(6, 0, 0, 7, 1, 0); // 4 voxels
    box(9, 0, 0, 10, 0, 0); // 2 voxels
    const result = splitIslands(mask, dims, 1, [5, 6, 7, 8]);
    expect(result).toEqual({ changed: 7, labels: [5, 6, 7], left: 0 });
    expect(count(1)).toBe(27);
    expect(mask[at(6, 0, 0)]).toBe(5);
    expect(count(5)).toBe(4);
    expect(count(6)).toBe(2);
    expect(mask[at(0, 0, 0)]).toBe(7);
  });

  it('leaves the smallest islands in the segment when labels run out', () => {
    const dims: Dims = [12, 4, 4];
    const { mask, at, box, count } = volume(dims);
    box(0, 0, 0, 0, 0, 0);
    box(2, 0, 0, 4, 2, 2);
    box(6, 0, 0, 7, 1, 0);
    box(9, 0, 0, 10, 0, 0);
    expect(splitIslands(mask, dims, 1, [9])).toEqual({ changed: 4, labels: [9], left: 2 });
    expect(count(9)).toBe(4);
    expect(mask[at(0, 0, 0)]).toBe(1);
    expect(count(1)).toBe(30);
  });

  it('changes nothing for a segment that is one island', () => {
    const dims: Dims = [4, 4, 4];
    const { mask, box } = volume(dims);
    box(1, 1, 1, 2, 2, 2);
    expect(splitIslands(mask, dims, 1, [2, 3])).toEqual({ changed: 0, labels: [], left: 0 });
  });
});
