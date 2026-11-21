import { describe, expect, it } from 'vitest';
import { frameAad, makeRoomKey, open, seal, unwrapRoomKey, wrapRoomKey } from './crypto';

const text = (s: string) => new TextEncoder().encode(s);

describe('payload encryption', () => {
  const key = new Uint8Array(32).fill(7);
  it('round-trips and hides the plaintext', () => {
    const sealed = seal(key, frameAad('ROOMROOM', 1, 1), text('Mina paints segment Liver'));
    expect(new TextDecoder().decode(sealed)).not.toContain('Mina');
    expect(sealed.length).toBe(12 + 25 + 16);
    expect(new TextDecoder().decode(open(key, frameAad('ROOMROOM', 1, 1), sealed)!)).toBe('Mina paints segment Liver');
  });
  it('uses a new nonce every time', () => {
    const a = seal(key, 'x', text('same'));
    const b = seal(key, 'x', text('same'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
  it('rejects a tampered payload, another key, and a re-labelled frame', () => {
    const aad = frameAad('ROOMROOM', 1, 1);
    const sealed = seal(key, aad, text('hello'));
    const bent = sealed.slice();
    bent[14] ^= 1;
    expect(open(key, aad, bent)).toBeNull();
    expect(open(new Uint8Array(32).fill(8), aad, sealed)).toBeNull();
    expect(open(key, frameAad('ROOMROOM', 1, 2), sealed)).toBeNull();
    expect(open(key, frameAad('OTHERROOM', 1, 1), sealed)).toBeNull();
    expect(open(key, aad, sealed.subarray(0, 10))).toBeNull();
  });
});

describe('room key in an invite', () => {
  it('is wrapped with the key from the link and comes back whole', () => {
    const roomKey = makeRoomKey();
    expect(roomKey.length).toBe(32);
    const wrapKey = new Uint8Array(32).fill(3);
    const wrapped = wrapRoomKey(wrapKey, roomKey);
    expect(wrapped.length).toBeLessThanOrEqual(512);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(unwrapRoomKey(wrapKey, wrapped)!)).toEqual(Array.from(roomKey));
    expect(unwrapRoomKey(new Uint8Array(32).fill(4), wrapped)).toBeNull();
    expect(unwrapRoomKey(wrapKey, 'not base64 !')).toBeNull();
  });
});
