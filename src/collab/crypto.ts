/**
 * The cipher under everything a room sends (`ROOMS.md` C7): AES-256-GCM with a fresh nonce.
 * Which key a frame is sealed with, and what is bound to it, is decided in `keys.ts`.
 */

import { gcm } from '@noble/ciphers/aes.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

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
