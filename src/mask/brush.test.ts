import { describe, expect, it } from 'vitest';
import { BRUSH_MAX, brushRadius, cleanBrushSize, minBrushRadius, minBrushSize, stepBrushSize } from './brush';

/** Voxel centres of a slice inside a circle of radius r around (x, y), with the given spacing. */
function painted(x: number, y: number, r: number, sx: number, sy: number): number {
  let n = 0;
  for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) if (Math.hypot(i * sx - x, j * sy - y) <= r) n++;
  return n;
}

describe('minBrushRadius', () => {
  it('reaches a voxel centre from anywhere in the slice, corners included', () => {
    for (const [sx, sy] of [
      [1, 1],
      [0.7, 0.7],
      [0.5, 3],
    ]) {
      const r = minBrushRadius([sx, sy, 9], 2);
      for (let x = 0; x <= sx / 2; x += sx / 20) for (let y = 0; y <= sy / 2; y += sy / 20) expect(painted(x, y, r, sx, sy)).toBeGreaterThanOrEqual(1);
    }
  });

  it('paints one voxel under a cursor at its centre and at most four at a corner', () => {
    const r = minBrushRadius([1, 1, 1], 2);
    expect(painted(0, 0, r, 1, 1)).toBe(1);
    expect(painted(0.5, 0.5, r, 1, 1)).toBe(4);
  });

  it('uses the two spacings in the plane of the view', () => {
    const spacing: [number, number, number] = [0.5, 0.5, 5];
    expect(minBrushRadius(spacing, 2)).toBeCloseTo(0.505 * Math.hypot(0.5, 0.5), 6);
    expect(minBrushRadius(spacing, 0)).toBeCloseTo(0.505 * Math.hypot(0.5, 5), 6);
    expect(minBrushRadius(spacing, 1)).toBeCloseTo(0.505 * Math.hypot(0.5, 5), 6);
  });
});

describe('brushRadius', () => {
  it('is half the diameter when that already paints', () => {
    expect(brushRadius(8, [1, 1, 1.5], 2)).toBe(4);
  });

  it('never drops below the radius that paints the voxel under the cursor', () => {
    expect(brushRadius(1, [1, 1, 1.5], 2)).toBeCloseTo(minBrushRadius([1, 1, 1.5], 2), 6);
    // The same size on a coarser plane of the same scan is widened further.
    expect(brushRadius(1, [1, 1, 1.5], 0)).toBeGreaterThan(brushRadius(1, [1, 1, 1.5], 2));
  });
});

describe('minBrushSize', () => {
  it('is the smallest diameter that paints on the finest plane, rounded up to 0.1 mm', () => {
    expect(minBrushSize([1, 1, 1.5])).toBe(1.5);
    expect(minBrushSize([0.5, 0.5, 5])).toBe(0.8);
    expect(minBrushSize([0.1, 0.1, 0.1])).toBe(0.2);
  });

  it('stays usable for very coarse or odd spacings', () => {
    expect(minBrushSize([40, 40, 40])).toBeLessThan(BRUSH_MAX);
    expect(minBrushSize([0, Number.NaN, 1])).toBeGreaterThan(0);
  });
});

describe('cleanBrushSize', () => {
  it('keeps one decimal below 5 mm and whole numbers from there up', () => {
    expect(cleanBrushSize(1.26, 0.8)).toBe(1.3);
    expect(cleanBrushSize(4.94, 0.8)).toBe(4.9);
    expect(cleanBrushSize(4.96, 0.8)).toBe(5);
    expect(cleanBrushSize(7.4, 0.8)).toBe(7);
  });

  it('clamps to the minimum for the image and to the maximum', () => {
    expect(cleanBrushSize(1, 1.5)).toBe(1.5);
    expect(cleanBrushSize(0, 0.8)).toBe(0.8);
    expect(cleanBrushSize(500, 0.8)).toBe(BRUSH_MAX);
    expect(cleanBrushSize(Number.NaN, 1.5)).toBe(1.5);
  });
});

describe('stepBrushSize', () => {
  it('steps by 2 above 10 mm, by 1 down to 5 mm and by half a millimetre below', () => {
    expect(stepBrushSize(20, 1, 0.8)).toBe(22);
    expect(stepBrushSize(20, -1, 0.8)).toBe(18);
    expect(stepBrushSize(8, -1, 0.8)).toBe(7);
    expect(stepBrushSize(5, -1, 0.8)).toBe(4.5);
    expect(stepBrushSize(4.5, 1, 0.8)).toBe(5);
    expect(stepBrushSize(1.5, -1, 0.8)).toBe(1);
  });

  it('stops at the minimum for the image', () => {
    expect(stepBrushSize(2, -1, 1.5)).toBe(1.5);
    expect(stepBrushSize(1.5, -1, 1.5)).toBe(1.5);
  });
});
