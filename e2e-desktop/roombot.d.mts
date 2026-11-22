/** Types for roombot.mjs, so the Playwright suite can use the same client. */

export const KIND: { patch: 1; segOp: 2; syncSlab: 3; imageSlab: 4; presence: 5; syncRequest: 9 };

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
  /** What it takes to come back as the same member: pass it to `joinRoom` again. */
  member: BotMember;
  send(kind: number, meta: Record<string, unknown>, body?: Uint8Array, opts?: { to?: number; seq?: number }): void;
  close(): void;
}

export interface BotMember {
  seed: Uint8Array;
  roomKey: Uint8Array;
}

export function joinRoom(link: string, name: string, member?: BotMember | null): Promise<Bot>;
export function assemble(frames: BotFrame[], kind: number, rid: number): Buffer;
