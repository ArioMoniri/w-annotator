/** Types for roombot.mjs, so the Playwright suite can use the same client. */

export const KIND: { patch: 1; segOp: 2; syncSlab: 3; imageSlab: 4; presence: 5; key: 8; syncRequest: 9 };

export interface BotFrame {
  kind: number;
  from: number;
  seq: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: Record<string, any>;
  body: Uint8Array;
}

export interface Bot {
  room: string;
  frames: BotFrame[];
  texts: Record<string, unknown>[];
  welcome: {
    self: { id: number; role: string };
    room: { type: string; head: number };
    roster: { id: number; role: string; online: boolean }[];
  };
  closed: { code: number; reason: string } | null;
  /** The bot's member id. */
  self: number;
  /** Whether the bot can read a frame it was not sent, had the relay stamped it as from `from`. */
  canRead(bytes: Uint8Array, from: number): boolean;
  send(kind: number, meta: Record<string, unknown>, body?: Uint8Array, opts?: { to?: number; seq?: number }): void;
  close(): void;
}

export function joinRoom(link: string, name: string): Promise<Bot>;
export function assemble(frames: BotFrame[], kind: number, rid: number): Buffer;
