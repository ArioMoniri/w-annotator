/**
 * Who a member is, and what an invite link proves (`ROOMS-PROTOCOL.md` §3.2, §4, §9.1).
 *
 * A member is an Ed25519 key pair made for one room. Pure JavaScript (@noble) rather than
 * WebCrypto: Ed25519 is missing from the WebKit of older macOS and Linux systems, and
 * `crypto.subtle` does not exist at all on a page served over plain http.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64encode, signingInput } from './protocol';

const utf8 = (text: string) => new TextEncoder().encode(text);

export function publicKey(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

/** The first four bytes of SHA-256(public key), little-endian. Stable across reconnects. */
export function memberId(key: Uint8Array): number {
  const h = sha256(key);
  return (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
}

/** A new private key for one room. Id 0 means "everyone" on the wire, so such a key is never handed out. */
export function makeSeed(): Uint8Array {
  for (;;) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    if (memberId(publicKey(seed)) !== 0) return seed;
  }
}

export function handshakeSignature(seed: Uint8Array, op: 'create' | 'auth' | 'redeem', room: string, nonce: string): string {
  return b64encode(ed25519.sign(utf8(signingInput(op, room, nonce)), seed));
}

export interface InviteKeys {
  /** What the relay knows the invite by. */
  id: string;
  /** Given to the relay when the invite is registered; keys the redeemer's proof. */
  authKey: Uint8Array;
  /** Never leaves the two apps: seals what the invite tells the newcomer about the host. */
  wrapKey: Uint8Array;
  /** Never leaves the two apps: keys the newcomer's proof to the host of which keys are theirs. */
  bindKey: Uint8Array;
}

const derive = (secret: Uint8Array, info: string, length: number) => hkdf(sha256, secret, new Uint8Array(0), utf8(info), length);

/** Everything both sides derive from the secret in the link. */
export function inviteKeys(secret: Uint8Array): InviteKeys {
  return {
    id: b64encode(derive(secret, 'w-rooms/2 invite id', 16)),
    authKey: derive(secret, 'w-rooms/2 invite auth', 32),
    wrapKey: derive(secret, 'w-rooms/2 invite wrap', 32),
    bindKey: derive(secret, 'w-rooms/3 invite bind', 32),
  };
}

/** Shows the relay that the redeemer holds the link, for this connection and this new key only. */
export function inviteProof(authKey: Uint8Array, room: string, nonce: string, key: string): string {
  return b64encode(hmac(sha256, authKey, utf8(`w-rooms/2 proof ${room.toUpperCase()} ${nonce} ${key}`)));
}

export function makeInviteSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
