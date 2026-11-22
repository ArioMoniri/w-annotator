/**
 * The keys of a room (`ROOMS-PROTOCOL.md` §19).
 *
 * Nobody shares one key for everything any more. A frame for one member is sealed with a
 * key only the two of them can make (X25519). A frame for everyone is sealed with the room
 * key of the current epoch and signed by its sender, so that holding the room key is not
 * enough to pass as someone else. When the host removes a person it makes a new room key
 * and hands it to the people who stay, each under their own pair key.
 *
 * Who is in the room is the host's word, not the room server's: the host signs the list of
 * members and their keys, and a newcomer learns the host's keys from the invite link.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { open, seal } from './crypto';
import { inviteKeys, memberId, publicKey } from './identity';
import { FrameKind, b64decode, b64encode, type FrameHeader, type Meta, type RoomKind } from './protocol';

const utf8 = (text: string) => new TextEncoder().encode(text);
const EMPTY = new Uint8Array(0);
const SIG_BYTES = 64;
/** Nonce and tag: the least a sealed payload can be. */
const SEALED_MIN = 28;
/** People who left are remembered this far back, so their old edits can still be checked. */
const MAX_FORMER = 64;
const MAX_EPOCHS = 64;

/* ───────────────────────── key agreement ───────────────────────── */

/** The member's X25519 private key. It follows from the one seed a device keeps for a room. */
function xSecret(seed: Uint8Array): Uint8Array {
  return hkdf(sha256, seed, EMPTY, utf8('w-rooms/3 x25519'), 32);
}

export function xPublic(seed: Uint8Array): Uint8Array {
  return x25519.getPublicKey(xSecret(seed));
}

function less(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The key two members share and nobody else can make. Null when the other key is not usable. */
export function pairKey(seed: Uint8Array, peerX: Uint8Array, room: string): Uint8Array | null {
  if (peerX.length !== 32) return null;
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(xSecret(seed), peerX);
  } catch {
    return null;
  }
  if (shared.every((b) => b === 0)) return null;
  const mine = xPublic(seed);
  const [lo, hi] = less(mine, peerX) ? [mine, peerX] : [peerX, mine];
  return hkdf(sha256, shared, EMPTY, utf8(`w-rooms/3 pair ${room.toUpperCase()} ${b64encode(lo)} ${b64encode(hi)}`), 32);
}

/* ───────────────────────── the invite ───────────────────────── */

export interface HostKeys {
  /** The host's Ed25519 public key, base64. */
  k: string;
  /** The host's X25519 public key, base64. */
  x: string;
}

export interface InviteContent extends HostKeys {
  kind?: RoomKind;
}

const INVITE_AAD = 'w-rooms/3 invite';
const isKeyText = (v: unknown): v is string => typeof v === 'string' && v.length === 43 && b64decode(v)?.length === 32;

/** What the relay keeps for an invite and hands to whoever redeems it: who the host is, sealed for the link's holder. */
export function wrapInvite(wrapKey: Uint8Array, content: InviteContent): string {
  return b64encode(seal(wrapKey, INVITE_AAD, utf8(JSON.stringify(content))));
}

export function openInvite(wrapKey: Uint8Array, wrapped: string): InviteContent | null {
  const bytes = b64decode(wrapped);
  const plain = bytes && open(wrapKey, INVITE_AAD, bytes);
  if (!plain) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(plain)) as InviteContent;
    if (!isKeyText(c.k) || !isKeyText(c.x)) return null;
    return { k: c.k, x: c.x, ...(c.kind === 'shared' || c.kind === 'host-view' ? { kind: c.kind } : {}) };
  } catch {
    return null;
  }
}

/** Shows the host that the newcomer holds the link, and which keys are really theirs. The relay cannot make one. */
export function joinMac(bindKey: Uint8Array, room: string, k: string, x: string, hostK: string): string {
  return b64encode(hmac(sha256, bindKey, utf8(`w-rooms/3 join ${room.toUpperCase()} ${k} ${x} ${hostK}`)));
}

/* ───────────────────────── who is in the room, signed by the host ───────────────────────── */

export interface RosterEntry {
  k: string;
  x: string;
  /** The epoch in which this person came in. */
  since: number;
  /** The last epoch in which they were a member; absent for someone who is one now. */
  until?: number;
}

