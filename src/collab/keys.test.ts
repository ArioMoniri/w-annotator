import { describe, expect, it } from 'vitest';
import { inviteKeys, memberId, publicKey } from './identity';
import { RoomKeys, joinMac, openInvite, pairKey, rosterInput, wrapInvite, xPublic, type SignedRoster } from './keys';
import { FrameKind, b64decode, b64encode, type FrameHeader, type Meta } from './protocol';

const ROOM = 'K7Q2M9XA4TDP';
const seed = (n: number) => new Uint8Array(32).fill(n);
const idOf = (s: Uint8Array) => memberId(publicKey(s));
const text = (s: string) => new TextEncoder().encode(s);
const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i);

const header = (kind: number, from: number, to: number, epoch: number, seq = 0): FrameHeader => ({ version: 3, kind, flags: 0, from, to, seq, epoch });

/** What the relay does with a sealed frame: stamps the sender and passes it on. */
function carry(from: RoomKeys, kind: number, to: number, plain: Uint8Array) {
  const sealed = from.seal(kind, to, plain)!;
  return { header: header(kind, from.self, to, sealed.epoch), payload: sealed.payload, digest: sealed.digest };
}

/** A host and guests who came in through the host's invite, as the app does it. */
function room(guests: number[]): { host: RoomKeys; members: RoomKeys[] } {
  const host = RoomKeys.host(ROOM, seed(1));
  const invite = inviteKeys(SECRET);
  host.addInvite(invite.id, invite.bindKey);
  const wrapped = wrapInvite(invite.wrapKey, { k: host.k, x: host.x, kind: 'shared' });
  const members = guests.map((n) => {
    const content = openInvite(invite.wrapKey, wrapped)!;
    const guest = RoomKeys.guest(ROOM, seed(n), content);
    const join = carry(guest, FrameKind.Key, host.hostId, text(JSON.stringify(guest.joinMeta(SECRET))));
    // The host has only the relay's word for the newcomer's keys until the join opens and its proof holds.
    const opened = host.open(join.header, join.payload, () => guest.x);
    const meta = JSON.parse(new TextDecoder().decode(opened.plain!)) as Meta;
    expect(host.admit(guest.self, meta, { key: guest.k, xkey: guest.x })).toBe(true);
    return guest;
  });
  for (const m of members) expect(m.take(host.self, host.keysFor(m.self)!)).toBe('new');
  return { host, members };
}

describe('key agreement', () => {
  it('gives each pair of members one key that nobody else can make', () => {
    const ab = pairKey(seed(2), xPublic(seed(3)), ROOM)!;
    expect(ab).toEqual(pairKey(seed(3), xPublic(seed(2)), ROOM));
    expect(ab).not.toEqual(pairKey(seed(4), xPublic(seed(3)), ROOM));
    expect(ab).not.toEqual(pairKey(seed(2), xPublic(seed(3)), 'OTHERROOM123'));
    expect(xPublic(seed(2))).not.toEqual(publicKey(seed(2)));
    // A key that is no point on the curve, or the point that makes every shared secret zero.
    expect(pairKey(seed(2), new Uint8Array(32), ROOM)).toBeNull();
    expect(pairKey(seed(2), new Uint8Array(5), ROOM)).toBeNull();
  });

  it('holds to the documented vectors (ROOMS-PROTOCOL.md §20)', () => {
    expect(b64encode(xPublic(seed(9)))).toBe('w_ZXEnbUpQFQdwJ6rvcTyOcXZQHYuvw-UVcyt-rqZEI');
    expect(b64encode(pairKey(seed(9), xPublic(seed(1)), ROOM)!)).toBe('yziOmQjPlxNTr5sJx4ykJXqzLYccJprYylI4M0znPVM');
    const invite = inviteKeys(SECRET);
    expect(b64encode(invite.bindKey)).toBe('GpscGgrpFBwc4cEw9l2K2ST8am0_YLrxVig_txsD2aI');
    const k = b64encode(publicKey(seed(9)));
    const hostK = b64encode(publicKey(seed(1)));
    expect(joinMac(invite.bindKey, ROOM, k, b64encode(xPublic(seed(9))), hostK)).toBe('kufRLQLU_4xf4V5xy3ozeANpFMYEWMBH_quFOBOza9g');
    const roster: SignedRoster = { e: 2, n: 3, m: [{ k: hostK, x: b64encode(xPublic(seed(1))), since: 1 }, { k, x: b64encode(xPublic(seed(9))), since: 1, until: 1 }], sig: '' };
    expect(rosterInput(ROOM, roster)).toBe(
      `w-rooms/3 roster K7Q2M9XA4TDP 2 3 ${hostK},${roster.m[0].x},1,0 ${k},${roster.m[1].x},1,1`,
    );
  });
});

