/**
 * What a shared-copy room leaves on this device so that coming back after the app was
 * closed is the same merge as coming back after an hour offline (`ROOMS.md` task 1.11):
 *
 * - the **base**: the mask as the room had confirmed it, with its place in the room's order,
 *   so the return is a three-way merge instead of treating every difference as a conflict;
 * - the **review**: my voxels a merge kept aside, until every slice is decided or seven days pass.
 *
 * Both are only right for one exact mask: the one on screen when they were written. A base
 * merged against an older file of the same mask would hand the room's later work back to the
 * room as "my offline changes" and undo it. So the copy carries a hash of that mask, and is
 * only taken up again by a mask with the same hash; otherwise the return is merged two-way,
 * as before, and nothing is lost.
 *
 * It lives where recovery copies live, under a key of its own, and follows the same rule:
 * with autosave off there are no copies of the mask on this device. A guest of a
 * view-through-host room never writes one. Nothing here leaves the device.
 */

import type { GuardEntry } from '../collab/guard';
import { isRecoveryKey } from '../mask/recovery';

/** A membership lapses after 30 days without connecting; a base is of no use after that. */
export const ROOM_COPY_KEEP_MS = 30 * 24 * 3600 * 1000;

/** "room" in hex, after the image's fingerprint: a valid key that no recovery copy has. */
const SUFFIX = '726f6f6d';

export function roomCopyKey(imageKey: string): string {
  return imageKey + SUFFIX;
}

export function isRoomCopyKey(key: string): boolean {
  return key.length > SUFFIX.length && key.endsWith(SUFFIX) && isRecoveryKey(key.slice(0, -SUFFIX.length));
}

export interface RoomCopyHeader {
  v: 1;
  /** Fingerprint of the image. */
  key: string;
  room: string;
  /** The room server's record the base belongs to (`room.session`). */
  session: string | null;
  /** The base's place in the room's order. */
  head: number;
  dims: [number, number, number];
  /** Hash of my mask as it was when this was written. */
  mine: string;
  /** Segments I changed while edits could not be sent. */
  offlineSegs: number[];
  /** Edits already in the base, so none is taken twice (`ReplayGuard`). */
  guard: GuardEntry[];
  /** This device's place in the chain over the room's edits at `head` (`collab/chain.ts`), or null. */
  claim?: unknown;
  /** The newest key epoch among the edits in the base. */
  minEpoch?: number;
  /** Who may only look, at `head`. */
  viewers?: number[];
  savedAt: number;
  /** Length of the gzip-compressed base that follows the header; 0 when there is none. */
  base: number;
  /** When the merge was, and the length of the gzip-compressed list that follows the base; null when nothing is kept aside. */
  review: { at: number; bytes: number } | null;
}

const MAGIC = [0x57, 0x52, 0x4d, 0x43]; // "WRMC"

/** Magic, header length, header as JSON, then the base and the review as they were compressed. */
export function encodeRoomCopy(header: RoomCopyHeader, base: Uint8Array | null, review: Uint8Array | null): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + (base?.length ?? 0) + (review?.length ?? 0));
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  if (base) out.set(base, 8 + json.length);
  if (review) out.set(review, 8 + json.length + (base?.length ?? 0));
  return out;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function validHeader(h: RoomCopyHeader | null): h is RoomCopyHeader {
  if (!h || h.v !== 1 || typeof h.key !== 'string' || typeof h.room !== 'string' || typeof h.mine !== 'string') return false;
  if (h.session !== null && typeof h.session !== 'string') return false;
  if (!isCount(h.head) || !isCount(h.savedAt) || !isCount(h.base)) return false;
  if (!Array.isArray(h.dims) || h.dims.length !== 3 || !h.dims.every((n) => isCount(n) && n > 0)) return false;
  if (!Array.isArray(h.offlineSegs) || !h.offlineSegs.every(isCount) || !Array.isArray(h.guard)) return false;
  if (h.minEpoch !== undefined && !isCount(h.minEpoch)) return false;
  if (h.viewers !== undefined && (!Array.isArray(h.viewers) || !h.viewers.every(isCount))) return false;
  if (h.review !== null && (typeof h.review !== 'object' || !isCount(h.review.at) || !isCount(h.review.bytes) || h.review.bytes === 0)) return false;
  return true;
}

/** Null for anything that is not a whole room copy. */
export function decodeRoomCopy(bytes: Uint8Array): { header: RoomCopyHeader; base: Uint8Array | null; review: Uint8Array | null } | null {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + length > bytes.length) return null;
  let header: RoomCopyHeader | null;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as RoomCopyHeader;
  } catch {
    return null;
  }
  if (!validHeader(header)) return null;
  const start = 8 + length;
  const reviewBytes = header.review?.bytes ?? 0;
  if (start + header.base + reviewBytes !== bytes.length) return null;
  return {
    header,
    base: header.base ? bytes.subarray(start, start + header.base) : null,
    review: reviewBytes ? bytes.subarray(start + header.base) : null,
  };
}

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A fingerprint of every voxel of a mask, to recognise the exact same mask again. Two
 * running hashes over 32-bit words, so a full-size mask takes a few tens of milliseconds.
 * It is not a secret and says nothing about the mask.
 */
export function maskHash(data: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const words = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.length >>> 2) : null;
  const n = words ? words.length : 0;
  for (let i = 0; i < n; i++) {
    const w = words![i];
    a = Math.imul(a ^ w, 0x01000193);
    b = (Math.imul(b, 31) + w + i) | 0;
  }
  for (let i = n * 4; i < data.length; i++) {
    a = Math.imul(a ^ data[i], 0x01000193);
    b = (Math.imul(b, 31) + data[i] + i) | 0;
  }
  a ^= data.length;
  return mix(a).toString(16).padStart(8, '0') + mix(b >>> 0).toString(16).padStart(8, '0');
}

/** True when the copy was written for this image and for exactly the mask on screen. */
export function roomCopyFits(header: RoomCopyHeader, imageKey: string, dims: readonly number[], mask: Uint8Array): boolean {
  return header.key === imageKey && header.dims.every((n, i) => n === dims[i]) && header.mine === maskHash(mask);
}

export function roomCopyExpired(header: RoomCopyHeader, now: number): boolean {
  return now - header.savedAt >= ROOM_COPY_KEEP_MS;
}

/** Whether this device may hold a room copy at all. */
export function shouldKeepRoomCopy(o: { autosave: boolean; guestView: boolean }): boolean {
  return o.autosave && !o.guestView;
}