export interface SignedRoster {
  /** The key epoch this list goes with. */
  e: number;
  /** Goes up with every change, so an old list cannot replace a newer one. */
  n: number;
  m: RosterEntry[];
  sig: string;
}

export function rosterInput(room: string, r: Pick<SignedRoster, 'e' | 'n' | 'm'>): string {
  return `w-rooms/3 roster ${room.toUpperCase()} ${r.e} ${r.n}` + r.m.map((m) => ` ${m.k},${m.x},${m.since},${m.until ?? 0}`).join('');
}

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 0xffffffff;

function parseRoster(value: unknown): SignedRoster | null {
  const r = value as Partial<SignedRoster> | null;
  if (!r || typeof r !== 'object' || !isEpoch(r.e) || !isEpoch(r.n) || typeof r.sig !== 'string' || !Array.isArray(r.m) || r.m.length > 16 + MAX_FORMER) return null;
  const m: RosterEntry[] = [];
  for (const entry of r.m as (Partial<RosterEntry> | null)[]) {
    if (!entry || !isKeyText(entry.k) || !isKeyText(entry.x) || !isEpoch(entry.since)) return null;
    if (entry.until !== undefined && !isEpoch(entry.until)) return null;
    m.push({ k: entry.k, x: entry.x, since: entry.since, ...(entry.until !== undefined ? { until: entry.until } : {}) });
  }
  return { e: r.e, n: r.n, m, sig: r.sig };
}

function verify(sig: Uint8Array | null, message: Uint8Array, key: Uint8Array): boolean {
  if (!sig || sig.length !== SIG_BYTES) return false;
  try {
    return ed25519.verify(sig, message, key);
  } catch {
    return false;
  }
}

/* ───────────────────────── frames ───────────────────────── */

const groupAad = (room: string, epoch: number, kind: number, from: number) => `w-rooms/3 all ${room} ${epoch} ${kind} ${from}`;
const pairAad = (room: string, kind: number, from: number, to: number) => `w-rooms/3 one ${room} ${kind} ${from} ${to}`;

/** What a sender signs: the room, epoch, kind and sender, and the hash of the sealed bytes. */
function signedInput(room: string, epoch: number, kind: number, from: number, hash: Uint8Array): Uint8Array {
  const head = utf8(`w-rooms/3 frame ${room} ${epoch} ${kind} ${from} `);
  const out = new Uint8Array(head.length + hash.length);
  out.set(head);
  out.set(hash, head.length);
  return out;
}

/** One number for a frame as it travelled, signature included: what the order of edits is counted with. */
function digestOf(hash: Uint8Array, sig: Uint8Array): Uint8Array {
  const both = new Uint8Array(hash.length + sig.length);
  both.set(hash);
  both.set(sig, hash.length);
  return sha256(both);
}

export interface Opened {
  /** Null when the frame cannot be read: changed, forged, for someone else, or from nobody in the room. */
  plain: Uint8Array | null;
  /** True when it might be readable with keys this device does not have yet. */
  need: boolean;
  /** For a frame to everyone: the number the order of edits is counted with. */
  digest: Uint8Array | null;
}

export interface Sealed {
  payload: Uint8Array;
  epoch: number;
  digest: Uint8Array | null;
}

interface Known extends RosterEntry {
  ed: Uint8Array;
}

interface Stored {
  v: 1;
  host: HostKeys;
  roster: SignedRoster | null;
  epochs: [number, string][];
  binds: [string, string][];
}

export class RoomKeys {
  readonly self: number;
  readonly k: string;
  readonly x: string;
  readonly hostId: number;
  roster: SignedRoster | null = null;
  private readonly room: string;
  private readonly epochs = new Map<number, Uint8Array>();
  private known = new Map<number, Known>();
  private readonly pairs = new Map<string, Uint8Array | null>();
  /** Host only: for each invite made here, the key that checks a newcomer's proof. */
  private readonly binds = new Map<string, string>();
  /** Senders no list has named. True once the host's own list has been seen not to name them. */
  private readonly unknown = new Map<number, boolean>();

  private constructor(
    room: string,
    private readonly seed: Uint8Array,
    readonly host: HostKeys,
  ) {
    this.room = room.toUpperCase();
    const ed = publicKey(seed);
    this.k = b64encode(ed);
    this.x = b64encode(xPublic(seed));
    this.self = memberId(ed);
    this.hostId = memberId(b64decode(host.k) ?? EMPTY);
  }

