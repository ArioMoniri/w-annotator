/**
 * Encryption of everything a room sends (`ROOMS.md` C7). The relay sees frame headers;
 * names, voxels, segment names and pictures travel as AES-256-GCM ciphertext under the
 * room key, which only reaches people through the part of an invite link after `#`.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { b64decode, b64encode } from './protocol';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function makeRoomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Room, key epoch and frame kind are bound to the ciphertext, so the relay cannot re-label a frame. */
export function frameAad(room: string, epoch: number, kind: number): string {
  return `w-rooms/2 ${room.toUpperCase()} ${epoch} ${kind}`;
}

/** A fresh random nonce, then ciphertext and tag. */
export function seal(key: Uint8Array, aad: string, plain: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = gcm(key, nonce, new TextEncoder().encode(aad)).encrypt(plain);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce);
  out.set(sealed, NONCE_BYTES);
  return out;
}

/** Null when the payload was changed, made with another key, or belongs to another room or kind. */
export function open(key: Uint8Array, aad: string, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) return null;
  try {
    return gcm(key, sealed.subarray(0, NONCE_BYTES), new TextEncoder().encode(aad)).decrypt(sealed.subarray(NONCE_BYTES));
  } catch {
    return null;
  }
}

const WRAP_AAD = 'w-rooms/2 room key';

/** The room key as the relay stores it for an invite: sealed with a key only the link holder can derive. */
export function wrapRoomKey(wrapKey: Uint8Array, roomKey: Uint8Array): string {
  return b64encode(seal(wrapKey, WRAP_AAD, roomKey));
}

export function unwrapRoomKey(wrapKey: Uint8Array, wrapped: string): Uint8Array | null {
  const bytes = b64decode(wrapped);
  const key = bytes && open(wrapKey, WRAP_AAD, bytes);
  return key && key.length === 32 ? key : null;
}
