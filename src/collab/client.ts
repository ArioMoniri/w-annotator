/**
 * One connection to a room on the relay: the handshake, staying connected, and
 * sealing and opening payloads. What the messages mean is the session's business.
 */

import { frameAad, open, seal } from './crypto';
import { handshakeSignature, inviteKeys, inviteProof, memberId, publicKey } from './identity';
import {
  PROTO,
  b64encode,
  decodeFrame,
  encodeFrame,
  pack,
  roomSocketUrl,
  unpack,
  type FrameHeader,
  type FrameKind,
  type Member,
  type Meta,
  type Role,
  type RoomKind,
  type Welcome,
} from './protocol';
import { TokenBucket } from './transfer';

export interface MemberKey {
  key: string;
  role: 'editor' | 'viewer';
}

export type JoinMode = { t: 'create'; type: RoomKind; members?: MemberKey[] } | { t: 'auth' } | { t: 'redeem'; secret: Uint8Array };

/** The one text message a client sends after `hello` (§3.3 to §3.5). No name, nothing about the image. */
export function handshakeMessage(mode: JoinMode, seed: Uint8Array, room: string, nonce: string): Record<string, unknown> {
  const key = b64encode(publicKey(seed));
  const base = { t: mode.t, proto: PROTO, key, sig: handshakeSignature(seed, mode.t, room, nonce) };
  if (mode.t === 'create') return { ...base, type: mode.type, ...(mode.members?.length ? { members: mode.members } : {}) };
  if (mode.t === 'redeem') {
    const invite = inviteKeys(mode.secret);
    return { ...base, invite: invite.id, proof: inviteProof(invite.authKey, room, nonce, key) };
  }
  return base;
}

/**
 * The close code this app gives a room whose server told it something that cannot be true:
 * another kind of room than the one made, a guest named host, someone else's member id.
 */
export const CLOSE_MISFIT = 4999;

/** What to do when the socket closes (§11). */
export function afterClose(code: number, welcomed: boolean, host: boolean): 'retry' | 'recreate' | 'ended' {
  if (!welcomed) return 'ended';
  if (code === 4404) return host ? 'recreate' : 'retry';
  return [4001, 4003, 4400, 4401, 4403, 4408, 4409, 4410, 4426, CLOSE_MISFIT].includes(code) ? 'ended' : 'retry';
}

/** Wait before reconnect number `attempt`: 1 s doubling to 30 s, each time somewhere in its upper half. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const top = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 10));
  return Math.round(top / 2 + (random() * top) / 2);
}

/* ───────────────────────── what the room server says, checked ───────────────────────── */

const ROLES: Role[] = ['host', 'editor', 'viewer'];
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMemberId = (v: unknown): v is number => isCount(v) && v > 0 && v <= 0xffffffff;

/** The member list as the relay sent it, without anything that is not a member. Null when it is not a list. */
export function parseRoster(value: unknown): Member[] | null {
  if (!Array.isArray(value)) return null;
  const out: Member[] = [];
  // A room holds 16 members; a longer list is not one.
  for (const m of value.slice(0, 64) as (Partial<Member> | null)[]) {
    if (!m || typeof m !== 'object' || !isMemberId(m.id) || typeof m.key !== 'string' || !ROLES.includes(m.role as Role) || typeof m.online !== 'boolean') continue;
    out.push({ id: m.id, key: m.key, xkey: typeof m.xkey === 'string' ? m.xkey : null, role: m.role as Role, online: m.online });
  }
  return out;
}

/** `welcome` with every field the app goes on to use, or null. The relay is not trusted to send it right. */
export function parseWelcome(msg: unknown): Welcome | null {
  const w = msg as Partial<Welcome> | null;
  const self = w?.self;
  const room = w?.room;
  const roster = parseRoster(w?.roster);
  if (!self || !room || !roster || !isMemberId(self.id) || !ROLES.includes(self.role)) return null;
  if (room.type !== 'shared' && room.type !== 'host-view') return null;
  if (!isCount(room.head) || !isCount(room.epoch) || typeof room.session !== 'string' || room.session.length > 64) return null;
  if (w.invite !== undefined && (!w.invite || typeof w.invite.wrappedKey !== 'string')) return null;
  return {
    t: 'welcome',
    self: { id: self.id, role: self.role },
    room: {
      id: String(room.id ?? ''),
      type: room.type,
      state: room.state === 'host-away' ? 'host-away' : 'active',
      proto: Number(room.proto) || PROTO,
      epoch: room.epoch,
      head: room.head,
      logFloor: isCount(room.logFloor) ? room.logFloor : 0,
      session: room.session,
    },
    roster,
    ...(w.invite ? { invite: { wrappedKey: w.invite.wrappedKey } } : {}),
  };
}