describe('the invite', () => {
  it('tells the newcomer who the host is, and nothing to whoever lacks the link', () => {
    const invite = inviteKeys(SECRET);
    const wrapped = wrapInvite(invite.wrapKey, { k: 'a'.repeat(43), x: 'b'.repeat(43), kind: 'host-view' });
    expect(wrapped.length).toBeLessThanOrEqual(512);
    expect(openInvite(invite.wrapKey, wrapped)).toEqual({ k: 'a'.repeat(43), x: 'b'.repeat(43), kind: 'host-view' });
    expect(openInvite(inviteKeys(new Uint8Array(16)).wrapKey, wrapped)).toBeNull();
    expect(openInvite(invite.wrapKey, 'AAAA')).toBeNull();
  });

  it('lets the host admit only someone who holds the link, under the keys they really have', () => {
    const host = RoomKeys.host(ROOM, seed(1));
    const invite = inviteKeys(SECRET);
    host.addInvite(invite.id, invite.bindKey);
    const guest = RoomKeys.guest(ROOM, seed(2), { k: host.k, x: host.x });
    const meta = guest.joinMeta(SECRET);
    // The room server puts its own key agreement key in place of the guest's.
    const relayX = b64encode(xPublic(seed(7)));
    expect(host.admit(guest.self, { ...meta, x: relayX }, { key: guest.k, xkey: relayX })).toBe(false);
    // Someone without the link.
    expect(host.admit(guest.self, guest.joinMeta(new Uint8Array(16)), { key: guest.k, xkey: guest.x })).toBe(false);
    // Another member's id on it.
    expect(host.admit(12345, meta, { key: guest.k, xkey: guest.x })).toBe(false);
    expect(host.current(guest.self)).toBe(false);
    expect(host.admit(guest.self, meta, { key: guest.k, xkey: guest.x })).toBe(true);
    expect(host.current(guest.self)).toBe(true);
    // Asking twice changes nothing.
    const n = host.roster!.n;
    expect(host.admit(guest.self, meta, { key: guest.k, xkey: guest.x })).toBe(true);
    expect(host.roster!.n).toBe(n);
    // Only the host admits.
    expect(guest.admit(guest.self, meta, { key: guest.k, xkey: guest.x })).toBe(false);
  });
});

