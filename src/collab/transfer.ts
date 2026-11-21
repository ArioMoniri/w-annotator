/**
 * Moving an image or a mask to someone joining a shared-copy room (`ROOMS.md` C6).
 * A volume goes as slabs of 16 slices, each compressed alone and cut into parts that
 * fit a frame, so neither side ever holds a second copy of the whole volume.
 */

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

/** Collects the parts of one slab at a time; they arrive in order on one connection. */
export class PartAssembler {
  private key = '';
  private parts: Uint8Array[] = [];

  /** Returns the whole slab once its last part is in. A part out of step drops the slab. */
  push(key: string, part: number, parts: number, bytes: Uint8Array): Uint8Array | null {
    if (part === 0) {
      this.key = key;
      this.parts = [];
    }
    if (key !== this.key || part !== this.parts.length) {
      this.key = '';
      return null;
    }
    this.parts.push(bytes);
    if (this.parts.length < parts) return null;
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    this.key = '';
    this.parts = [];
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
