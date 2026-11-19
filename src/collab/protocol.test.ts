import { describe, expect, it } from 'vitest';
import { Assembler, FrameKind, chunk, maskDigest, formatCode, frame, initials, makeCode, parseFrame, parseInvite, roomUrl } from './protocol';

describe('room codes', () => {
  it('makes 6 character codes without look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(makeCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
  it('formats with a hyphen', () => {
    expect(formatCode('kdr482')).toBe('KDR-482');
  });
});

describe('parseInvite', () => {
  const fallback = 'ws://relay.example:8787';
  it('reads a bare code and uses the default server', () => {
    expect(parseInvite(' kdr-482 ', fallback)).toEqual({ server: fallback, code: 'KDR482' });
  });
  it('reads a full invite link', () => {
    expect(parseInvite('ws://192.168.1.20:8787/r/KDR482', fallback)).toEqual({
      server: 'ws://192.168.1.20:8787',
      code: 'KDR482',
    });
  });
  it('maps http links to websocket ones', () => {
    expect(parseInvite('https://rooms.example.org/r/abc234', fallback)).toEqual({
      server: 'wss://rooms.example.org',
      code: 'ABC234',
    });
  });
  it('rejects anything else', () => {
    expect(parseInvite('', fallback)).toBeNull();
    expect(parseInvite('abc', fallback)).toBeNull();
    expect(parseInvite('ws://host/nothing', fallback)).toBeNull();
  });
  it('needs a server for a bare code', () => {
    expect(parseInvite('KDR482', '')).toBeNull();
  });
});

describe('roomUrl', () => {
  it('escapes the name', () => {
    expect(roomUrl('ws://h:1/', 'KDR482', 'Ana & Bo')).toBe('ws://h:1/r/KDR482?name=Ana%20%26%20Bo');
  });
});

describe('frames', () => {
  it('writes the target, kind and payload', () => {
    const f = frame(FrameKind.Patch, Uint8Array.of(9, 8, 7), 5);
    expect(Array.from(f)).toEqual([5, 0, 0, 0, FrameKind.Patch, 9, 8, 7]);
  });
  it('parses what the relay sends back, with the sender in the header', () => {
    const f = frame(FrameKind.Snapshot, Uint8Array.of(1, 2));
    new DataView(f.buffer).setUint32(0, 42, true);
    const p = parseFrame(f)!;
    expect(p.from).toBe(42);
    expect(p.kind).toBe(FrameKind.Snapshot);
    expect(Array.from(p.payload)).toEqual([1, 2]);
  });
  it('ignores frames that are too short', () => {
    expect(parseFrame(Uint8Array.of(1, 2, 3))).toBeNull();
  });
});

describe('chunking', () => {
  it('splits and reassembles', () => {
    const data = Uint8Array.from({ length: 10 }, (_, i) => i);
    const parts = chunk(data, 4);
    expect(parts.map((p) => p.length)).toEqual([4, 4, 2]);
    const a = new Assembler(10);
    let done: Uint8Array | null = null;
    for (const p of parts) done = a.push(p);
    expect(done).toEqual(data);
    expect(a.progress).toBe(1);
  });
  it('reports progress and refuses overflow', () => {
    const a = new Assembler(4);
    expect(a.push(Uint8Array.of(1, 2))).toBeNull();
    expect(a.progress).toBe(0.5);
    expect(() => a.push(Uint8Array.of(1, 2, 3))).toThrow();
  });
  it('handles an empty payload', () => {
    expect(chunk(new Uint8Array(0), 4)).toEqual([]);
  });
});

describe('initials', () => {
  it('takes up to two letters', () => {
    expect(initials('Mina Okafor')).toBe('MO');
    expect(initials('ario')).toBe('A');
    expect(initials('  ')).toBe('?');
  });
});

describe('maskDigest', () => {
  it('is equal for equal masks and differs when a voxel moves or changes', () => {
    const a = new Uint8Array(64);
    a[10] = 1;
    a[40] = 2;
    const b = a.slice();
    expect(maskDigest(a)).toBe(maskDigest(b));
    b[40] = 0;
    b[41] = 2;
    expect(maskDigest(a)).not.toBe(maskDigest(b));
    const c = a.slice();
    c[10] = 3;
    expect(maskDigest(a)).not.toBe(maskDigest(c));
  });
});
