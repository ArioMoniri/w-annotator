import { describe, expect, it } from 'vitest';
import { Pace, afterClose, frameIsBound, handshakeMessage, paceLimits, parseRoster, parseWelcome, retryDelay, welcomeFits } from './client';
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

describe('who a frame is from and for', () => {
  const header = { version: 2, kind: 1, flags: 0, from: 7, to: 0, seq: 1, epoch: 1 };
  it('accepts a frame that names its sender as the room server did', () => {
    expect(frameIsBound({ f: 7 }, header, 9)).toBe(true);
    expect(frameIsBound({ f: 7, d: 9 }, { ...header, to: 9 }, 9)).toBe(true);
  });
  it('refuses a frame the room server passed off as someone else', () => {
    // Made by member 8, stamped by the room server as from member 7 (the host, say).
    expect(frameIsBound({ f: 8 }, header, 9)).toBe(false);
    expect(frameIsBound({ f: '7' }, header, 9)).toBe(false);
  });
  it('refuses a frame meant for another member', () => {
    expect(frameIsBound({ f: 7, d: 5 }, { ...header, to: 9 }, 9)).toBe(false);
  });
  it('still takes frames from an app that does not say', () => {
    expect(frameIsBound({}, header, 9)).toBe(true);
  });
});

describe('Pace', () => {
  it('keeps a long run of frames under half of what the room server allows', () => {
    const limits = { messagesPerSec: 200, bytesPerSec: 20 << 20 };
    const pace = new Pace(limits, 1, 0);
    // 80 frames of 1 MiB, sent as early as allowed.
    const sent: { at: number; bytes: number }[] = [];
    let now = 0;
    for (let i = 0; i < 80; i++) {
      now += pace.wait(1 << 20, now);
      pace.spend(1 << 20, now);
      sent.push({ at: now, bytes: 1 << 20 });
    }
    // In any one second, bytes stay within the server's 20 MiB, which is also its burst.
    for (const first of sent) {
      const inWindow = sent.filter((s) => s.at >= first.at && s.at < first.at + 1000);
      expect(inWindow.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(limits.bytesPerSec);
    }
    // And it is not needlessly slow: 80 MiB at 10 MiB a second.
    expect(now).toBeGreaterThan(6000);
    expect(now).toBeLessThan(9000);
  });

  it('keeps many small frames under the message limit', () => {
    const pace = new Pace({ messagesPerSec: 200, bytesPerSec: 20 << 20 }, 1, 0);
    let now = 0;
    const at: number[] = [];
    for (let i = 0; i < 1000; i++) {
      now += pace.wait(100, now);
      pace.spend(100, now);
      at.push(now);
    }
    for (const first of at) expect(at.filter((t) => t >= first && t < first + 1000).length).toBeLessThanOrEqual(200);
  });

  it('lets a single frame go at once, whatever its size', () => {
    const pace = new Pace({ messagesPerSec: 200, bytesPerSec: 20 << 20 }, 1, 0);
    expect(pace.wait(2 << 20, 0)).toBe(0);
  });

  it('gives the host of a view-through-host room four times the room, as the server does', () => {
    const one = new Pace({ messagesPerSec: 200, bytesPerSec: 20 << 20 }, 1, 0);
    const four = new Pace({ messagesPerSec: 200, bytesPerSec: 20 << 20 }, 4, 0);
    const drain = (p: Pace) => {
      let now = 0;
      for (let i = 0; i < 400; i++) {
        now += p.wait(1000, now);
        p.spend(1000, now);
      }
      return now;
    };
    expect(drain(four)).toBeLessThan(drain(one) / 3);
  });

  it('falls back to the documented limits when the server names none', () => {
    expect(paceLimits(undefined)).toEqual({ messagesPerSec: 200, bytesPerSec: 20 << 20 });
    expect(paceLimits({ messagesPerSec: 50, bytesPerSec: 1 << 20 })).toEqual({ messagesPerSec: 50, bytesPerSec: 1 << 20 });
    expect(paceLimits({ messagesPerSec: -1, bytesPerSec: 'x' })).toEqual({ messagesPerSec: 200, bytesPerSec: 20 << 20 });
  });
});

describe('parseWelcome', () => {
  const good = {
    t: 'welcome',
    self: { id: 7, role: 'editor' },
    room: { id: ROOM, type: 'shared', state: 'active', proto: 2, epoch: 1, head: 3, logFloor: 0, session: 'abc' },
    roster: [
      { id: 7, key: 'k', xkey: null, role: 'editor', online: true },
      { id: 9, key: 'h', xkey: null, role: 'host', online: true },
    ],
  };
  it('reads a welcome', () => {
    expect(parseWelcome(good)?.room.head).toBe(3);
    expect(parseWelcome(good)?.roster.length).toBe(2);
  });
  it('refuses one with parts missing or of the wrong kind, instead of failing later', () => {
    expect(parseWelcome({ ...good, self: null })).toBeNull();
    expect(parseWelcome({ ...good, self: { id: 7, role: 'owner' } })).toBeNull();
    expect(parseWelcome({ ...good, room: { ...good.room, type: 'open' } })).toBeNull();
    expect(parseWelcome({ ...good, room: { ...good.room, head: -1 } })).toBeNull();
    expect(parseWelcome({ ...good, room: { ...good.room, session: 5 } })).toBeNull();
    expect(parseWelcome({ ...good, roster: 'x' })).toBeNull();
    expect(parseWelcome({ ...good, invite: { wrappedKey: 5 } })).toBeNull();
  });
  it('drops roster entries that are not members, and more than a room can hold', () => {
    expect(parseRoster([null, 5, { id: 'x' }, { id: 9, key: 'h', role: 'host', online: 1 }, good.roster[0]])).toEqual([good.roster[0]]);
    const many = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, key: 'k', xkey: null, role: 'editor', online: false }));
    expect(parseRoster(many)!.length).toBeLessThanOrEqual(64);
    expect(parseRoster('x')).toBeNull();
  });
  it('knows a room that is not what this device joined', () => {
    const w = parseWelcome(good)!;
    expect(welcomeFits(w, { kind: null, host: null, self: 7 })).toBe(true);
    expect(welcomeFits(w, { kind: 'shared', host: false, self: 7 })).toBe(true);
    // The room server says this is another kind of room than the one the host made.
    expect(welcomeFits(w, { kind: 'host-view', host: false, self: 7 })).toBe(false);
    // It says a guest is the host, or the host is a guest.
    expect(welcomeFits(w, { kind: 'shared', host: true, self: 7 })).toBe(false);
    // It gives this device another member's id.
    expect(welcomeFits(w, { kind: null, host: null, self: 8 })).toBe(false);
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
