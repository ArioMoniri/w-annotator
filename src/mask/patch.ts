/**
 * A patch is the set of voxels that changed between two versions of a mask,
 * stored as runs of consecutive voxel indices. It is what undo, redo and the
 * room sync all pass around.
 */
export interface Patch {
  starts: Uint32Array;
  lengths: Uint32Array;
  /** Values before the change, all runs back to back. Empty for patches received from the network. */
  before: Uint8Array;
  /** Values after the change, all runs back to back. */
  after: Uint8Array;
}

export function diffMask(
  prev: Uint8Array,
  cur: Uint8Array,
  sliceSize: number,
  slices?: number[],
): Patch | null {
  const sliceCount = Math.floor(cur.length / sliceSize);
  let order: number[];
  if (slices) {
    order = [...new Set(slices)].filter((s) => Number.isInteger(s) && s >= 0 && s < sliceCount).sort((a, b) => a - b);
  } else {
    order = Array.from({ length: sliceCount }, (_, i) => i);
  }

  const starts: number[] = [];
  const lengths: number[] = [];
  let total = 0;
  for (const s of order) {
    const end = (s + 1) * sliceSize;
    let i = s * sliceSize;
    while (i < end) {
      if (prev[i] === cur[i]) {
        i++;
        continue;
      }
      const start = i;
      while (i < end && prev[i] !== cur[i]) i++;
      const last = starts.length - 1;
      if (last >= 0 && starts[last] + lengths[last] === start) {
        lengths[last] += i - start;
      } else {
        starts.push(start);
        lengths.push(i - start);
      }
      total += i - start;
    }
  }
  if (total === 0) return null;

  const before = new Uint8Array(total);
  const after = new Uint8Array(total);
  let o = 0;
  for (let r = 0; r < starts.length; r++) {
    before.set(prev.subarray(starts[r], starts[r] + lengths[r]), o);
    after.set(cur.subarray(starts[r], starts[r] + lengths[r]), o);
    o += lengths[r];
  }
  return { starts: Uint32Array.from(starts), lengths: Uint32Array.from(lengths), before, after };
}

export function applyPatch(buf: Uint8Array, patch: Patch, side: 'before' | 'after'): void {
  const values = patch[side];
  let o = 0;
  for (let r = 0; r < patch.starts.length; r++) {
    const start = patch.starts[r];
    const len = patch.lengths[r];
    if (start + len > buf.length || o + len > values.length) {
      throw new Error('Patch does not fit this mask');
    }
    buf.set(values.subarray(o, o + len), start);
    o += len;
  }
}

export function patchVoxelCount(patch: Patch): number {
  return patch.after.length;
}

export function patchSlices(patch: Patch, sliceSize: number): number[] {
  const set = new Set<number>();
  for (let r = 0; r < patch.starts.length; r++) {
    const first = Math.floor(patch.starts[r] / sliceSize);
    const last = Math.floor((patch.starts[r] + patch.lengths[r] - 1) / sliceSize);
    for (let s = first; s <= last; s++) set.add(s);
  }
  return [...set].sort((a, b) => a - b);
}

/** Wire format: u32 run count, then (u32 start, u32 length) per run, then the after values. */
export function encodePatch(patch: Patch): Uint8Array {
  const n = patch.starts.length;
  const out = new Uint8Array(4 + n * 8 + patch.after.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, n, true);
  for (let r = 0; r < n; r++) {
    view.setUint32(4 + r * 8, patch.starts[r], true);
    view.setUint32(8 + r * 8, patch.lengths[r], true);
  }
  out.set(patch.after, 4 + n * 8);
  return out;
}

