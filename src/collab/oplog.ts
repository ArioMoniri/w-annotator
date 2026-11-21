/**
 * The order of edits in a room (`ROOMS-PROTOCOL.md` §5.3).
 *
 * The relay numbers every accepted edit. Everyone applies edits in that order, and keeps
 * their own edits that have no number yet on top, because those will be numbered later
 * and so win. That is all it takes for every member to end with the same mask.
 */

export interface OpLogHooks<Op> {
  /** An edit took its place in the room's order: write it to the confirmed state and to what is on screen. */
  confirm(op: Op, own: boolean): void;
  /** Put one of my still unnumbered edits back on top of what is on screen. */
  reapply(op: Op): void;
  /** Edits after `after` are missing; ask the relay for them. */
  replay(after: number): void;
}

export class OpLog<Op> {
  /** Sequence number of the last edit applied. */
  head = 0;
  private waiting: { cid: number; op: Op }[] = [];
  private nextCid = 1;
  private gap = false;

  constructor(private readonly hooks: OpLogHooks<Op>) {}

  /** How many of my edits the room has not numbered yet. */
  get pending(): number {
    return this.waiting.length;
  }

  /** My edits the room has not numbered yet, oldest first. */
  unconfirmed(): Op[] {
    return this.waiting.map((w) => w.op);
  }

  /** Puts my unnumbered edits back on top, after what is on screen was written from elsewhere. */
  reapplyAll(): void {
    for (const w of this.waiting) this.hooks.reapply(w.op);
  }

  /** Records an edit I just made and returns the id to send it under. */
  local(op: Op): number {
    const cid = this.nextCid++;
    this.waiting.push({ cid, op });
    return cid;
  }

  /**
   * A numbered edit arrived. `settles` is the id of one of my own edits when this is
   * that edit coming back: in a replay, or re-sent by the host of a view-through-host room.
   */
  remote(seq: number, op: Op, settles?: number): void {
    if (!this.take(seq)) return;
    const own = settles !== undefined && this.drop(settles);
    this.hooks.confirm(op, own);
    for (const w of this.waiting) this.hooks.reapply(w.op);
  }

  /** The relay accepted my edit `cid` and gave it number `seq`. */
  ack(cid: number, seq: number): void {
    if (seq <= this.head) {
      // It already came back another way.
      this.drop(cid);
      return;
    }
    if (!this.take(seq)) return;
    const mine = this.waiting.find((w) => w.cid === cid);
    this.drop(cid);
    if (!mine) return;
    this.hooks.confirm(mine.op, true);
    for (const w of this.waiting) this.hooks.reapply(w.op);
  }

  /** Start again from a known state of the room, for example after a merge. Unnumbered edits are forgotten. */
  reset(head: number): void {
    this.head = head;
    this.waiting = [];
    this.gap = false;
  }

  /** True when `seq` is the next edit. Otherwise it is old, or there is a gap to fill first. */
  private take(seq: number): boolean {
    if (seq <= this.head) return false;
    if (seq > this.head + 1) {
      if (!this.gap) {
        this.gap = true;
        this.hooks.replay(this.head);
      }
      return false;
    }
    this.head = seq;
    this.gap = false;
    return true;
  }

  private drop(cid: number): boolean {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.cid !== cid);
    return this.waiting.length !== before;
  }
}
