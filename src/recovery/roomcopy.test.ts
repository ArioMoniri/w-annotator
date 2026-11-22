import { describe, expect, it } from 'vitest';
import { isRecoveryKey } from '../mask/recovery';
import {
  ROOM_COPY_KEEP_MS,
  decodeRoomCopy,
  encodeRoomCopy,
  isRoomCopyKey,
  maskHash,
  roomCopyExpired,
  roomCopyFits,
  roomCopyKey,
  shouldKeepRoomCopy,
  type RoomCopyHeader,
} from './roomcopy';

const IMAGE = '0123456789abcdef0123456789abcdef';

const header = (over: Partial<RoomCopyHeader> = {}): RoomCopyHeader => ({
  v: 1,
  key: IMAGE,
  room: 'K7Q2M9XA4TDP',
  session: 'q83vEjRWeJA',
  head: 41,
  dims: [4, 4, 2],
  mine: 'aabbccdd00112233',
  offlineSegs: [2],
  guard: [[7, 'tag', 3]],
  savedAt: 1000,
  base: 3,
  review: { at: 900, bytes: 2 },
  ...over,
});

describe('where the room copy is kept', () => {
  it('has a key of its own beside the recovery copy of the same image', () => {
    const key = roomCopyKey(IMAGE);
    expect(key).not.toBe(IMAGE);
    expect(key.startsWith(IMAGE)).toBe(true);
    // The desktop store takes it as it takes any key.
    expect(isRecoveryKey(key)).toBe(true);
    expect(isRoomCopyKey(key)).toBe(true);
    expect(isRoomCopyKey(IMAGE)).toBe(false);
  });
});

describe('the room copy', () => {
  it('round-trips: what the room had, and what a merge kept aside', () => {
    const bytes = encodeRoomCopy(header(), Uint8Array.of(1, 2, 3), Uint8Array.of(9, 8));
    const back = decodeRoomCopy(bytes)!;
    expect(back.header).toEqual(header());
    expect(Array.from(back.base!)).toEqual([1, 2, 3]);
    expect(Array.from(back.review!)).toEqual([9, 8]);
  });

  it('can hold only one of the two', () => {
    const onlyBase = decodeRoomCopy(encodeRoomCopy(header({ review: null }), Uint8Array.of(1, 2, 3), null))!;
    expect(onlyBase.review).toBeNull();
    expect(onlyBase.base).toHaveLength(3);
    const onlyReview = decodeRoomCopy(encodeRoomCopy(header({ base: 0 }), null, Uint8Array.of(9, 8)))!;
    expect(onlyReview.base).toBeNull();
    expect(Array.from(onlyReview.review!)).toEqual([9, 8]);
  });

  it('is not taken when it is anything else', () => {
    const good = encodeRoomCopy(header(), Uint8Array.of(1, 2, 3), Uint8Array.of(9, 8));
    expect(decodeRoomCopy(good.subarray(0, good.length - 1))).toBeNull();
    expect(decodeRoomCopy(new Uint8Array(4))).toBeNull();
    const other = good.slice();
    other[0] = 0x58;
    expect(decodeRoomCopy(other)).toBeNull();
    // A recovery copy of the mask is another kind of file.
    expect(decodeRoomCopy(new TextEncoder().encode('WREC\u0000\u0000\u0000\u0000'))).toBeNull();
    for (const bad of [{ v: 2 }, { head: -1 }, { dims: [4, 4] }, { room: 5 }, { mine: 7 }, { offlineSegs: 'x' }, { base: -3 }, { review: { at: 'x', bytes: 2 } }]) {
      const broken = encodeRoomCopy({ ...header(), ...(bad as object) } as RoomCopyHeader, Uint8Array.of(1, 2, 3), Uint8Array.of(9, 8));
      expect(decodeRoomCopy(broken)).toBeNull();
    }
  });
});

describe('which mask a room copy belongs to', () => {
  it('tells masks apart by their voxels', () => {
    const a = new Uint8Array(1003);
    const b = a.slice();
    expect(maskHash(a)).toBe(maskHash(b));
    expect(maskHash(a)).toMatch(/^[0-9a-f]{16}$/);
    // One voxel anywhere, also in the last bytes that do not fill a word.
    for (const at of [0, 500, 1000, 1002]) {
      const c = a.slice();
      c[at] = 1;
      expect(maskHash(c)).not.toBe(maskHash(a));
    }
    // The same values in other places.
    const d = a.slice();
    const e = a.slice();
    d[8] = 3;
    e[12] = 3;
    expect(maskHash(d)).not.toBe(maskHash(e));
    expect(maskHash(new Uint8Array(1004))).not.toBe(maskHash(a));
  });

  it('fits only the image and the exact mask it was written for', () => {
    const data = new Uint8Array(32);
    const h = header({ mine: maskHash(data) });
    expect(roomCopyFits(h, IMAGE, [4, 4, 2], data)).toBe(true);
    expect(roomCopyFits(h, 'f'.repeat(32), [4, 4, 2], data)).toBe(false);
    expect(roomCopyFits(h, IMAGE, [4, 2, 4], data)).toBe(false);
    // An older file of the same mask, or one edited elsewhere: merging against this base could undo the room's work.
    const older = data.slice();
    older[5] = 1;
    expect(roomCopyFits(h, IMAGE, [4, 4, 2], older)).toBe(false);
  });

  it('is kept as long as a membership lasts', () => {
    expect(ROOM_COPY_KEEP_MS).toBe(30 * 24 * 3600 * 1000);
    expect(roomCopyExpired(header(), 1000 + ROOM_COPY_KEEP_MS - 1)).toBe(false);
    expect(roomCopyExpired(header(), 1000 + ROOM_COPY_KEEP_MS)).toBe(true);
  });
});

describe('who keeps a room copy', () => {
  it('only a shared-copy room leaves one, and only with autosave on', () => {
    expect(shouldKeepRoomCopy({ autosave: true, guestView: false })).toBe(true);
    // A guest of a view-through-host room keeps nothing on the device.
    expect(shouldKeepRoomCopy({ autosave: true, guestView: true })).toBe(false);
    // Autosave off means no copies of the mask on this device, this one included.
    expect(shouldKeepRoomCopy({ autosave: false, guestView: false })).toBe(false);
  });
});
