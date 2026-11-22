import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVITE,
  DURATIONS,
  USES,
  cleanLabel,
  inviteLine,
  inviteRequest,
  inviteUsable,
  linkRule,
  parseInviteList,
  timeLeft,
  usesLeft,
} from './invites';
import type { InviteInfo } from './protocol';

const HOUR = 3_600_000;
const invite = (over: Partial<InviteInfo> = {}): InviteInfo => ({ id: 'a', role: 'editor', expiresAt: 10 * HOUR, maxUses: 1, uses: 0, revoked: false, ...over });

describe('invite options', () => {
  it('defaults to one person and 24 hours', () => {
    expect(DEFAULT_INVITE).toEqual({ duration: 'day', uses: 'one', label: '' });
    expect(inviteRequest(DEFAULT_INVITE, 'shared')).toEqual({ ttl: 86_400, maxUses: 1 });
  });

  it('offers 1 hour, 24 hours and 7 days', () => {
    expect(DURATIONS.map((d) => [d.label, d.ttl])).toEqual([
      ['1 hour', 3600],
      ['24 hours', 86_400],
      ['7 days', 604_800],
    ]);
  });

  it('offers one person, up to 5 people, or no limit, each with one line that says what it means', () => {
    expect(USES.map((u) => [u.label, u.maxUses])).toEqual([
      ['One person', 1],
      ['Up to 5 people', 5],
      ['No limit', 0],
    ]);
    for (const u of USES) {
      expect(u.help).toMatch(/\.$/);
      expect(u.help).not.toMatch(/!/);
      expect(u.help.length).toBeLessThan(90);
    }
  });

  it('asks the relay for what was chosen', () => {
    expect(inviteRequest({ duration: 'hour', uses: 'five', label: '' }, 'shared')).toEqual({ ttl: 3600, maxUses: 5 });
    expect(inviteRequest({ duration: 'week', uses: 'any', label: '' }, 'shared')).toEqual({ ttl: 604_800, maxUses: 0 });
  });

  it('keeps a link of a view-through-host room to one person, whatever was chosen', () => {
    expect(inviteRequest({ duration: 'week', uses: 'any', label: '' }, 'host-view')).toEqual({ ttl: 604_800, maxUses: 1 });
    expect(linkRule({ duration: 'week', uses: 'any', label: '' }, 'host-view')).toBe('Each link works for one person and stops working after 7 days.');
  });

  it('says in one line what a link does', () => {
    expect(linkRule(DEFAULT_INVITE, 'shared')).toBe('Each link works for one person and stops working after 24 hours.');
    expect(linkRule({ duration: 'hour', uses: 'five', label: '' }, 'shared')).toBe('This link works for up to 5 people and stops working after 1 hour.');
    expect(linkRule({ duration: 'week', uses: 'any', label: '' }, 'shared')).toBe('This link works for anyone who has it and stops working after 7 days.');
  });

  it('cleans a label like any text shown later', () => {
    expect(cleanLabel('  for Sam  ')).toBe('for Sam');
    expect(cleanLabel('a'.repeat(40))).toHaveLength(24);
    expect(cleanLabel('for‮Sam\n')).toBe('forSam');
    expect(cleanLabel(7)).toBe('');
  });
});

describe('the host’s list of links', () => {
  it('counts the uses that are left', () => {
    expect(usesLeft(invite())).toBe('1 use left');
    expect(usesLeft(invite({ maxUses: 5, uses: 2 }))).toBe('3 of 5 uses left');
    expect(usesLeft(invite({ maxUses: 5, uses: 4 }))).toBe('1 of 5 uses left');
    expect(usesLeft(invite({ maxUses: 0, uses: 9 }))).toBe('no limit, 9 joined');
    expect(usesLeft(invite({ maxUses: 0 }))).toBe('no limit');
  });

  it('says how long a link still works', () => {
    expect(timeLeft(24 * HOUR)).toBe('24 h left');
    expect(timeLeft(23.4 * HOUR)).toBe('23 h left');
    expect(timeLeft(7 * 24 * HOUR)).toBe('7 days left');
    expect(timeLeft(47 * HOUR)).toBe('47 h left');
    expect(timeLeft(49 * HOUR)).toBe('2 days left');
    expect(timeLeft(40 * 60_000)).toBe('40 min left');
    expect(timeLeft(20_000)).toBe('1 min left');
    expect(timeLeft(0)).toBe('expired');
  });

  it('shows only links that can still let someone in', () => {
    const now = HOUR;
    expect(inviteUsable(invite(), now)).toBe(true);
    expect(inviteUsable(invite({ uses: 1 }), now)).toBe(false);
    expect(inviteUsable(invite({ revoked: true }), now)).toBe(false);
    expect(inviteUsable(invite({ expiresAt: now }), now)).toBe(false);
    // No limit means no limit: it is usable however many joined.
    expect(inviteUsable(invite({ maxUses: 0, uses: 40 }), now)).toBe(true);
    expect(inviteUsable(invite({ maxUses: 5, uses: 5 }), now)).toBe(false);
  });

  it('puts the label, the uses and the time on one line', () => {
    expect(inviteLine(invite({ expiresAt: 25 * HOUR }), 'for Sam', 1, HOUR)).toBe('for Sam · 1 use left · 24 h left');
    expect(inviteLine(invite({ expiresAt: 2 * HOUR, maxUses: 5, uses: 1 }), '', 2, HOUR)).toBe('Link 2 · 4 of 5 uses left · 60 min left');
  });

  it('takes only what is an invite from the relay’s list', () => {
    const good = invite({ id: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(parseInviteList([good, null, { id: 5 }, { ...good, id: 'x', uses: -1 }, { ...good, id: 'y', role: 'host' }, 'x'])).toEqual([good]);
    expect(parseInviteList('nope')).toEqual([]);
  });
});
