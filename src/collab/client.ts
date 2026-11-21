/**
 * One connection to a room on the relay: the handshake, staying connected, and
 * sealing and opening payloads. What the messages mean is the session's business.
 */

import { frameAad, open, seal } from './crypto';
import { handshakeSignature, inviteKeys, inviteProof, publicKey } from './identity';
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
  type Meta,
  type RoomKind,
  type Welcome,
} from './protocol';

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

/** What to do when the socket closes (§11). */
export function afterClose(code: number, welcomed: boolean, host: boolean): 'retry' | 'recreate' | 'ended' {
  if (!welcomed) return 'ended';
  if (code === 4404) return host ? 'recreate' : 'retry';
  return [4001, 4003, 4400, 4401, 4403, 4408, 4409, 4410, 4426].includes(code) ? 'ended' : 'retry';
}

/** Wait before reconnect number `attempt`: 1 s doubling to 30 s, each time somewhere in its upper half. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const top = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 10));
  return Math.round(top / 2 + (random() * top) / 2);
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
  epoch = 1;

  constructor(
    readonly server: string,
    readonly room: string,
    private readonly seed: Uint8Array,
    private mode: JoinMode,
    key: Uint8Array | null,
    private readonly events: RoomEvents,
  ) {
    this.key = key;
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
        const parts = plain ? unpack(plain) : null;
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
        ws.send(JSON.stringify(handshakeMessage(this.mode, this.seed, this.room, String(msg.nonce))));
      } else if (msg.t === 'welcome') {
        const welcome = msg as unknown as Welcome;
        const first = !this.welcomed;
        this.welcomed = true;
        this.host = welcome.self.role === 'host';
        this.kind = welcome.room.type;
        this.epoch = welcome.room.epoch;
        this.attempts = 0;
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

  /** Bytes queued but not yet on the wire; used to pace large transfers. */
  get backlog(): number {
    return this.ws?.bufferedAmount ?? 0;
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

  /** Seals and sends one frame. False when offline or before the room key is known. */
  sendFrame(kind: FrameKind, meta: Meta, body?: Uint8Array, opts: { to?: number; seq?: number } = {}): boolean {
    if (!this.open || !this.key) return false;
    const payload = seal(this.key, frameAad(this.room, this.epoch, kind), pack(meta, body));
    this.ws!.send(encodeFrame({ kind, to: opts.to, seq: opts.seq, epoch: this.epoch }, payload) as Uint8Array<ArrayBuffer>);
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
