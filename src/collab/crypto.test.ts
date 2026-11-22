import { describe, expect, it } from 'vitest';
import { open, seal } from './crypto';

const frameAad = (room: string, epoch: number, kind: number) => `w-rooms/3 all ${room} ${epoch} ${kind} 7`;

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
