import { describe, expect, it } from 'vitest';
import { OpLog } from './oplog';

/** An edit in these tests: write `value` at `index`. */
interface Write {
  index: number;
  value: number;
}

/** One person: what they see (`live`), what the room has confirmed (`synced`), and their log. */
function person(size = 16) {
  const live = new Uint8Array(size);
  const synced = new Uint8Array(size);
  const replays: number[] = [];
  const log = new OpLog<Write>({
    confirm: (op) => {
      synced[op.index] = op.value;
      live[op.index] = op.value;
    },
    reapply: (op) => {
      live[op.index] = op.value;
    },
    replay: (after) => replays.push(after),
  });
  const edit = (index: number, value: number) => {
    live[index] = value;
    return log.local({ index, value });
  };
  return { live, synced, log, replays, edit };
}

describe('OpLog', () => {
  it('applies frames in order and moves the head', () => {
    const a = person();
    a.log.remote(1, { index: 0, value: 5 });
    a.log.remote(2, { index: 1, value: 6 });
    expect(a.log.head).toBe(2);
    expect(Array.from(a.live.slice(0, 2))).toEqual([5, 6]);
  });

  it('ignores a frame it has already applied', () => {
    const a = person();
    a.log.remote(1, { index: 0, value: 5 });
    a.log.remote(1, { index: 0, value: 9 });
    expect(a.live[0]).toBe(5);
    expect(a.log.head).toBe(1);
  });

  it('asks for a replay on a gap, once, and applies nothing until it is filled', () => {
    const a = person();
    a.log.remote(1, { index: 0, value: 1 });
    a.log.remote(3, { index: 2, value: 3 });
    a.log.remote(4, { index: 3, value: 4 });
    expect(a.replays).toEqual([1]);
    expect(a.log.head).toBe(1);
    expect(a.live[2]).toBe(0);
    a.log.remote(2, { index: 1, value: 2 });
    a.log.remote(3, { index: 2, value: 3 });
    expect(a.log.head).toBe(3);
    expect(a.live[2]).toBe(3);
  });

  it('keeps my unconfirmed edit on top of an earlier edit by someone else', () => {
    const a = person();
    const cid = a.edit(4, 7);
    // Someone else wrote the same voxel first; the relay put theirs before mine.
    a.log.remote(1, { index: 4, value: 2 });
    expect(a.live[4]).toBe(7);
    expect(a.synced[4]).toBe(2);
    a.log.ack(cid, 2);
    expect(a.synced[4]).toBe(7);
    expect(a.log.head).toBe(2);
    expect(a.log.pending).toBe(0);
  });

  it('settles my edit when it comes back in a replay or from the host', () => {
    const a = person();
    const cid = a.edit(4, 7);
    a.log.remote(1, { index: 4, value: 7 }, cid);
    expect(a.log.pending).toBe(0);
    expect(a.synced[4]).toBe(7);
    // The late ack changes nothing.
    a.log.ack(cid, 1);
    expect(a.log.head).toBe(1);
  });

  it('an ack past a gap waits for the replay', () => {
    const a = person();
    const cid = a.edit(1, 1);
    a.log.ack(cid, 2);
    expect(a.replays).toEqual([0]);
    expect(a.log.pending).toBe(1);
    a.log.remote(1, { index: 0, value: 9 });
    a.log.remote(2, { index: 1, value: 1 }, cid);
    expect(a.log.pending).toBe(0);
    expect(a.log.head).toBe(2);
  });

  it('lists what is unconfirmed and can put it back on top', () => {
    const a = person();
    a.edit(1, 4);
    a.edit(2, 5);
    expect(a.log.unconfirmed()).toEqual([
      { index: 1, value: 4 },
      { index: 2, value: 5 },
    ]);
    a.live.fill(0);
    a.log.reapplyAll();
    expect(Array.from(a.live.slice(0, 3))).toEqual([0, 4, 5]);
  });

  it('reset drops what was pending and starts from the given head', () => {
    const a = person();
    a.edit(1, 1);
    a.log.reset(40);
    expect(a.log.pending).toBe(0);
    expect(a.log.head).toBe(40);
    a.log.remote(41, { index: 0, value: 3 });
    expect(a.live[0]).toBe(3);
  });

  it('three people writing over each other at random always end up identical', () => {
    let seed = 12345;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      const people = [person(8), person(8), person(8)];
      const truth = new Uint8Array(8);
      let seq = 0;
      // What the relay has sent to each person and they have not read yet.
      const inbox: (() => void)[][] = [[], [], []];
      // What each person has sent and the relay has not read yet.
      const outbox: { cid: number; op: Write }[][] = [[], [], []];
      const step = () => {
        const who = rand(3);
        const what = rand(3);
        if (what === 0) {
          const op = { index: rand(8), value: 1 + rand(5) };
          outbox[who].push({ cid: people[who].edit(op.index, op.value), op });
        } else if (what === 1 && outbox[who].length) {
          const { cid, op } = outbox[who].shift()!;
          const s = ++seq;
          truth[op.index] = op.value;
          people.forEach((p, i) => inbox[i].push(i === who ? () => p.log.ack(cid, s) : () => p.log.remote(s, op)));
        } else if (inbox[who].length) {
          inbox[who].shift()!();
        }
      };
      for (let i = 0; i < 300; i++) step();
      // Quiet down: the relay reads everything, then everyone reads everything.
      outbox.forEach((box, who) => {
        for (const { cid, op } of box) {
          const s = ++seq;
          truth[op.index] = op.value;
          people.forEach((p, i) => inbox[i].push(i === who ? () => p.log.ack(cid, s) : () => p.log.remote(s, op)));
        }
      });
      inbox.forEach((box) => box.forEach((run) => run()));
      for (const p of people) {
        expect(Array.from(p.live)).toEqual(Array.from(truth));
        expect(Array.from(p.synced)).toEqual(Array.from(truth));
        expect(p.log.head).toBe(seq);
        expect(p.replays).toEqual([]);
      }
    }
  });
});
