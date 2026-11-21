import { describe, expect, it } from 'vitest';
import { afterClose, handshakeMessage, retryDelay } from './client';
import { inviteKeys, inviteProof, publicKey } from './identity';
import { b64encode } from './protocol';

const ROOM = 'K7Q2M9XA4TDP';
const NONCE = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
const seed = new Uint8Array(32).fill(9);
const key = b64encode(publicKey(seed));

describe('handshakeMessage', () => {
  it('creates a room of the chosen kind', () => {
    const msg = handshakeMessage({ t: 'create', type: 'host-view' }, seed, ROOM, NONCE);
    expect(msg).toMatchObject({ t: 'create', proto: 2, type: 'host-view', key });
    expect(typeof msg.sig).toBe('string');
    expect(msg).not.toHaveProperty('members');
  });

  it('names the members again when the host re-opens a room the server lost', () => {
    const members = [{ key: 'abc', role: 'editor' as const }];
    expect(handshakeMessage({ t: 'create', type: 'shared', members }, seed, ROOM, NONCE).members).toEqual(members);
  });

  it('signs in with the documented signature', () => {
    expect(handshakeMessage({ t: 'auth' }, seed, ROOM, NONCE)).toEqual({
      t: 'auth',
      proto: 2,
      key,
      sig: 'RA6G6hqKeo4SjyGYi2a-HgiEhanc_D8SKC80umU9m0jJD2E46pzO7s8g-dLWlRrVU65LYnMXsHFcHOIqR-TbDQ',
    });
  });

  it('redeems an invite with its id and a proof, never the secret', () => {
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
    const msg = handshakeMessage({ t: 'redeem', secret }, seed, ROOM, NONCE);
    const keys = inviteKeys(secret);
    expect(msg).toMatchObject({ t: 'redeem', proto: 2, invite: keys.id, key, proof: inviteProof(keys.authKey, ROOM, NONCE, key) });
    expect(JSON.stringify(msg)).not.toContain(b64encode(secret));
    expect(JSON.stringify(msg)).not.toContain(b64encode(keys.wrapKey));
  });

  it('sends no name and no address', () => {
    for (const mode of [{ t: 'create' as const, type: 'shared' as const }, { t: 'auth' as const }]) {
      expect(Object.keys(handshakeMessage(mode, seed, ROOM, NONCE)).sort()).toEqual(
        mode.t === 'create' ? ['key', 'proto', 'sig', 't', 'type'] : ['key', 'proto', 'sig', 't'],
      );
    }
  });
});

describe('afterClose', () => {
  it('never retries a first attempt', () => {
    for (const code of [1006, 4404, 4408, 4429]) expect(afterClose(code, false, false)).toBe('ended');
  });
  it('keeps trying after a lost connection or a slow one', () => {
    for (const code of [1000, 1005, 1006, 4002, 4429]) expect(afterClose(code, true, false)).toBe('retry');
  });
  it('stops for good when the room or the membership is gone', () => {
    for (const code of [4001, 4003, 4401, 4403, 4408, 4410, 4426]) expect(afterClose(code, true, true)).toBe('ended');
  });
  it('re-opens an unknown room as host, and waits as anyone else', () => {
    expect(afterClose(4404, true, true)).toBe('recreate');
    expect(afterClose(4404, true, false)).toBe('retry');
  });
});

describe('retryDelay', () => {
  it('starts near a second, grows, and stops at 30 seconds, with jitter', () => {
    expect(retryDelay(0, () => 0)).toBe(500);
    expect(retryDelay(0, () => 1)).toBe(1000);
    expect(retryDelay(3, () => 1)).toBe(8000);
    expect(retryDelay(20, () => 1)).toBe(30_000);
    expect(retryDelay(20, () => 0)).toBe(15_000);
  });
});
