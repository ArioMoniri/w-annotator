/**
 * Rooms protocol v2, the app's side. The contract is `docs/design/ROOMS-PROTOCOL.md`;
 * section numbers below refer to it. The relay orders edits and enforces who may do
 * what from the cleartext frame header; everything else is inside encrypted payloads.
 */

export const PROTO = 2;
export const HEADER_BYTES = 24;

export type RoomKind = 'shared' | 'host-view';
export type Role = 'host' | 'editor' | 'viewer';

export interface SegmentInfo {
  index: number;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

/** Frame kinds (§5.2). */
export const enum FrameKind {
  Patch = 1,
  SegOp = 2,
  SyncSlab = 3,
  ImageSlab = 4,
  Presence = 5,
  SliceRequest = 6,
  Slice = 7,
  Key = 8,
  SyncRequest = 9,
}

export interface FrameHeader {
  version: number;
  kind: number;
  flags: number;
  from: number;
  to: number;
  /** The sender's own id for the frame on the way in; the room's sequence number on ordered frames coming back. */
  seq: number;
  epoch: number;
}

export interface Member {
  id: number;
  key: string;
  xkey: string | null;
  role: Role;
  online: boolean;
}

export interface Welcome {
  t: 'welcome';
  self: { id: number; role: Role };
  room: { id: string; type: RoomKind; state: 'active' | 'host-away'; proto: number; epoch: number; head: number; logFloor: number; session: string };
  roster: Member[];
  invite?: { wrappedKey: string };
}

export interface InviteInfo {
  id: string;
  role: Role;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked: boolean;
}

/* ───────────────────────── base64 (§1) ───────────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

/** URL-safe base64 without padding. */
export function b64encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (i + 1 < bytes.length) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (i + 2 < bytes.length) out += B64[c & 63];
  }
  return out;
}

/** Null for padding, the `+ /` alphabet or anything else that is not URL-safe base64. */
export function b64decode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let have = 0;
  let o = 0;
  for (const ch of text) {
    const v = B64_VALUE.get(ch);
    if (v === undefined) return null;
    bits = (bits << 6) | v;
    have += 6;
    if (have >= 8) {
      have -= 8;
      out[o++] = (bits >> have) & 0xff;
    }
  }
  return out;
}

/* ───────────────────────── frames (§5.1) ───────────────────────── */

export function encodeFrame(
  h: { kind: number; flags?: number; from?: number; to?: number; seq?: number | bigint; epoch: number },
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out[0] = PROTO;
  out[1] = h.kind;
  view.setUint16(2, h.flags ?? 0, true);
  view.setUint32(4, h.from ?? 0, true);
  view.setUint32(8, h.to ?? 0, true);
  view.setBigUint64(12, BigInt(h.seq ?? 0), true);
  view.setUint32(20, h.epoch, true);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(bytes: Uint8Array): { header: FrameHeader; payload: Uint8Array } | null {
  if (bytes.length < HEADER_BYTES || bytes[0] !== PROTO) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    header: {
      version: bytes[0],
      kind: bytes[1],
      flags: view.getUint16(2, true),
      from: view.getUint32(4, true),
      to: view.getUint32(8, true),
      seq: Number(view.getBigUint64(12, true)),
      epoch: view.getUint32(20, true),
    },
    payload: bytes.subarray(HEADER_BYTES),
  };
}

/* ───────────────────────── what goes inside a payload ───────────────────────── */

export type Meta = Record<string, unknown>;

/** A payload before encryption: a small JSON description, then raw bytes. */
export function pack(meta: Meta, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + json.length + body.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(body, 4 + json.length);
  return out;
}

export function unpack(bytes: Uint8Array): { meta: Meta; body: Uint8Array } | null {
  if (bytes.length < 4) return null;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + n > bytes.length) return null;
  try {
    const meta: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    return { meta: meta as Meta, body: bytes.subarray(4 + n) };
  } catch {
    return null;
  }
}

/* ───────────────────────── room ids and links (§2, §9.1) ───────────────────────── */

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID = /^[A-Za-z0-9]{8,32}$/;

/** Twelve characters, 60 bits: an id is an address, not the secret. */
export function makeRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

const trimSlashes = (server: string) => server.trim().replace(/\/+$/, '');

