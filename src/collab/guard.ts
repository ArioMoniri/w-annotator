/**
 * Takes each edit once (`docs/reviews/rooms-security.md`, finding 3).
 *
 * The room server gives edits their order, so it could also send an old edit again as if
 * it were new. Every edit therefore names, inside its encrypted part, who made it, a tag
 * for that person's visit to the room, and a number that only goes up during the visit.
 * An edit whose number is not above the last one seen for that person and visit is a
 * repeat and is left out, by everyone alike, so masks still agree.
 *
 * Someone joining has seen nothing yet, so whoever sends them the mask sends this list too.
 */

/** Visits remembered for one person, and people remembered for one room. A room holds 16 members. */
const MAX_TAGS = 16;
const MAX_SENDERS = 64;
const MAX_TAG_CHARS = 24;

export type GuardEntry = [from: number, tag: string, last: number];

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const isTag = (t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= MAX_TAG_CHARS;

export class ReplayGuard {
  private readonly seen = new Map<number, Map<string, number>>();

  /** True the first time an edit is seen, and only when it is newer than every edit seen from that visit. */
  fresh(from: number, tag: unknown, n: unknown): boolean {
    if (!isTag(tag) || !isCount(n)) return false;
    const last = this.seen.get(from)?.get(tag) ?? 0;
    if (n <= last) return false;
    this.note(from, tag, n);
    return true;
  }

  private note(from: number, tag: string, n: number): void {
    let tags = this.seen.get(from);
    if (!tags) {
      if (this.seen.size >= MAX_SENDERS) this.seen.delete(this.seen.keys().next().value as number);
      this.seen.set(from, (tags = new Map()));
    }
    // Put last, so the visit forgotten when there are too many is the one unused longest.
    tags.delete(tag);
    tags.set(tag, n);
    if (tags.size > MAX_TAGS) tags.delete(tags.keys().next().value as string);
  }

  /** What to hand to someone joining. */
  dump(): GuardEntry[] {
    const out: GuardEntry[] = [];
    for (const [from, tags] of this.seen) for (const [tag, last] of tags) out.push([from, tag, last]);
    return out;
  }

  /** Takes over a list from another member. Anything that is not such a list is ignored. */
  load(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const entry of list.slice(0, MAX_SENDERS * MAX_TAGS)) {
      if (!Array.isArray(entry) || entry.length !== 3) continue;
      const [from, tag, last] = entry as unknown[];
      if (typeof from !== 'number' || !Number.isInteger(from) || from <= 0 || !isTag(tag) || !isCount(last)) continue;
      if (last > (this.seen.get(from)?.get(tag) ?? 0)) this.note(from, tag, last);
    }
  }
}