/** What this device knows about the room without asking the relay. Null where it does not know yet. */
export interface Pinned {
  kind: RoomKind | null;
  host: boolean | null;
  /** This device's member id, which follows from its key. */
  self: number;
}

/**
 * Whether a `welcome` agrees with what this device knows. The kind of a room and who its
 * host is never change, so a relay that says otherwise is wrong or lying: taken at its word,
 * the host of a view-through-host room would start handing out the whole image.
 */
export function welcomeFits(w: Welcome, pinned: Pinned): boolean {
  if (w.self.id !== pinned.self) return false;
  if (pinned.kind !== null && w.room.type !== pinned.kind) return false;
  if (pinned.host !== null && (w.self.role === 'host') !== pinned.host) return false;
  return true;
}

/**
 * Whether a frame that opened really is from the member the relay stamped on it, and for
 * this device. The relay writes `from` and `to` in the clear header and could write anyone;
 * the sender repeats both inside the encrypted part (`f`, `d`), which the relay cannot change.
 * Apps from before this check send neither, and their frames are taken as before.
 */
export function frameIsBound(meta: Meta, header: FrameHeader, self: number): boolean {
  if (meta.f !== undefined && meta.f !== header.from) return false;
  if (meta.d !== undefined && meta.d !== 0 && meta.d !== self) return false;
  return true;
}

/* ───────────────────────── pacing ───────────────────────── */

export interface PaceLimits {
  messagesPerSec: number;
  bytesPerSec: number;
}

/** The relay's per-connection limits from `hello`, or the documented ones (§13). */
export function paceLimits(limits: unknown): PaceLimits {
  const l = limits as Partial<PaceLimits> | undefined;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return ok(l?.messagesPerSec) && ok(l?.bytesPerSec) ? { messagesPerSec: l.messagesPerSec, bytesPerSec: l.bytesPerSec } : { messagesPerSec: 200, bytesPerSec: 20 << 20 };
}

/**
 * How fast this connection may send: half of what the relay allows, with a small burst,
 * so that even a whole-volume edit or a file transfer never reaches the limit at which the
 * relay closes the connection (4429). `factor` is 4 for the host of a view-through-host
 * room, whom the relay allows four times as much.
 */
export class Pace {
  private readonly messages: TokenBucket;
  private readonly bytes: TokenBucket;

  constructor(limits: PaceLimits, factor: number, now: number) {
    const m = limits.messagesPerSec * factor;
    const b = limits.bytesPerSec * factor;
    this.messages = new TokenBucket(m / 4, m / 2, now);
    this.bytes = new TokenBucket(b / 5, b / 2, now);
  }

  /** Milliseconds until a frame of `bytes` may go. */
  wait(bytes: number, now: number): number {
    return Math.max(this.messages.wait(1, now), this.bytes.wait(bytes, now));
  }

  spend(bytes: number, now: number): void {
    this.messages.spend(1, now);
    this.bytes.spend(bytes, now);
  }
}

export type TextMessage = { t: string; [key: string]: unknown };

export interface RoomEvents {
  onStatus(status: 'connecting' | 'online' | 'offline'): void;
  /** `first` is false for every sign-in after the first one. */
  onWelcome(msg: Welcome, first: boolean): void;
  /** Everything the relay says in text after `welcome`, except answers to `request`. */
  onText(msg: TextMessage): void;
  /** `meta` is null for a frame that could not be opened; its place in the order still counts. */
  onFrame(header: FrameHeader, meta: Meta | null, body: Uint8Array): void;
  /** The connection is over for good. */
  onEnded(code: number, reason: string): void;
  /** Everyone else in the room, for a host that has to open it again. */
  members(): MemberKey[];
}

