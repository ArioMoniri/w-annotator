import { describe, expect, it } from 'vitest';
import { cleanLabels } from './rooms';
import { MEMBERSHIP_DAYS, parseRooms, pruneRooms, upsertRoom, withoutRoom, type SavedRoom } from './rooms';

const DAY = 86_400_000;
const room = (id: string, at: number): SavedRoom => ({ id, server: 'ws://relay.example', role: 'editor', seed: 'c2VlZA', key: 'a2V5', host: 'Mina', at });

describe('my rooms', () => {
  it('adds a room and keeps the newest first', () => {
    const list = upsertRoom(upsertRoom([], room('AAAAAAAA', 1)), room('BBBBBBBB', 2));
    expect(list.map((r) => r.id)).toEqual(['BBBBBBBB', 'AAAAAAAA']);
  });

  it('replaces the entry of a room that is joined again', () => {
    const list = upsertRoom([room('AAAAAAAA', 1), room('BBBBBBBB', 2)], { ...room('AAAAAAAA', 9), host: 'Ben' });
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ id: 'AAAAAAAA', host: 'Ben', at: 9 });
  });

  it('forgets a room', () => {
    expect(withoutRoom([room('AAAAAAAA', 1), room('BBBBBBBB', 2)], 'AAAAAAAA').map((r) => r.id)).toEqual(['BBBBBBBB']);
  });

  it('drops rooms not used for 30 days: the membership has lapsed by then', () => {
    expect(MEMBERSHIP_DAYS).toBe(30);
    const now = 100 * DAY;
    const list = pruneRooms([room('AAAAAAAA', now - 29 * DAY), room('BBBBBBBB', now - 31 * DAY)], now);
    expect(list.map((r) => r.id)).toEqual(['AAAAAAAA']);
  });

  it('reads only well-formed entries from storage', () => {
    const good = room('AAAAAAAA', 5);
    expect(parseRooms(JSON.stringify([good, { id: 'x' }, null, { ...good, id: 'BBBBBBBB', role: 'king' }]))).toEqual([good]);
    expect(parseRooms('not json')).toEqual([]);
    expect(parseRooms(null)).toEqual([]);
    expect(parseRooms('{}')).toEqual([]);
  });

  it('keeps that a room is hosted on the host’s computer, and the host’s notes for links', () => {
    const base = { id: 'K7Q2M9XA4TDP', server: 'ws://127.0.0.1:8787', role: 'host', seed: 's', key: 'k', host: null, at: 5 };
    const [plain] = parseRooms(JSON.stringify([base]));
    expect(plain).toEqual(base);
    const image = '0123456789abcdef0123456789abcdef';
    const [kept] = parseRooms(JSON.stringify([{ ...base, hosted: true, image, labels: { abc: 'for Sam', bad: 7, long: 'x'.repeat(40) } }]));
    expect(kept.hosted).toBe(true);
    expect(kept.labels).toEqual({ abc: 'for Sam' });
    expect(kept.image).toBe(image);
    // Anything else in those places is dropped, not passed on.
    const [odd] = parseRooms(JSON.stringify([{ ...base, hosted: 'yes', labels: ['x'], image: '../etc' }]));
    expect(odd).toEqual(base);
  });

  it('holds no more notes than a room has links', () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`id${i}`, `note ${i}`]));
    const kept = cleanLabels(many);
    expect(Object.keys(kept)).toHaveLength(64);
    expect(kept.id79).toBe('note 79');
    expect(kept.id0).toBeUndefined();
  });
});