export function roomSocketUrl(server: string, room: string): string {
  return `${trimSlashes(server)}/v2/rooms/${room.toUpperCase()}`;
}

/** `server` is the room server as the app keeps it, `ws://` or `wss://`; the link is `http(s)://`. */
export function inviteLink(server: string, room: string, secret: Uint8Array): string {
  const web = trimSlashes(server).replace(/^ws(s?):\/\//i, 'http$1://');
  return `${web}/j/${room.toUpperCase()}#${b64encode(secret)}`;
}

export interface ParsedInvite {
  /** `ws://` or `wss://` address of the room server. */
  server: string;
  room: string;
  secret: Uint8Array;
}

export function parseInvite(input: string): ParsedInvite | null {
  const link = /^(https?|wss?):\/\/([^/\s#]+)\/j\/([A-Za-z0-9]+)#([A-Za-z0-9_-]+)$/i.exec(input.trim());
  if (!link || !ROOM_ID.test(link[3])) return null;
  const secret = b64decode(link[4]);
  if (!secret || secret.length !== 16) return null;
  const scheme = link[1].toLowerCase();
  const secure = scheme === 'https' || scheme === 'wss';
  return { server: `${secure ? 'wss' : 'ws'}://${link[2]}`, room: link[3].toUpperCase(), secret };
}

/** The text a member signs to create, sign in or redeem (§3.2). */
export function signingInput(op: 'create' | 'auth' | 'redeem', room: string, nonce: string): string {
  return `w-rooms/2 ${op} ${room.toUpperCase()} ${nonce}`;
}

/* ───────────────────────── words for close codes (§11, ROOMS.md C10) ───────────────────────── */

export const NOTHING_SAVED = 'Nothing was saved on this device.';
const COPY_STAYS = 'Your copy stays on this computer.';

/** What to tell someone whose connection to a room ended for good. */
export function closeMessage(code: number, reason: string, room: { host: string | null; kind: RoomKind | null }): string {
  const host = room.host ?? 'The host';
  const after = room.kind === 'host-view' ? ` ${NOTHING_SAVED}` : room.kind === 'shared' ? ` ${COPY_STAYS}` : '';
  switch (code) {
    case 4001:
      return reason === 'relay full' ? 'The room server is full. Try again later.' : 'This room is full (16).';
    case 4003:
      return 'This room was opened somewhere else with your invite.';
    case 4401:
      return 'You are not a member of this room.';
    case 4403:
      return `${host} removed you from this room.${after}`;
    case 4404:
      return 'No room at that link. Check the link and try again.';
    case 4408: {
      const what =
        reason === 'invite expired'
          ? 'has expired'
          : reason === 'invite already used'
            ? 'was already used'
            : reason === 'invite revoked'
              ? 'was switched off'
              : 'is not valid';
      return `This invite link ${what}. Ask the host for a new one.`;
    }
    case 4409:
      return "Couldn't start the room. Try again.";
    case 4410:
      if (room.kind === 'host-view') return `The host ended the session. ${NOTHING_SAVED}`;
      if (room.kind === 'shared') return `${host} deleted this room. ${COPY_STAYS}`;
      return 'This room has ended.';
    case 4426:
      return reason || 'Update W Annotator to join this room';
    case 4429:
      return 'Too many attempts. Try again in a minute.';
    default:
      return "Can't reach the room server. Check your network and try again in a minute.";
  }
}

/* ───────────────────────── people ───────────────────────── */

const USER_COLORS = ['#7AB0FF', '#F29E6B', '#6FD3A3', '#E38BD0', '#E5C45A', '#8FD4E8', '#B9A2FF', '#F28B8B'];

export function userColor(id: number): string {
  return USER_COLORS[id % USER_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const second = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + second).toUpperCase();
}

/** A name as it arrives from someone else: trimmed, at most 24 characters, or null. */
export function cleanPeerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, 24).trim() || null;
}

/**
 * The name shown for each member. Two people with the same name get a number,
 * in member-id order, so everyone sees the same "Ana 2".
 */
export function displayNames(ids: number[], names: Map<number, string>): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const name = names.get(id);
    if (!name) {
      out.set(id, 'Someone');
      continue;
    }
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    out.set(id, n === 1 ? name : `${name} ${n}`);
  }
  return out;
}