  /** The keys of a room made on this device: the first room key, and a list with only the host on it. */
  static host(room: string, seed: Uint8Array): RoomKeys {
    const keys = new RoomKeys(room, seed, { k: b64encode(publicKey(seed)), x: b64encode(xPublic(seed)) });
    keys.epochs.set(1, crypto.getRandomValues(new Uint8Array(32)));
    keys.sign(1, 1, [{ k: keys.k, x: keys.x, since: 1 }]);
    return keys;
  }

  /** What a newcomer starts with: who the host is, from the invite. The room key comes from the host. */
  static guest(room: string, seed: Uint8Array, host: HostKeys): RoomKeys {
    return new RoomKeys(room, seed, { k: host.k, x: host.x });
  }

  static load(room: string, seed: Uint8Array, stored: string): RoomKeys | null {
    try {
      const s = JSON.parse(stored) as Partial<Stored> | null;
      if (!s || s.v !== 1 || !s.host || !isKeyText(s.host.k) || !isKeyText(s.host.x) || !Array.isArray(s.epochs)) return null;
      const keys = new RoomKeys(room, seed, s.host);
      const roster = parseRoster(s.roster);
      if (!roster || !keys.accept(roster)) return null;
      for (const [epoch, text] of s.epochs.slice(0, MAX_EPOCHS)) {
        const key = typeof text === 'string' ? b64decode(text) : null;
        if (isEpoch(epoch) && key?.length === 32) keys.epochs.set(epoch, key);
      }
      for (const [id, bind] of Array.isArray(s.binds) ? s.binds.slice(0, 256) : []) if (typeof id === 'string' && isKeyText(bind)) keys.binds.set(id, bind);
      return keys.epochs.size > 0 ? keys : null;
    } catch {
      return null;
    }
  }

  /** Everything needed to come back to the room, as text. It holds secrets: see `SECURITY.md` on where it is kept. */
  dump(): string {
    const stored: Stored = { v: 1, host: this.host, roster: this.roster, epochs: [...this.epochs].map(([e, key]) => [e, b64encode(key)]), binds: [...this.binds] };
    return JSON.stringify(stored);
  }

  get isHost(): boolean {
    return this.self === this.hostId;
  }

  /** The newest key epoch this device holds a key for; 0 before the host has let it in. */
  get epoch(): number {
    let top = 0;
    for (const e of this.epochs.keys()) if (e > top) top = e;
    return top;
  }

  /** True once this device has a room key and the host's list of members. */
  get ready(): boolean {
    return this.roster !== null && this.epochs.size > 0;
  }

  /** True for someone the host's list names as a member now. */
  current(id: number): boolean {
    const m = this.known.get(id);
    return !!m && m.until === undefined;
  }

  /** The members now, as the host signed them. */
  members(): { id: number; k: string; x: string }[] {
    return [...this.known].filter(([, m]) => m.until === undefined).map(([id, m]) => ({ id, k: m.k, x: m.x }));
  }

  /* ── sealing and opening ── */

  private pairWith(id: number, hint?: string | null): Uint8Array | null {
    const x = id === this.hostId ? this.host.x : this.current(id) ? this.known.get(id)!.x : (hint ?? null);
    if (!x) return null;
    if (!this.pairs.has(x)) this.pairs.set(x, pairKey(this.seed, b64decode(x) ?? EMPTY, this.room));
    return this.pairs.get(x) ?? null;
  }

  /** Whether a frame for `to` (0 for everyone) can be sealed now. */
  canSend(to: number): boolean {
    return to === 0 ? this.ready : this.pairWith(to) !== null;
  }

  /** Seals a frame for one member, or seals and signs it for everyone. Null without the keys for it. */
  seal(kind: number, to: number, plain: Uint8Array): Sealed | null {
    const epoch = this.epoch;
    if (to !== 0) {
      const key = this.pairWith(to);
      return key ? { payload: seal(key, pairAad(this.room, kind, this.self, to), plain), epoch: Math.max(1, epoch), digest: null } : null;
    }
    const key = this.epochs.get(epoch);
    if (!key || !this.roster) return null;
    const body = seal(key, groupAad(this.room, epoch, kind, this.self), plain);
    const hash = sha256(body);
    const sig = ed25519.sign(signedInput(this.room, epoch, kind, this.self, hash), this.seed);
    const payload = new Uint8Array(body.length + SIG_BYTES);
    payload.set(body);
    payload.set(sig, body.length);
    return { payload, epoch, digest: digestOf(hash, sig) };
  }