describe('frames for everyone', () => {
  it('open for every member and name their sender for certain', () => {
    const { host, members: [a, b] } = room([2, 3]);
    const f = carry(a, FrameKind.Patch, 0, text('edit'));
    for (const m of [host, b]) {
      const got = m.open(f.header, f.payload);
      expect(new TextDecoder().decode(got.plain!)).toBe('edit');
      expect(got.digest).toEqual(f.digest);
    }
    // The room server stamps it as the host's: it no longer opens, for anyone.
    expect(b.open({ ...f.header, from: host.self }, f.payload).plain).toBeNull();
    // A member who holds the room key makes a frame and names another member as its sender.
    const forged = carry(b, FrameKind.Patch, 0, text('not mine'));
    const got = host.open({ ...forged.header, from: a.self }, forged.payload);
    expect(got.plain).toBeNull();
    expect(got.need).toBe(false);
    // Another kind, another epoch, a changed byte, a changed signature.
    expect(b.open({ ...f.header, kind: FrameKind.SegOp }, f.payload).plain).toBeNull();
    expect(b.open({ ...f.header, epoch: 2 }, f.payload).plain).toBeNull();
    const changed = f.payload.slice();
    changed[20] ^= 1;
    expect(b.open(f.header, changed).plain).toBeNull();
    const resigned = f.payload.slice();
    resigned[resigned.length - 1] ^= 1;
    expect(b.open(f.header, resigned).plain).toBeNull();
    // Each of those still has a digest, and not the same one: the order of edits counts them all.
    expect(b.open(f.header, resigned).digest).not.toEqual(f.digest);
    expect(b.open(f.header, new Uint8Array(10)).digest).toHaveLength(32);
  });

  it('wait for keys this device does not have yet, instead of being thrown away', () => {
    const { host, members: [a] } = room([2]);
    // Someone the host let in after this device last heard from it.
    const invite = inviteKeys(SECRET);
    const late = RoomKeys.guest(ROOM, seed(4), { k: host.k, x: host.x });
    expect(host.admit(late.self, late.joinMeta(SECRET), { key: late.k, xkey: late.x })).toBe(true);
    expect(invite.id).toBeTruthy();
    late.take(host.self, host.keysFor(late.self)!);
    const f = carry(late, FrameKind.Patch, 0, text('hello'));
    expect(a.open(f.header, f.payload)).toMatchObject({ plain: null, need: true });
    expect(a.take(host.self, host.keysFor(a.self)!)).toBe('new');
    expect(a.open(f.header, f.payload).plain).not.toBeNull();
    // A sender the host does not know either is nobody: the frame is counted and left out.
    const stranger = header(FrameKind.Patch, 999, 0, 1);
    expect(a.open(stranger, f.payload).need).toBe(true);
    a.confirmUnknown();
    expect(a.open(stranger, f.payload)).toMatchObject({ plain: null, need: false });
    expect(host.open(stranger, f.payload)).toMatchObject({ plain: null, need: false });
    // A frame from a later epoch than this device holds a key for.
    expect(a.open({ ...f.header, epoch: 5 }, f.payload)).toMatchObject({ plain: null, need: true });
  });
});

describe('frames for one member', () => {
  it('open for that member only, and only as sent', () => {
    const { host, members: [a, b] } = room([2, 3]);
    const f = carry(host, FrameKind.ImageSlab, a.self, text('slab'));
    expect(new TextDecoder().decode(a.open(f.header, f.payload).plain!)).toBe('slab');
    // The other guest holds the room key and sees the traffic. It is not for them and does not open.
    expect(b.open(f.header, f.payload).plain).toBeNull();
    expect(b.open({ ...f.header, to: b.self }, f.payload).plain).toBeNull();
    // Passed off as coming from someone else, or as another kind.
    expect(a.open({ ...f.header, from: b.self }, f.payload).plain).toBeNull();
    expect(a.open({ ...f.header, kind: FrameKind.SyncSlab }, f.payload).plain).toBeNull();
    // Members talk to each other the same way.
    const g = carry(a, FrameKind.SyncRequest, b.self, text('ask'));
    expect(b.open(g.header, g.payload).plain).not.toBeNull();
    expect(host.open({ ...g.header, to: host.self }, g.payload).plain).toBeNull();
  });
});

