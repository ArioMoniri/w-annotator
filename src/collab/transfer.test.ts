import { describe, expect, it } from 'vitest';
import { PartAssembler, SLAB_SLICES, TokenBucket, slabRanges, splitParts } from './transfer';

describe('slabs', () => {
  it('cuts a volume into runs of 16 slices', () => {
    expect(SLAB_SLICES).toBe(16);
    expect(slabRanges(40)).toEqual([
      [0, 16],
      [16, 32],
      [32, 40],
    ]);
    expect(slabRanges(16)).toEqual([[0, 16]]);
    expect(slabRanges(0)).toEqual([]);
  });

  it('splits bytes into parts no larger than asked, and always at least one', () => {
    const parts = splitParts(Uint8Array.from({ length: 10 }, (_, i) => i), 4);
    expect(parts.map((p) => Array.from(p))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(splitParts(new Uint8Array(0), 4).length).toBe(1);
  });

  it('puts the parts of a slab back together', () => {
    const a = new PartAssembler();
    expect(a.push('mask:0', 0, 2, Uint8Array.from([1, 2]))).toBeNull();
    expect(Array.from(a.push('mask:0', 1, 2, Uint8Array.from([3]))!)).toEqual([1, 2, 3]);
    expect(Array.from(a.push('mask:16', 0, 1, Uint8Array.from([9]))!)).toEqual([9]);
  });

  it('drops a slab whose parts arrive out of step', () => {
    const a = new PartAssembler();
    a.push('mask:0', 0, 3, Uint8Array.from([1]));
    expect(a.push('mask:0', 2, 3, Uint8Array.from([3]))).toBeNull();
    // Starting again from the first part works.
    a.push('mask:0', 0, 2, Uint8Array.from([1]));
    expect(Array.from(a.push('mask:0', 1, 2, Uint8Array.from([2]))!)).toEqual([1, 2]);
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then refills at its rate', () => {
    const b = new TokenBucket(30, 10, 0);
    for (let i = 0; i < 30; i++) expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(false);
    expect(b.take(1, 100)).toBe(true);
    expect(b.take(1, 100)).toBe(false);
    // Never holds more than its size.
    for (let i = 0; i < 30; i++) expect(b.take(1, 60_000)).toBe(true);
    expect(b.take(1, 60_000)).toBe(false);
  });

  it('says how long to wait for a cost it cannot cover yet', () => {
    const b = new TokenBucket(100, 50, 0);
    expect(b.wait(100, 0)).toBe(0);
    expect(b.take(100, 0)).toBe(true);
    expect(b.wait(50, 0)).toBe(1000);
    expect(b.wait(50, 500)).toBe(500);
    // A cost larger than the bucket waits for a full bucket, not for ever.
    const empty = new TokenBucket(100, 50, 0);
    empty.take(100, 0);
    expect(empty.wait(500, 0)).toBe(2000);
  });
});