  /**
   * Opens a frame as the relay delivered it. `hint` gives the key agreement key the relay
   * names for a sender the host does not know yet: only a join request is ever read that way.
   */
  open(h: FrameHeader, payload: Uint8Array, hint?: (id: number) => string | null): Opened {
    if (h.to !== 0) {
      if (h.to !== this.self) return { plain: null, need: false, digest: null };
      const key = this.pairWith(h.from, this.isHost && h.kind === FrameKind.Key ? hint?.(h.from) : null);
      if (!key) return { plain: null, need: this.mayLearn(h.from), digest: null };
      return { plain: open(key, pairAad(this.room, h.kind, h.from, h.to), payload), need: false, digest: null };
    }
    if (payload.length < SEALED_MIN + SIG_BYTES) return { plain: null, need: false, digest: sha256(payload) };
    const body = payload.subarray(0, payload.length - SIG_BYTES);
    const sig = payload.subarray(payload.length - SIG_BYTES);
    const hash = sha256(body);
    const digest = digestOf(hash, sig);
    const key = this.epochs.get(h.epoch);
    // A later epoch than this device has a key for: the host made a new key and it is still on its way.
    if (!key) return { plain: null, need: h.epoch > this.epoch || !this.ready, digest };
    const sender = this.known.get(h.from);
    if (!sender) return { plain: null, need: this.mayLearn(h.from), digest };
    // Someone who was removed signs nothing after the epoch they left in.
    if (sender.until !== undefined && h.epoch > sender.until) return { plain: null, need: false, digest };
    if (!verify(sig, signedInput(this.room, h.epoch, h.kind, h.from, hash), sender.ed)) return { plain: null, need: false, digest };
    return { plain: open(key, groupAad(this.room, h.epoch, h.kind, h.from), body), need: false, digest };
  }

  /** A sender nobody has named yet may be someone the host let in a moment ago. The host itself knows. */
  private mayLearn(from: number): boolean {
    if (this.isHost) return false;
    if (!this.unknown.has(from)) {
      if (this.unknown.size >= 256) this.unknown.clear();
      this.unknown.set(from, false);
    }
    return this.unknown.get(from) === false;
  }

  /** The host's newest list has arrived: whoever it does not name is not in the room. */
  confirmUnknown(): void {
    for (const id of this.unknown.keys()) this.unknown.set(id, true);
  }

  /* ── coming in ── */

  /** Host: remembers the key that checks proofs for an invite made here. */
  addInvite(id: string, bindKey: Uint8Array): void {
    this.binds.set(id, b64encode(bindKey));
  }

  /** Newcomer: asks the host to be let in, with proof of holding the link. */
  joinMeta(secret: Uint8Array): Meta {
    const invite = inviteKeys(secret);
    return { t: 'join', inv: invite.id, k: this.k, x: this.x, mac: joinMac(invite.bindKey, this.room, this.k, this.x, this.host.k) };
  }

  /**
   * Host: puts a newcomer on the list, if they hold a link made here and the keys the relay
   * names for them are the ones they proved. True when they are on the list afterwards.
   */
  admit(from: number, meta: Meta, relay: { key: string; xkey: string | null } | undefined): boolean {
    if (!this.isHost || !this.roster || meta.t !== 'join' || !isKeyText(meta.k) || !isKeyText(meta.x) || typeof meta.inv !== 'string' || typeof meta.mac !== 'string') return false;
    if (memberId(b64decode(meta.k)!) !== from || !relay || relay.key !== meta.k || relay.xkey !== meta.x) return false;
    const bind = b64decode(this.binds.get(meta.inv) ?? '');
    if (!bind || bind.length !== 32 || !sameText(joinMac(bind, this.room, meta.k, meta.x, this.k), meta.mac)) return false;
    const there = this.known.get(from);
    if (there) return there.until === undefined && there.k === meta.k && there.x === meta.x;
    this.sign(this.roster.e, this.roster.n + 1, [...this.roster.m, { k: meta.k, x: meta.x, since: this.epoch }]);
    return true;
  }

