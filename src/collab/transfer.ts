/**
 * Moving an image or a mask to someone joining a shared-copy room (`ROOMS.md` C6).
 * A volume goes as slabs of 16 slices, each compressed alone and cut into parts that
 * fit a frame, so neither side ever holds a second copy of the whole volume.
 */

import { Gunzip } from 'fflate';

export const SLAB_SLICES = 16;
/** Compressed bytes per frame. With the header and encryption it stays well under the relay's 2 MiB. */
export const PART_BYTES = 1 << 20;

/** `[first slice, one past the last]` for each slab of a volume `depth` slices deep. */
export function slabRanges(depth: number): [number, number][] {
  const out: [number, number][] = [];
  for (let z = 0; z < depth; z += SLAB_SLICES) out.push([z, Math.min(depth, z + SLAB_SLICES)]);
  return out;
}

export function splitParts(bytes: Uint8Array, size = PART_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.subarray(o, Math.min(bytes.length, o + size)));
  return out.length ? out : [bytes];
}

/**
 * The most a packed slab of `raw` bytes can weigh. Data that does not compress grows by a
 * few bytes per block, never by much; anything larger was not made by packing that slab.
 */
export function maxPacked(raw: number): number {
  return raw + Math.ceil(raw / 1000) + 1024;
}

/**
 * Unpacks gzip data that must come out exactly `length` bytes long. Null for anything else.
 * It stops as soon as more comes out than expected, so a few kilobytes that would unpack
 * into gigabytes cost a few milliseconds instead of the memory and the minutes.
 */
export function gunzipExactly(bytes: Uint8Array, length: number): Uint8Array | null {
  if (bytes.length < 18 || !Number.isInteger(length) || length < 0) return null;
  const out = new Uint8Array(length);
  let n = 0;
  let over = false;
  try {
    const stream = new Gunzip((chunk) => {
      if (over) return;
      if (n + chunk.length > length) {
        over = true;
        return;
      }
      out.set(chunk, n);
      n += chunk.length;
    });
    // In small steps: one step of well-packed input can already unpack to megabytes.
    const STEP = 16 << 10;
    for (let o = 0; o < bytes.length && !over; o += STEP) stream.push(bytes.subarray(o, Math.min(bytes.length, o + STEP)), o + STEP >= bytes.length);
  } catch {
    return null;
  }
  return over || n !== length ? null : out;
}

/** Collects the parts of one slab at a time; they arrive in order on one connection. */
export class PartAssembler {
  private key = '';
  private parts: Uint8Array[] = [];
  /** Bytes waiting for the rest of their slab. */
  held = 0;

  private drop(): null {
    this.key = '';
    this.parts = [];
    this.held = 0;
    return null;
  }

  /**
   * Returns the whole slab once its last part is in. A part out of step drops the slab,
   * and so does a slab that grows past `max` bytes: the sender says how many parts there
   * are, so without a limit it could keep a receiver collecting for ever.
   */
  push(key: string, part: number, parts: number, bytes: Uint8Array, max = Infinity): Uint8Array | null {
    if (!Number.isInteger(part) || part < 0 || !Number.isInteger(parts) || parts < 1) return this.drop();
    if (part === 0) {
      this.drop();
      this.key = key;
    }
    if (key !== this.key || part !== this.parts.length || part >= parts || this.held + bytes.length > max) return this.drop();
    this.parts.push(bytes);
    this.held += bytes.length;
    if (this.parts.length < parts) return null;
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    this.drop();
    return out;
  }
}

/** An allowance that refills over time: `size` at most, `perSecond` coming back. */
export class TokenBucket {
  private have: number;
  private at: number;

  constructor(
    private readonly size: number,
    private readonly perSecond: number,
    now: number,
  ) {
    this.have = size;
    this.at = now;
  }

  private refill(now: number): void {
    this.have = Math.min(this.size, this.have + (Math.max(0, now - this.at) / 1000) * this.perSecond);
    this.at = now;
  }

  /** Spends `cost` if there is enough. */
  take(cost: number, now: number): boolean {
    this.refill(now);
    if (this.have < cost) return false;
    this.have -= cost;
    return true;
  }

  /** Milliseconds until `cost` can be spent. A cost above the size waits for a full bucket. */
  wait(cost: number, now: number): number {
    this.refill(now);
    const need = Math.min(cost, this.size) - this.have;
    return need <= 0 ? 0 : Math.ceil((need / this.perSecond) * 1000);
  }

  /** Spends `cost` even if that leaves a debt, for a sender that has already waited. */
  spend(cost: number, now: number): void {
    this.refill(now);
    this.have -= cost;
  }
}