export interface SendOptions {
  to?: number;
  seq?: number;
  /** Not worth sending late: left out while other frames are waiting their turn. */
  droppable?: boolean;
}

interface Waiting {
  kind: FrameKind;
  meta: Meta;
  body?: Uint8Array;
  to?: number;
  seq?: number;
  bytes: number;
}

export class RoomClient {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private host = false;
  private attempts = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextRid = 1;
  private readonly waiting = new Map<number, (msg: TextMessage) => void>();
  private key: Uint8Array | null;
  private limits = paceLimits(undefined);
  private pace = new Pace(this.limits, 1, performance.now());
  private outbox: Waiting[] = [];
  private outboxBytes = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** This device's member id: it follows from the key, whatever the relay says. */
  readonly self: number;
  private readonly pinned: Pinned;
  epoch = 1;

  constructor(
    readonly server: string,
    readonly room: string,
    private readonly seed: Uint8Array,
    private mode: JoinMode,
    key: Uint8Array | null,
    private readonly events: RoomEvents,
    /** What is already known about the room: its kind and whether this device is its host. */
    known: { kind?: RoomKind; host?: boolean } = {},
  ) {
    this.key = key;
    this.self = memberId(publicKey(seed));
    this.pinned = {
      kind: mode.t === 'create' ? mode.type : (known.kind ?? null),
      host: mode.t === "create" ? true : (known.host ?? (mode.t === "redeem" ? false : null)),
      self: this.self,
    };
    if (this.pinned.kind) this.kind = this.pinned.kind;
  }

  /** The room key, once the invite has been redeemed. */
  setKey(key: Uint8Array): void {
    this.key = key;
  }