describe('a new key when someone is removed', () => {
  it('reaches the people who stay, and never the one who left', () => {
    const { host, members: [a, b] } = room([2, 3]);
    const before = carry(b, FrameKind.Patch, 0, text('while a member'));
    host.rotate([b.self]);
    expect(host.epoch).toBe(2);
    expect(host.keysFor(b.self)).toBeNull();
    expect(a.take(host.self, host.keysFor(a.self)!)).toBe('new');
    expect(a.epoch).toBe(2);
    const f = carry(host, FrameKind.Patch, 0, text('after'));
    expect(f.header.epoch).toBe(2);
    expect(a.open(f.header, f.payload).plain).not.toBeNull();
    // The removed member still has the old key, and it opens nothing new.
    expect(b.open(f.header, f.payload).plain).toBeNull();
    expect(b.epoch).toBe(1);
    // Nor can they talk to anyone, one to one or under the old key as if it were new.
    const direct = carry(b, FrameKind.SyncRequest, a.self, text('give me the image'));
    expect(a.open(direct.header, direct.payload).plain).toBeNull();
    const late = carry(b, FrameKind.Patch, 0, text('late'));
    expect(a.open({ ...late.header, epoch: 2 }, late.payload).plain).toBeNull();
    // What they sent while a member still opens, for someone catching up on the room's edits.
    expect(a.open(before.header, before.payload).plain).not.toBeNull();
    // The roster the removed member holds cannot be passed off as the newest.
    expect(a.take(host.self, { t: 'keys', r: b.roster, k: {} })).toBeNull();
    expect(a.current(b.self)).toBe(false);
  });

  it('reaches someone who was away, from the host or from any member who stayed', () => {
    const { host, members: [a, b, c] } = room([2, 3, 4]);
    host.rotate([c.self]);
    a.take(host.self, host.keysFor(a.self)!);
    // B was offline. The host has left too; A hands the keys on.
    const f = carry(a, FrameKind.Patch, 0, text('new epoch'));
    expect(b.open(f.header, f.payload)).toMatchObject({ plain: null, need: true });
    expect(b.take(a.self, a.keysFor(b.self)!)).toBe('new');
    expect(b.open(f.header, f.payload).plain).not.toBeNull();
    expect(b.take(a.self, a.keysFor(b.self)!)).toBe('same');
    // A does not hand them to the member who was removed, whatever the room server says about who is in the room.
    expect(a.keysFor(c.self)).toBeNull();
    // A roster the host did not sign is not taken, nor one that leaves this device out.
    const fake = RoomKeys.host(ROOM, seed(8));
    expect(b.take(a.self, { t: 'keys', r: fake.roster, k: { 3: b64encode(seed(5)) } })).toBeNull();
    const without: SignedRoster = { ...host.roster!, m: host.roster!.m.filter((m) => m.k !== b.k) };
    expect(b.take(host.self, { t: 'keys', r: without, k: {} })).toBeNull();
    // A key this device already holds is never replaced.
    expect(b.take(a.self, { ...a.keysFor(b.self)!, k: { 2: b64encode(seed(5)) } })).toBe('same');
    expect(b.open(f.header, f.payload).plain).not.toBeNull();
  });
});

describe('keeping keys', () => {
  it('comes back from what was stored as it was', () => {
    const { host, members: [a] } = room([2]);
    host.rotate([]);
    a.take(host.self, host.keysFor(a.self)!);
    const again = RoomKeys.load(ROOM, seed(2), a.dump())!;
    expect(again.epoch).toBe(2);
    expect(again.roster).toEqual(a.roster);
    const f = carry(host, FrameKind.Patch, 0, text('x'));
    expect(again.open(f.header, f.payload).plain).not.toBeNull();
    const hostAgain = RoomKeys.load(ROOM, seed(1), host.dump())!;
    expect(hostAgain.isHost).toBe(true);
    const late = RoomKeys.guest(ROOM, seed(5), { k: host.k, x: host.x });
    expect(hostAgain.admit(late.self, late.joinMeta(SECRET), { key: late.k, xkey: late.x })).toBe(true);
    // Not keys: an old room's bare key, someone else's seed, nonsense.
    expect(RoomKeys.load(ROOM, seed(2), b64encode(seed(3)))).toBeNull();
    expect(RoomKeys.load(ROOM, seed(3), a.dump())).toBeNull();
    expect(RoomKeys.load(ROOM, seed(2), '{"v":1}')).toBeNull();
    expect(b64decode(a.k)).toHaveLength(32);
  });
});