export function decodePatch(bytes: Uint8Array): Patch {
  if (bytes.length < 4) throw new Error('Patch is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  if (bytes.length < 4 + n * 8) throw new Error('Patch is too short');
  const starts = new Uint32Array(n);
  const lengths = new Uint32Array(n);
  let total = 0;
  for (let r = 0; r < n; r++) {
    starts[r] = view.getUint32(4 + r * 8, true);
    lengths[r] = view.getUint32(8 + r * 8, true);
    total += lengths[r];
  }
  if (bytes.length !== 4 + n * 8 + total) throw new Error('Patch length does not match its header');
  return { starts, lengths, before: new Uint8Array(0), after: bytes.slice(4 + n * 8) };
}

/**
 * Undo or redo in a shared mask: a voxel is only changed if it still holds the
 * value this patch left there, so someone else's later edit is never erased.
 * Returns what was actually written, or null if nothing was.
 */
export function applyPatchWhereUnchanged(buf: Uint8Array, patch: Patch, side: 'before' | 'after'): Patch | null {
  const want = patch[side];
  const expect = side === 'before' ? patch.after : patch.before;
  const starts: number[] = [];
  const lengths: number[] = [];
  const before: number[] = [];
  const after: number[] = [];
  let o = 0;
  for (let r = 0; r < patch.starts.length; r++) {
    const start = patch.starts[r];
    const len = patch.lengths[r];
    if (start + len > buf.length || o + len > want.length || o + len > expect.length) {
      throw new Error('Patch does not fit this mask');
    }
    let runStart = -1;
    for (let i = 0; i < len; i++) {
      const at = start + i;
      if (buf[at] === expect[o + i] && want[o + i] !== buf[at]) {
        if (runStart < 0) {
          runStart = at;
          starts.push(at);
          lengths.push(0);
        }
        lengths[lengths.length - 1]++;
        before.push(buf[at]);
        after.push(want[o + i]);
        buf[at] = want[o + i];
      } else {
        runStart = -1;
      }
    }
    o += len;
  }
  if (starts.length === 0) return null;
  return {
    starts: Uint32Array.from(starts),
    lengths: Uint32Array.from(lengths),
    before: Uint8Array.from(before),
    after: Uint8Array.from(after),
  };
}

/**
 * "Paint over: Empty only". Puts back, in `cur`, every voxel that the patch
 * changed from one segment to another, so painting never takes voxels from a
 * neighbour. Erasing is left alone. Returns how many voxels were put back.
 */
export function restoreOverwritten(cur: Uint8Array, patch: Patch): number {
  let restored = 0;
  let o = 0;
  for (let r = 0; r < patch.starts.length; r++) {
    const start = patch.starts[r];
    const len = patch.lengths[r];
    for (let i = 0; i < len; i++, o++) {
      const before = patch.before[o];
      if (before !== 0 && patch.after[o] !== 0) {
        cur[start + i] = before;
        restored++;
      }
    }
  }
  return restored;
}

/**
 * Cuts a patch into pieces whose encoded size is at most `maxBytes` each, so a large
 * edit fits the messages a room allows. Applied in order, the pieces equal the patch.
 */
export function splitPatch(patch: Patch, maxBytes: number): Patch[] {
  if (4 + patch.starts.length * 8 + patch.after.length <= maxBytes) return [patch];
  const out: Patch[] = [];
  let starts: number[] = [];
  let lengths: number[] = [];
  let from = 0;
  let o = 0;
  let size = 4;
  const hasBefore = patch.before.length === patch.after.length;
  const close = () => {
    if (starts.length === 0) return;
    out.push({
      starts: Uint32Array.from(starts),
      lengths: Uint32Array.from(lengths),
      before: hasBefore ? patch.before.slice(from, o) : new Uint8Array(0),
      after: patch.after.slice(from, o),
    });
    starts = [];
    lengths = [];
    from = o;
    size = 4;
  };
  for (let r = 0; r < patch.starts.length; r++) {
    let start = patch.starts[r];
    let left = patch.lengths[r];
    while (left > 0) {
      // A run costs 8 bytes plus one per voxel; start a new piece when not even one voxel fits.
      if (size + 9 > maxBytes) close();
      const take = Math.min(left, maxBytes - size - 8);
      starts.push(start);
      lengths.push(take);
      size += 8 + take;
      o += take;
      start += take;
      left -= take;
    }
  }
  close();
  return out;
}
