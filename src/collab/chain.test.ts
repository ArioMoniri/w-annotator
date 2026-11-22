import { describe, expect, it } from 'vitest';
import { OpChain } from './chain';

const ROOM = 'K7Q2M9XA4TDP';
const digest = (n: number) => new Uint8Array(32).fill(n);

/** A member who has applied edits 1 to `n`, each made by `from(seq)` with digest `d(seq)`. */
function member(n: number, d: (seq: number) => number = (s) => s, session = 'ses1'): OpChain {
  const c = new OpChain(ROOM);
  c.start(session);
  for (let seq = 1; seq <= n; seq++) c.push(seq, 7, digest(d(seq)));
  return c;
}

describe('an earlier place, without going back', () => {
  it('is what the chain was there, for as long as it is remembered', () => {
    const chain = new OpChain('K7Q2M9XA4TDP');
    chain.start('q83vEjRWeJA');
    const at0 = chain.claim();
    chain.push(1, 7, new Uint8Array(32).fill(1));
    const at1 = chain.claim();
    chain.push(2, 7, new Uint8Array(32).fill(2));
    expect(chain.claimAt(0)).toEqual(at0);
    expect(chain.claimAt(1)).toEqual(at1);
    expect(chain.claimAt(2)).toEqual(chain.claim());
    expect(chain.claimAt(3)).toBeNull();
    // Asking does not move it.
    expect(chain.head).toBe(2);
    chain.lose();
    expect(chain.claimAt(1)).toBeNull();
  });
});

describe('the chain over the room\'s edits', () => {
  it('is the same for two members who applied the same edits, and says so', () => {
    const a = member(5);
    const b = member(5);
    expect(a.claim()).toEqual(b.claim());
    expect(a.claim()![1]).toBe(5);
    expect(b.check(1, a.claim())).toBe('ok');
    // An earlier point of it too.
    expect(b.check(1, member(3).claim())).toBe('ok');
  });

  it('holds to the documented vector (ROOMS-PROTOCOL.md §20)', () => {
    const c = new OpChain(ROOM);
    c.start('q83vEjRWeJA');
    expect(c.claim()).toEqual(['q83vEjRWeJA', 0, '89a-tCtc62C2Wr6sl-dfvlHdDZxUqhygIkUUcGRa_ag']);
    c.push(1, 630768347, digest(1));
    expect(c.claim()).toEqual(['q83vEjRWeJA', 1, 'CTMiUtAjuzctj7wDel1S76GeYZ68oHIEV3xPLdvR2jw']);
  });

  it('differs when the room server gave one member another edit, a changed one, or another sender', () => {
    const a = member(5);
    expect(a.check(1, member(5, (s) => (s === 3 ? 99 : s)).claim())).toBe('fork');
    const other = new OpChain(ROOM);
    other.start('ses1');
    for (let seq = 1; seq <= 5; seq++) other.push(seq, seq === 2 ? 8 : 7, digest(seq));
    expect(a.check(1, other.claim())).toBe('fork');
    // Two edits swapped.
    expect(a.check(1, member(5, (s) => (s === 4 ? 5 : s === 5 ? 4 : s)).claim())).toBe('fork');
  });

  it('waits for an edit it has not reached, and finds the difference when it gets there', () => {
    const a = member(3);
    const ahead = member(6, (s) => (s === 5 ? 99 : s));
    expect(a.check(2, ahead.claim())).toBe('wait');
    expect(a.push(4, 7, digest(4))).toEqual([]);
    expect(a.push(5, 7, digest(5))).toEqual([]);
    // At edit 6 the two can be compared: the other member was given something else as edit 5.
    expect(a.push(6, 7, digest(6))).toEqual([2]);
    // Someone honest who was also ahead raises nothing.
    const b = member(3);
    expect(b.check(3, member(4).claim())).toBe('wait');
    expect(b.push(4, 7, digest(4))).toEqual([]);
  });

  it('only counts edits in their order, each once', () => {
    const a = member(3);
    const at3 = a.claim();
    a.push(3, 7, digest(50));
    a.push(5, 7, digest(5));
    expect(a.claim()).toEqual(at3);
  });

  it('goes back to an earlier edit when a catch-up starts again', () => {
    const a = member(10);
    expect(a.rewind(4)).toBe(true);
    expect(a.claim()).toEqual(member(4).claim());
    for (let seq = 5; seq <= 10; seq++) a.push(seq, 7, digest(seq));
    expect(a.claim()).toEqual(member(10).claim());
    // Further back than it remembers: it says nothing until it is given a place to start from.
    expect(a.rewind(0)).toBe(true);
    const short = new OpChain(ROOM, 4);
    short.start('ses1');
    for (let seq = 1; seq <= 10; seq++) short.push(seq, 7, digest(seq));
    expect(short.rewind(2)).toBe(false);
    expect(short.claim()).toBeNull();
    expect(short.check(1, member(10).claim())).toBe('skip');
    expect(short.push(3, 7, digest(3))).toEqual([]);
  });

  it('starts from what the member who sent the mask says, and is checked against the others from there', () => {
    const giver = member(8);
    const joiner = new OpChain(ROOM);
    expect(joiner.claim()).toBeNull();
    expect(joiner.adopt(giver.claim())).toBe(true);
    joiner.push(9, 7, digest(9));
    giver.push(9, 7, digest(9));
    expect(joiner.check(1, giver.claim())).toBe('ok');
    // A point before the one it started from cannot be compared.
    expect(joiner.check(1, member(5).claim())).toBe('skip');
    // The giver was itself shown something else than the rest of the room.
    const forked = new OpChain(ROOM);
    forked.adopt(member(8, (s) => (s === 2 ? 99 : s)).claim());
    expect(forked.check(1, member(8).claim())).toBe('fork');
    expect(joiner.adopt(['ses1', -1, 'x'])).toBe(false);
    expect(joiner.adopt('nonsense')).toBe(false);
  });

  it('does not compare across a room that was opened again, or take nonsense for a claim', () => {
    const a = member(5);
    // After a restart of the room server the numbering starts again.
    expect(a.check(1, member(5, (s) => s, 'ses2').claim())).toBe('skip');
    expect(member(0).claim()).not.toEqual(member(0, (s) => s, 'ses2').claim());
    for (const bad of [null, 5, [], ['ses1', 5], ['ses1', '5', 'x'], ['ses1', 5, 7], ['ses1', 5.5, 'x']]) expect(a.check(1, bad)).toBe('skip');
    a.start('ses2');
    expect(a.claim()![1]).toBe(0);
    expect(a.check(1, member(5).claim())).toBe('skip');
  });
});
