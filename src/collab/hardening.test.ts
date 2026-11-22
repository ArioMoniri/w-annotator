/**
 * What a room member, or whoever runs the room server, could send to hurt another member.
 * One test for each weakness the security review found (`docs/reviews/rooms-security.md`).
 */
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodePatch, encodePatch, patchFits } from '../mask/patch';
import { ReplayGuard } from './guard';
import { decodeSlice, encodeSlice } from './hostview';
import { parseSegOp } from './segops';
import { PartAssembler, gunzipExactly, maxPacked } from './transfer';

describe('compressed data from someone else', () => {
  it('unpacks what has the expected size', () => {
    const raw = Uint8Array.from({ length: 5000 }, (_, i) => i % 7);
    expect(Array.from(gunzipExactly(gzipSync(raw), raw.length)!)).toEqual(Array.from(raw));
  });

  it('stops at the expected size instead of unpacking a bomb', () => {
    // 64 MB of zeros packs into about 64 KB.
    const bomb = gzipSync(new Uint8Array(64 << 20), { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    const started = performance.now();
    expect(gunzipExactly(bomb, 4096)).toBeNull();
    // Unpacking all of it takes most of a second; giving up early takes a few milliseconds.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('refuses a size that lies, short data and rubbish', () => {
    const raw = new Uint8Array(1000).fill(3);
    const packed = gzipSync(raw);
    const lying = packed.slice();
    new DataView(lying.buffer).setUint32(lying.length - 4, 10, true);
    expect(gunzipExactly(lying, 10)).toBeNull();
    expect(gunzipExactly(packed, 999)).toBeNull();
    expect(gunzipExactly(packed, 1001)).toBeNull();
    expect(gunzipExactly(packed.subarray(0, packed.length - 9), 1000)).toBeNull();
    expect(gunzipExactly(Uint8Array.from([1, 2, 3]), 3)).toBeNull();
    expect(gunzipExactly(new Uint8Array(0), 0)).toBeNull();
  });

  it('gives a host-view guest a plane only when it is exactly the plane asked for', () => {
    const image = new Uint8Array(12).fill(200);
    const labels = new Uint8Array(12).fill(1);
    expect(decodeSlice(encodeSlice(image, labels), 12)).not.toBeNull();
    expect(decodeSlice(encodeSlice(image, labels), 11)).toBeNull();
    const bomb = gzipSync(new Uint8Array(64 << 20), { level: 9 });
    const started = performance.now();
    expect(decodeSlice(bomb, 512 * 512)).toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('PartAssembler limits', () => {
  it('drops a slab that grows past what it may hold', () => {
    const a = new PartAssembler();
    const part = new Uint8Array(40);
    expect(a.push('m0', 0, 1000, part, 100)).toBeNull();
    expect(a.push('m0', 1, 1000, part, 100)).toBeNull();
    // The third part would make 120 bytes of a slab that may hold 100.
    expect(a.push('m0', 2, 1000, part, 100)).toBeNull();
    expect(a.held).toBe(0);
    // And it does not come back to life with the next part.
    expect(a.push('m0', 3, 4, part, 100)).toBeNull();
    expect(a.held).toBe(0);
  });

  it('refuses part counts that make no sense', () => {
    const a = new PartAssembler();
    const part = new Uint8Array(4);
    expect(a.push('m0', 0, 0, part, 100)).toBeNull();
    expect(a.push('m0', 0, Number.NaN, part, 100)).toBeNull();
    expect(a.push('m0', 0, 1.5, part, 100)).toBeNull();
    expect(a.push('m0', Number.NaN, 2, part, 100)).toBeNull();
    expect(a.held).toBe(0);
    expect(a.push('m0', 0, 1, part, 100)).not.toBeNull();
  });

  it('allows a packed slab a little more than its raw size and no more', () => {
    // Data that does not compress grows by a few bytes per block.
    expect(maxPacked(8 << 20)).toBeGreaterThan(8 << 20);
    expect(maxPacked(8 << 20)).toBeLessThan((8 << 20) * 1.02 + 2048);
    const noise = Uint8Array.from({ length: 200_000 }, (_, i) => (Math.imul(i, 2654435761) >>> 13) & 255);
    expect(gzipSync(noise, { level: 1 }).length).toBeLessThanOrEqual(maxPacked(noise.length));
  });
});

describe('a patch from someone else', () => {
  const patch = (runs: [number, number][]) =>
    decodePatch(
      encodePatch({
        starts: Uint32Array.from(runs.map((r) => r[0])),
        lengths: Uint32Array.from(runs.map((r) => r[1])),
        before: new Uint8Array(0),
        after: new Uint8Array(runs.reduce((n, r) => n + r[1], 0)).fill(1),
      }),
    );

  it('fits when every run is inside the mask', () => {
    expect(patchFits(patch([[0, 4], [96, 4]]), 100)).toBe(true);
    expect(patchFits(patch([]), 100)).toBe(true);
  });

  it('does not fit when any run reaches outside, even after good ones', () => {
    expect(patchFits(patch([[0, 4], [98, 4]]), 100)).toBe(false);
    expect(patchFits(patch([[100, 1]]), 100)).toBe(false);
    expect(patchFits(patch([[0xffffffff, 1]]), 100)).toBe(false);
    // Zero-length runs are harmless inside the mask and refused outside it.
    expect(patchFits(patch([[100, 0]]), 100)).toBe(true);
    expect(patchFits(patch([[101, 0]]), 100)).toBe(false);
  });

  it('does not fit when its values do not match its runs', () => {
    const p = patch([[0, 4]]);
    expect(patchFits({ ...p, after: p.after.subarray(0, 3) }, 100)).toBe(false);
  });
});

describe('ReplayGuard', () => {
  it('takes each edit of a sender once, in the sender order', () => {
    const g = new ReplayGuard();
    expect(g.fresh(7, 'a', 1)).toBe(true);
    expect(g.fresh(7, 'a', 2)).toBe(true);
    // The room server sends an old edit again: refused.
    expect(g.fresh(7, 'a', 1)).toBe(false);
    expect(g.fresh(7, 'a', 2)).toBe(false);
    expect(g.fresh(7, 'a', 5)).toBe(true);
    expect(g.fresh(7, 'a', 4)).toBe(false);
  });

  it('keeps senders and their sessions apart', () => {
    const g = new ReplayGuard();
    expect(g.fresh(7, 'a', 3)).toBe(true);
    expect(g.fresh(8, 'a', 1)).toBe(true);
    // The same person after leaving and coming back starts counting again under a new tag.
    expect(g.fresh(7, 'b', 1)).toBe(true);
    // An edit from the earlier visit is still known.
    expect(g.fresh(7, 'a', 3)).toBe(false);
  });

  it('refuses numbers and tags that cannot be real', () => {
    const g = new ReplayGuard();
    expect(g.fresh(7, 'a', 0)).toBe(false);
    expect(g.fresh(7, 'a', -1)).toBe(false);
    expect(g.fresh(7, 'a', 1.5)).toBe(false);
    expect(g.fresh(7, 'a', Number.NaN)).toBe(false);
    expect(g.fresh(7, '', 1)).toBe(false);
    expect(g.fresh(7, 'x'.repeat(40), 1)).toBe(false);
  });

  it('hands what it knows to someone joining, who then refuses the same replays', () => {
    const g = new ReplayGuard();
    g.fresh(7, 'a', 4);
    g.fresh(9, 'q', 2);
    const joiner = new ReplayGuard();
    joiner.load(JSON.parse(JSON.stringify(g.dump())));
    expect(joiner.fresh(7, 'a', 4)).toBe(false);
    expect(joiner.fresh(7, 'a', 5)).toBe(true);
    expect(joiner.fresh(9, 'q', 2)).toBe(false);
  });

  it('ignores a hand-over that is not what it should be, and stays bounded', () => {
    const g = new ReplayGuard();
    for (const bad of [null, 7, 'x', [[1, 'a']], [[1, 'a', 'b']], [['1', 'a', 2]], [[1, 2, 3]], { a: 1 }]) g.load(bad);
    expect(g.dump()).toEqual([]);
    // A sender who keeps coming back does not make the list grow for ever.
    for (let i = 0; i < 100; i++) g.fresh(7, `s${i}`, 1);
    expect(g.dump().length).toBeLessThanOrEqual(16);
    // The newest are the ones kept.
    expect(g.fresh(7, 's99', 1)).toBe(false);
    g.load(Array.from({ length: 5000 }, (_, i) => [i + 1, 't', 1]));
    expect(g.dump().length).toBeLessThanOrEqual(16 * 64);
  });
});

describe('a segment name from someone else', () => {
  it('loses what could disguise it', () => {
    const op = parseSegOp({ op: 'set', seg: { index: 1, name: 'Liver\u202E\u0007 (left)', color: '#ff0000', locked: false } });
    expect(op).toEqual({ op: 'set', seg: { index: 1, name: 'Liver (left)', color: '#ff0000', locked: false } });
    expect(parseSegOp({ op: 'set', seg: { index: 1, name: '\u200B\u202E', color: '#ff0000' } })).toBeNull();
  });
});

describe("the host's window, for a guest who sees through the host", () => {
  it('travels with the message that says the window changed', () => {
    expect(parseSegOp({ op: 'window', voi: [-1350, 150] })).toEqual({ op: 'window', voi: [-1350, 150] });
    // An older host says only that it changed.
    expect(parseSegOp({ op: 'window' })).toEqual({ op: 'window' });
    // Anything that is not two finite numbers in order is left out.
    for (const voi of [[1], [1, 'x'], [5, 5], [9, 1], [Number.NaN, 1], 'x', null]) expect(parseSegOp({ op: 'window', voi })).toEqual({ op: 'window' });
  });
});
