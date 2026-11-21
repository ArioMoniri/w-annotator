import { describe, expect, it } from 'vitest';
import {
  FrameKind,
  HEADER_BYTES,
  b64decode,
  b64encode,
  closeMessage,
  decodeFrame,
  displayNames,
  encodeFrame,
  initials,
  inviteLink,
  makeRoomId,
  pack,
  parseInvite,
  roomSocketUrl,
  signingInput,
  unpack,
} from './protocol';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

describe('base64', () => {
  it('is url-safe and unpadded', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(b64encode(bytes)).toBe('AAECAwQFBgcICQoLDA0ODw');
    expect(Array.from(b64decode('AAECAwQFBgcICQoLDA0ODw')!)).toEqual(Array.from(bytes));
    expect(b64encode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
  it('rejects padding and the other alphabet', () => {
    expect(b64decode('AAECAw==')).toBeNull();
    expect(b64decode('+/8')).toBeNull();
    expect(b64decode('a b')).toBeNull();
  });
});

describe('frames', () => {
  it('writes the documented header', () => {
    const out = encodeFrame({ kind: 1, flags: 0x0102, from: 0x0a0b0c0d, to: 7, seq: 0x1122334455667788n, epoch: 1 }, new Uint8Array(0));
    expect(hex(out)).toBe('02 01 02 01 0d 0c 0b 0a 07 00 00 00 88 77 66 55 44 33 22 11 01 00 00 00');
  });
  it('round-trips a header and payload', () => {
    const payload = new Uint8Array([0x68, 0x69]);
    const out = encodeFrame({ kind: FrameKind.Patch, seq: 7, epoch: 1 }, payload);
    expect(hex(out)).toBe('02 01 00 00 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00 01 00 00 00 68 69');
    const back = decodeFrame(out)!;
    expect(back.header).toEqual({ version: 2, kind: 1, flags: 0, from: 0, to: 0, seq: 7, epoch: 1 });
    expect(Array.from(back.payload)).toEqual([0x68, 0x69]);
  });
  it('keeps sequence numbers above 32 bits', () => {
    const out = encodeFrame({ kind: 1, seq: 2 ** 40 + 5, epoch: 1 }, new Uint8Array(0));
    expect(decodeFrame(out)!.header.seq).toBe(2 ** 40 + 5);
  });
  it('refuses short frames and other versions', () => {
    expect(decodeFrame(new Uint8Array(HEADER_BYTES - 1))).toBeNull();
    const out = encodeFrame({ kind: 1, seq: 1, epoch: 1 }, new Uint8Array(0));
    out[0] = 3;
    expect(decodeFrame(out)).toBeNull();
  });
});

describe('payload envelope', () => {
  it('carries a small description and bytes', () => {
    const packed = pack({ t: 'slab', z: 16 }, new Uint8Array([1, 2, 3]));
    const back = unpack(packed)!;
    expect(back.meta).toEqual({ t: 'slab', z: 16 });
    expect(Array.from(back.body)).toEqual([1, 2, 3]);
  });
  it('returns null for anything malformed', () => {
    expect(unpack(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull();
    expect(unpack(new Uint8Array(2))).toBeNull();
    expect(unpack(pack([1, 2] as unknown as Record<string, unknown>))).toBeNull();
  });
});

describe('room ids and links', () => {
  it('makes 12 character ids of letters and digits', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = makeRoomId();
      expect(id).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
  it('builds the socket address', () => {
    expect(roomSocketUrl('ws://192.168.1.20:8787/', 'k7q2m9xa4tdp')).toBe('ws://192.168.1.20:8787/v2/rooms/K7Q2M9XA4TDP');
  });
  it('builds an invite link with the secret after the hash', () => {
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(inviteLink('wss://rooms.example.org', 'K7Q2M9XA4TDP', secret)).toBe('https://rooms.example.org/j/K7Q2M9XA4TDP#AAECAwQFBgcICQoLDA0ODw');
    expect(inviteLink('ws://192.168.1.20:8787', 'K7Q2M9XA4TDP', secret)).toBe('http://192.168.1.20:8787/j/K7Q2M9XA4TDP#AAECAwQFBgcICQoLDA0ODw');
  });
  it('reads an invite link', () => {
    const got = parseInvite('  https://rooms.example.org/j/k7q2m9xa4tdp#AAECAwQFBgcICQoLDA0ODw ')!;
    expect(got.server).toBe('wss://rooms.example.org');
    expect(got.room).toBe('K7Q2M9XA4TDP');
    expect(Array.from(got.secret)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(parseInvite('http://192.168.1.20:8787/j/K7Q2M9XA4TDP#AAECAwQFBgcICQoLDA0ODw')!.server).toBe('ws://192.168.1.20:8787');
  });
  it('rejects links without a secret, old links and bare codes', () => {
    expect(parseInvite('https://rooms.example.org/j/K7Q2M9XA4TDP')).toBeNull();
    expect(parseInvite('https://rooms.example.org/j/K7Q2M9XA4TDP#short')).toBeNull();
    expect(parseInvite('ws://192.168.1.20:8787/r/KDR482')).toBeNull();
    expect(parseInvite('KDR-482')).toBeNull();
    expect(parseInvite('https://rooms.example.org/j/abc#AAECAwQFBgcICQoLDA0ODw')).toBeNull();
    expect(parseInvite('')).toBeNull();
  });
  it('signs the documented text', () => {
    expect(signingInput('auth', 'k7q2m9xa4tdp', 'NONCE')).toBe('w-rooms/2 auth K7Q2M9XA4TDP NONCE');
  });
});

describe('closeMessage', () => {
  const shared = { host: 'Mina', kind: 'shared' as const };
  const view = { host: 'Mina', kind: 'host-view' as const };
  it('explains a spent or expired link', () => {
    expect(closeMessage(4408, 'invite expired', shared)).toBe('This invite link has expired. Ask the host for a new one.');
    expect(closeMessage(4408, 'invite already used', shared)).toBe('This invite link was already used. Ask the host for a new one.');
    expect(closeMessage(4408, 'invite revoked', shared)).toBe('This invite link was switched off. Ask the host for a new one.');
    expect(closeMessage(4408, 'invite not valid', shared)).toBe('This invite link is not valid. Ask the host for a new one.');
  });
  it('says who removed you and what stays', () => {
    expect(closeMessage(4403, 'removed by host', shared)).toBe('Mina removed you from this room. Your copy stays on this computer.');
    expect(closeMessage(4403, 'removed by host', view)).toBe('Mina removed you from this room. Nothing was saved on this device.');
    expect(closeMessage(4403, 'removed by host', { host: null, kind: 'shared' })).toBe('The host removed you from this room. Your copy stays on this computer.');
  });
  it('says when the room is gone', () => {
    expect(closeMessage(4410, 'room deleted', shared)).toBe('Mina deleted this room. Your copy stays on this computer.');
    expect(closeMessage(4410, 'room closed', view)).toBe('The host ended the session. Nothing was saved on this device.');
    expect(closeMessage(4410, 'host lost', view)).toBe('The host ended the session. Nothing was saved on this device.');
    expect(closeMessage(4410, 'room closed', { host: null, kind: null })).toBe('This room has ended.');
  });
  it('covers the rest in plain words', () => {
    expect(closeMessage(4404, 'no such room', shared)).toBe('No room at that link. Check the link and try again.');
    expect(closeMessage(4001, 'room full', shared)).toBe('This room is full (16).');
    expect(closeMessage(4001, 'relay full', shared)).toBe('The room server is full. Try again later.');
    expect(closeMessage(4429, 'too many attempts', shared)).toBe('Too many attempts. Try again in a minute.');
    expect(closeMessage(4426, 'Update W Annotator to join this room', shared)).toBe('Update W Annotator to join this room');
    expect(closeMessage(4401, 'not a member', shared)).toBe('You are not a member of this room.');
    expect(closeMessage(4003, 'signed in elsewhere', shared)).toBe('This room was opened somewhere else with your invite.');
    expect(closeMessage(1006, '', shared)).toBe("Can't reach the room server. Check your network and try again in a minute.");
  });
  it('never uses an exclamation mark', () => {
    for (const code of [4001, 4002, 4003, 4400, 4401, 4403, 4404, 4408, 4409, 4410, 4426, 4429, 1006]) {
      expect(closeMessage(code, '', shared)).not.toContain('!');
    }
  });
});

describe('names', () => {
  it('builds initials', () => {
    expect(initials('Mina')).toBe('M');
    expect(initials('ana maria lopez')).toBe('AL');
    expect(initials('  ')).toBe('?');
  });
  it('numbers people who share a name, in member order', () => {
    const names = displayNames([30, 10, 20, 40], new Map([[10, 'Ana'], [20, 'Ana'], [30, 'ana'], [40, 'Ben']]));
    expect(names.get(10)).toBe('Ana');
    expect(names.get(20)).toBe('Ana 2');
    expect(names.get(30)).toBe('ana 3');
    expect(names.get(40)).toBe('Ben');
  });
  it('gives a plain name to someone who has not said theirs yet', () => {
    expect(displayNames([5], new Map()).get(5)).toBe('Someone');
  });
});
