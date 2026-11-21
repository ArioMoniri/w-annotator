import { describe, expect, it } from 'vitest';
import { b64decode, b64encode } from './protocol';
import { handshakeSignature, inviteKeys, inviteProof, makeSeed, memberId, publicKey } from './identity';

// The vectors of docs/design/ROOMS-PROTOCOL.md, section 16.
const ROOM = 'K7Q2M9XA4TDP';
const NONCE = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';

describe('invite derivations', () => {
  const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
  it('match the documented vectors', () => {
    const keys = inviteKeys(secret);
    expect(keys.id).toBe('o7XlWLz18---2w9iH1Eibg');
    expect(b64encode(keys.authKey)).toBe('Ev6xTmVvi_PF1s4sBZ0574I-WYcQptT7s2zTWr1B0wk');
    expect(b64encode(keys.wrapKey)).toBe('KzS7nbWnBhOGTNPJJh0PNDD9km4D4s4nyLiwjLD5nLk');
  });
  it('proves knowledge of the link to the relay', () => {
    const redeemer = b64encode(new Uint8Array(32).fill(1));
    expect(inviteProof(inviteKeys(secret).authKey, ROOM, NONCE, redeemer)).toBe('Ee54exLwUMB302Rnxij9CVCOLifBmAQwuL4ObJ1v_RE');
  });
});

describe('member keys', () => {
  const seed = new Uint8Array(32).fill(9);
  it('derive the documented public key and member id', () => {
    expect(b64encode(publicKey(seed))).toBe('_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg');
    expect(memberId(publicKey(seed))).toBe(630768347);
  });
  it('sign the handshake text', () => {
    expect(handshakeSignature(seed, 'auth', ROOM, NONCE)).toBe(
      'RA6G6hqKeo4SjyGYi2a-HgiEhanc_D8SKC80umU9m0jJD2E46pzO7s8g-dLWlRrVU65LYnMXsHFcHOIqR-TbDQ',
    );
    expect(b64decode(handshakeSignature(seed, 'create', ROOM, NONCE))!.length).toBe(64);
  });
  it('makes a fresh key each time, never with id 0', () => {
    const a = makeSeed();
    const b = makeSeed();
    expect(a.length).toBe(32);
    expect(b64encode(a)).not.toBe(b64encode(b));
    expect(memberId(publicKey(a))).not.toBe(0);
  });
});