  /* ── a new key ── */

  /** Host: takes `removed` off the list and makes a new room key for the people who stay. */
  rotate(removed: number[]): void {
    if (!this.isHost || !this.roster) return;
    const old = this.epoch;
    const gone = new Set(removed.filter((id) => id !== this.self));
    let m = this.roster.m.map((entry) => (entry.until === undefined && gone.has(memberId(b64decode(entry.k)!)) ? { ...entry, until: old } : entry));
    const former = m.filter((entry) => entry.until !== undefined);
    if (former.length > MAX_FORMER) {
      const drop = new Set(former.slice(0, former.length - MAX_FORMER));
      m = m.filter((entry) => !drop.has(entry));
    }
    this.epochs.set(old + 1, crypto.getRandomValues(new Uint8Array(32)));
    if (this.epochs.size > MAX_EPOCHS) this.epochs.delete(Math.min(...this.epochs.keys()));
    this.sign(old + 1, this.roster.n + 1, m);
  }

  /** The list and the room keys for one member, to send under the pair key. Null for anyone not on the list now. */
  keysFor(to: number): Meta | null {
    const them = this.known.get(to);
    if (!this.roster || !them || them.until !== undefined || to === this.self) return null;
    const k: Record<string, string> = {};
    for (const [epoch, key] of this.epochs) if (epoch >= them.since) k[epoch] = b64encode(key);
    return { t: 'keys', r: this.roster, k };
  }

  /**
   * Takes a list and room keys another member sent. The list must be signed by the host, name
   * this device and the sender as members, and be no older than the one held. 'new' when
   * something was learned, 'same' when it was all known, null when it was refused.
   */
  take(from: number, meta: Meta): 'new' | 'same' | null {
    if (this.isHost || meta.t !== 'keys') return null;
    const roster = parseRoster(meta.r);
    if (!roster) return null;
    const held = this.roster;
    if (held && (roster.e < held.e || (roster.e === held.e && roster.n < held.n))) return null;
    const newer = !held || roster.e > held.e || roster.n > held.n;
    if (newer) {
      const before = { roster: this.roster, known: this.known };
      if (!this.accept(roster)) return null;
      if (!this.current(from)) {
        this.roster = before.roster;
        this.known = before.known;
        return null;
      }
      this.pairs.clear();
    } else if (rosterInput(this.room, roster) !== rosterInput(this.room, held) || !this.current(from)) return null;
    let learned = newer;
    const given = meta.k && typeof meta.k === 'object' ? Object.entries(meta.k as Record<string, unknown>).slice(0, MAX_EPOCHS) : [];
    for (const [text, value] of given) {
      const epoch = Number(text);
      const key = typeof value === 'string' ? b64decode(value) : null;
      // A key already held is never replaced, and none is taken for an epoch the host has not reached.
      if (!isEpoch(epoch) || epoch > this.roster!.e || !key || key.length !== 32 || this.epochs.has(epoch)) continue;
      this.epochs.set(epoch, key);
      learned = true;
    }
    if (this.epochs.size > MAX_EPOCHS) this.epochs.delete(Math.min(...this.epochs.keys()));
    return learned ? 'new' : 'same';
  }

  /** Checks a list against the host's key and takes it. It must name this device as a member. */
  private accept(roster: SignedRoster): boolean {
    const hostEd = b64decode(this.host.k);
    if (!hostEd || !verify(b64decode(roster.sig), utf8(rosterInput(this.room, roster)), hostEd)) return false;
    const known = new Map<number, Known>();
    for (const entry of roster.m) {
      const ed = b64decode(entry.k)!;
      const id = memberId(ed);
      // Someone who is a member now comes before someone with the same id who left.
      if (!known.has(id) || entry.until === undefined) known.set(id, { ...entry, ed });
    }
    const me = known.get(this.self);
    if (!me || me.until !== undefined || me.k !== this.k || me.x !== this.x) return false;
    this.roster = roster;
    this.known = known;
    return true;
  }

  private sign(e: number, n: number, m: RosterEntry[]): void {
    const sig = b64encode(ed25519.sign(utf8(rosterInput(this.room, { e, n, m })), this.seed));
    this.pairs.clear();
    this.accept({ e, n, m, sig });
  }
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