  connect(): void {
    if (this.stopped) return;
    this.events.onStatus(this.welcomed ? 'offline' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(roomSocketUrl(this.server, this.room));
    } catch {
      this.events.onEnded(1006, '');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data !== 'string') {
        const frame = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (!frame) return;
        const plain = this.key && open(this.key, frameAad(this.room, frame.header.epoch, frame.header.kind), frame.payload);
        const opened = plain ? unpack(plain) : null;
        // A frame the relay re-labelled is as unreadable as one it changed.
        const parts = opened && frameIsBound(opened.meta, frame.header, this.self) ? opened : null;
        this.events.onFrame(frame.header, parts?.meta ?? null, parts?.body ?? new Uint8Array(0));
        return;
      }
      let msg: TextMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'hello') {
        this.limits = paceLimits(msg.limits);
        ws.send(JSON.stringify(handshakeMessage(this.mode, this.seed, this.room, String(msg.nonce))));
      } else if (msg.t === 'welcome') {
        const welcome = parseWelcome(msg);
        if (!welcome || !welcomeFits(welcome, this.pinned)) {
          this.misfit(ws);
          return;
        }
        const first = !this.welcomed;
        this.welcomed = true;
        this.host = welcome.self.role === 'host';
        this.kind = welcome.room.type;
        // Neither changes for as long as the room lives.
        this.pinned.kind = this.kind;
        this.pinned.host = this.host;
        this.epoch = welcome.room.epoch;
        this.attempts = 0;
        this.pace = new Pace(this.limits, this.host && this.kind === 'host-view' ? 4 : 1, performance.now());
        // From now on this key is a member: sign in with it, whatever got us here.
        this.mode = { t: 'auth' };
        this.events.onStatus('online');
        this.events.onWelcome(welcome, first);
      } else if (typeof msg.rid === 'number' && this.waiting.has(msg.rid)) {
        const done = this.waiting.get(msg.rid)!;
        this.waiting.delete(msg.rid);
        done(msg);
      } else this.events.onText(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearOutbox();
      for (const done of this.waiting.values()) done({ t: 'error', code: 'offline' });
      this.waiting.clear();
      if (this.stopped) return;
      const next = afterClose(ev.code, this.welcomed, this.host);
      if (next === 'ended') {
        this.stopped = true;
        this.events.onEnded(ev.code, ev.reason);
        return;
      }
      if (next === 'recreate') this.mode = { t: 'create', type: this.kind, members: this.events.members() };
      this.events.onStatus('offline');
      this.timer = setTimeout(() => this.connect(), retryDelay(this.attempts++));
    };
  }

  /** Leaves a room whose server said something that cannot be true, and says so. */
  private misfit(ws: WebSocket): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws = null;
    this.clearOutbox();
    ws.close();
    this.events.onEnded(CLOSE_MISFIT, '');
  }

  /** Ends the connection from this side for a reason the session found. */
  leaveAsMisfit(): void {
    const ws = this.ws;
    if (this.stopped) return;
    if (ws) this.misfit(ws);
    else {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      this.events.onEnded(CLOSE_MISFIT, '');
    }
  }

  /** The kind of the room, as last told by the relay; needed to open it again. */
  kind: RoomKind = 'shared';

  /** Try again now instead of waiting for the next attempt. */
  reconnectNow(): void {
    if (this.stopped || this.ws) return;
    if (this.timer) clearTimeout(this.timer);
    this.attempts = 0;
    this.connect();
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Bytes waiting to go: frames held back by the pace, and what the socket has not sent yet. */
  get backlog(): number {
    return this.outboxBytes + (this.ws?.bufferedAmount ?? 0);
  }

  send(msg: TextMessage): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  /** A request to the relay and its answer. Resolves with an `error` message when it cannot be asked. */
  request(msg: TextMessage): Promise<TextMessage> {
    if (!this.open) return Promise.resolve({ t: 'error', code: 'offline' });
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      this.waiting.set(rid, resolve);
      this.ws!.send(JSON.stringify({ ...msg, rid }));
    });
  }

  /**
   * Seals and sends one frame, in the order frames were given, no faster than the pace
   * allows. False when offline or before the room key is known; true when the frame went
   * or is waiting its turn.
   */
  sendFrame(kind: FrameKind, meta: Meta, body?: Uint8Array, opts: SendOptions = {}): boolean {
    if (!this.open || !this.key) return false;
    const bytes = 64 + (body?.length ?? 0);
    const now = performance.now();
    if (this.outbox.length === 0 && this.pace.wait(bytes, now) <= 0) {
      this.sealAndSend({ kind, meta, body, to: opts.to, seq: opts.seq, bytes }, now);
      return true;
    }
    if (opts.droppable) return true;
    this.outbox.push({ kind, meta, body, to: opts.to, seq: opts.seq, bytes });
    this.outboxBytes += bytes;
    this.scheduleDrain(now);
    return true;
  }

  private sealAndSend(f: Waiting, now: number): void {
    if (!this.key || !this.ws) return;
    // Who it is from and for goes inside the encrypted part too (see `frameIsBound`).
    const meta: Meta = { ...f.meta, f: this.self, ...(f.to ? { d: f.to } : {}) };
    const payload = seal(this.key, frameAad(this.room, this.epoch, f.kind), pack(meta, f.body));
    this.pace.spend(payload.length + 24, now);
    this.ws.send(encodeFrame({ kind: f.kind, to: f.to, seq: f.seq, epoch: this.epoch }, payload) as Uint8Array<ArrayBuffer>);
  }

  private scheduleDrain(now: number): void {
    if (this.drainTimer || this.outbox.length === 0) return;
    const wait = Math.max(1, this.pace.wait(this.outbox[0].bytes, now));
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, wait);
  }

  private drain(): void {
    if (!this.open) return this.clearOutbox();
    const started = performance.now();
    while (this.outbox.length > 0) {
      const now = performance.now();
      // Sealing a megabyte takes a few milliseconds: stop after a short while so the screen stays live.
      if (this.pace.wait(this.outbox[0].bytes, now) > 0 || now - started > 12) break;
      const next = this.outbox.shift()!;
      this.outboxBytes -= next.bytes;
      this.sealAndSend(next, now);
    }
    this.scheduleDrain(performance.now());
  }

  private clearOutbox(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.outbox = [];
    this.outboxBytes = 0;
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.clearOutbox();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
