import { FrameKind, frame, parseFrame, roomUrl, type PeerMessage, type ServerMessage } from './protocol';

type Outgoing = { t: string; to?: number; [key: string]: unknown };

export interface RoomEvents {
  onWelcome(msg: Extract<ServerMessage, { t: 'welcome' }>, reconnected: boolean): void;
  onJoin(id: number, name: string): void;
  onLeave(id: number): void;
  onMessage(msg: PeerMessage): void;
  onFrame(from: number, kind: number, payload: Uint8Array): void;
  onStatus(status: 'connecting' | 'online' | 'reconnecting'): void;
  /** The connection is gone for good: bad address, room full, or retries ran out. */
  onClosed(reason: 'unreachable' | 'full' | 'lost'): void;
}

const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000, 8000];

export class RoomClient {
  private ws: WebSocket | null = null;
  private everOpen = false;
  private retries = 0;
  private closedByUser = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly server: string,
    private readonly code: string,
    private readonly name: string,
    private readonly events: RoomEvents,
  ) {}

  connect(): void {
    this.events.onStatus(this.everOpen ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(roomUrl(this.server, this.code, this.name));
    } catch {
      this.events.onClosed('unreachable');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg: ServerMessage | PeerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          const reconnected = this.everOpen;
          this.everOpen = true;
          this.retries = 0;
          this.events.onStatus('online');
          this.events.onWelcome(msg, reconnected);
        } else if (msg.t === 'join') this.events.onJoin(msg.id, msg.name);
        else if (msg.t === 'leave') this.events.onLeave(msg.id);
        else this.events.onMessage(msg);
      } else {
        const parsed = parseFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (parsed) this.events.onFrame(parsed.from, parsed.kind, parsed.payload);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) return;
      if (ev.code === 4001) return this.events.onClosed('full');
      if (!this.everOpen) return this.events.onClosed('unreachable');
      if (this.retries >= RETRY_DELAYS.length) return this.events.onClosed('lost');
      this.events.onStatus('reconnecting');
      this.timer = setTimeout(() => this.connect(), RETRY_DELAYS[this.retries++]);
    };
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Bytes queued but not yet on the wire; used to pace large transfers. */
  get backlog(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  send(msg: Outgoing): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  sendFrame(kind: FrameKind, payload: Uint8Array, to = 0): void {
    if (this.open) this.ws!.send(frame(kind, payload, to) as Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
