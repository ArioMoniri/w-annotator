/**
 * Room wire format. The relay is dumb: it forwards text (JSON) and binary
 * frames between the people in a room and tells them who is there.
 */

export interface PeerInfo {
  id: number;
  name: string;
}

export interface SegmentInfo {
  index: number;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface VolumeMeta {
  name: string;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
  dtype: string;
  /** Compressed size in bytes inside the snapshot payload. */
  bytes: number;
}

export type ServerMessage =
  | { t: 'welcome'; id: number; peers: PeerInfo[] }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number };

export type PeerMessage =
  | { t: 'cursor'; from: number; vp: string | null; w?: [number, number, number]; r?: number }
  | { t: 'segments'; from: number; list: SegmentInfo[] }
  | { t: 'need-snapshot'; from: number; to: number; imageToo: boolean; resync?: boolean }
  /** A fingerprint of the sender's mask, sent when it has been quiet for a moment. */
  | { t: 'digest'; from: number; h: number }
  | {
      t: 'snapshot';
      from: number;
      to: number;
      image: VolumeMeta | null;
      mask: VolumeMeta;
      maskName: string | null;
      resync?: boolean;
      segments: SegmentInfo[];
      total: number;
    }
  | { t: 'no-snapshot'; from: number; to: number };

export const enum FrameKind {
  Patch = 1,
  Snapshot = 2,
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function formatCode(code: string): string {
  const c = code.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

export function parseInvite(input: string, defaultServer: string): { server: string; code: string } | null {
  const text = input.trim();
  if (!text) return null;
  const link = /^(wss?|https?):\/\/([^/\s]+)\/r\/([a-z0-9-]+)/i.exec(text);
  if (link) {
    const code = link[3].replace(/-/g, '').toUpperCase();
    if (code.length < 4 || code.length > 16) return null;
    const scheme = link[1].toLowerCase();
    const ws = scheme === 'https' ? 'wss' : scheme === 'http' ? 'ws' : scheme;
    return { server: `${ws}://${link[2]}`, code };
  }
  if (text.includes('/') || text.includes(':')) return null;
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(code) || !defaultServer) return null;
  return { server: defaultServer.replace(/\/+$/, ''), code };
}

export function roomUrl(server: string, code: string, name: string): string {
  return `${server.replace(/\/+$/, '')}/r/${code}?name=${encodeURIComponent(name)}`;
}

export function inviteLink(server: string, code: string): string {
  return `${server.replace(/\/+$/, '')}/r/${code}`;
}

/** Binary frame: u32 target (0 = everyone), u8 kind, payload. */
export function frame(kind: FrameKind, payload: Uint8Array, to = 0): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, to, true);
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

/** The relay replaces the target with the sender before forwarding. */
export function parseFrame(bytes: Uint8Array): { from: number; kind: number; payload: Uint8Array } | null {
  if (bytes.length < 5) return null;
  const from = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return { from, kind: bytes[4], payload: bytes.subarray(5) };
}

export function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.subarray(o, Math.min(bytes.length, o + size)));
  return out;
}

export class Assembler {
  private readonly buf: Uint8Array;
  private filled = 0;

  constructor(total: number) {
    this.buf = new Uint8Array(total);
  }

  get progress(): number {
    return this.buf.length === 0 ? 1 : this.filled / this.buf.length;
  }

  /** Returns the whole payload once the last chunk has arrived. */
  push(part: Uint8Array): Uint8Array | null {
    if (this.filled + part.length > this.buf.length) throw new Error('Received more data than announced');
    this.buf.set(part, this.filled);
    this.filled += part.length;
    return this.filled === this.buf.length ? this.buf : null;
  }
}

const USER_COLORS = ['#7AB0FF', '#F29E6B', '#6FD3A3', '#E38BD0', '#E5C45A', '#8FD4E8', '#B9A2FF', '#F28B8B'];

export function userColor(id: number): string {
  return USER_COLORS[(Math.max(1, id) - 1) % USER_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const second = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + second).toUpperCase();
}

/** A fast fingerprint of a mask, used to notice when two people have drifted apart. */
export function maskDigest(data: Uint8Array): number {
  let h = 0x811c9dc5;
  // Zero runs dominate a mask; mixing in the position keeps them cheap but still counted.
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== 0) h = Math.imul(h ^ (v + i * 31), 0x01000193);
  }
  return h >>> 0;
}
