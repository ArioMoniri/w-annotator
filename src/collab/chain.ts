/**
 * A running hash over the room's edits, in the order they were applied (`ROOMS-PROTOCOL.md` §19.6).
 *
 * The room server gives edits their order, so it could give two members different edits
 * under the same number, leave one out for somebody, or swap two. No member can stop that,
 * but together they can see it: each keeps a hash chain over the edits it applied, and every
 * edit and now and then a short note carries the sender's place in the chain, sealed and
 * signed like everything else. Two members who applied the same edits have the same chain.
 * Two who were shown different things do not, and the first frame that passes between them says so.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { b64decode, b64encode } from './protocol';

/** A member's place in the chain: the room server's session, the number of the last edit, the chain there. */
export type Claim = [session: string, seq: number, hash: string];

/** How many places back a member can still compare or return to. The room server replays at most 2048 edits. */
const REMEMBERED = 4096;

function parseClaim(value: unknown): Claim | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [session, seq, hash] = value as unknown[];
  if (typeof session !== 'string' || session.length > 64 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof hash !== 'string' || b64decode(hash)?.length !== 32) return null;
  return [session, seq, hash];
}

export class OpChain {
  /** The number of the last edit counted. */
  head = 0;
  private session = '';
  /** The chain at `head`; null when this device does not know it. */
  private value: Uint8Array | null = null;
  /** The chain at earlier edits, oldest first. */
  private past = new Map<number, string>();
  /** What others said about edits this device has not reached yet. */
  private waiting = new Map<number, Claim>();

  constructor(
    private readonly room: string,
    private readonly remembered = REMEMBERED,
  ) {}

  /** The start of a room, or of a room the room server lost and the host opened again. */
  start(session: string): void {
    this.set(session, 0, sha256(new TextEncoder().encode(`w-rooms/3 chain ${this.room.toUpperCase()} ${session}`)));
  }

  /** Takes the place of the member who sent this device the mask. */
  adopt(claim: unknown): boolean {
    const c = parseClaim(claim);
    if (!c) return false;
    this.set(c[0], c[1], b64decode(c[2])!);
    return true;
  }

  private set(session: string, head: number, value: Uint8Array): void {
    if (session !== this.session) this.waiting.clear();
    this.session = session;
    this.head = head;
    this.value = value;
    this.past = new Map([[head, b64encode(value)]]);
  }

  /** This device no longer knows its place; it says nothing until it is given one. */
  lose(): void {
    this.value = null;
    this.past.clear();
    this.waiting.clear();
  }

  /**
   * Counts the edit numbered `seq`, which must be the next one. Returns the members whose
   * earlier word about this place does not agree with what this device now has.
   */
  push(seq: number, from: number, digest: Uint8Array): number[] {
    if (!this.value || seq !== this.head + 1) return [];
    const input = new Uint8Array(32 + 8 + 4 + digest.length);
    const view = new DataView(input.buffer);
    input.set(this.value);
    view.setBigUint64(32, BigInt(seq), true);
    view.setUint32(40, from, true);
    input.set(digest, 44);
    this.value = sha256(input);
    this.head = seq;
    const text = b64encode(this.value);
    this.past.set(seq, text);
    if (this.past.size > this.remembered) this.past.delete(this.past.keys().next().value as number);
    const differ: number[] = [];
    for (const [peer, claim] of this.waiting) {
      if (claim[1] !== seq) continue;
      this.waiting.delete(peer);
      if (claim[2] !== text) differ.push(peer);
    }
    return differ;
  }

  /** Back to an earlier edit, when a catch-up starts again from where it began. False when that is too far back. */
  rewind(head: number): boolean {
    if (head === this.head && this.value) return true;
    const text = this.past.get(head);
    if (!this.value || !text) {
      this.lose();
      this.head = head;
      return false;
    }
    for (const seq of [...this.past.keys()]) if (seq > head) this.past.delete(seq);
    this.head = head;
    this.value = b64decode(text);
    return true;
  }

  /** This device's place at an earlier edit it still remembers, without going back there. */
  claimAt(seq: number): Claim | null {
    const text = this.value ? this.past.get(seq) : undefined;
    return text ? [this.session, seq, text] : null;
  }

  /** This device's place, to tell the others. */
  claim(): Claim | null {
    return this.value ? [this.session, this.head, b64encode(this.value)] : null;
  }

  /**
   * Sets another member's place against this device's own. 'fork' means the two were shown
   * different edits. 'wait' means this device is not there yet; `push` reports it later.
   */
  check(peer: number, value: unknown): 'ok' | 'fork' | 'wait' | 'skip' {
    const claim = parseClaim(value);
    if (!claim || !this.value || claim[0] !== this.session) return 'skip';
    if (claim[1] > this.head) {
      this.waiting.delete(peer);
      if (this.waiting.size < 64) this.waiting.set(peer, claim);
      return 'wait';
    }
    const mine = this.past.get(claim[1]);
    if (!mine) return 'skip';
    return mine === claim[2] ? 'ok' : 'fork';
  }
}
