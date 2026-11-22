/**
 * What a host can choose for an invite link, and how the list of links reads
 * (`docs/design/ROOMS.md` C4). The relay counts the uses and keeps the time
 * (`ROOMS-PROTOCOL.md` §9.2, §9.3); nothing here enforces anything. A label is the
 * host's own note and never leaves this device.
 */

import { cleanText, type InviteInfo, type RoomKind } from './protocol';

export type InviteDuration = 'hour' | 'day' | 'week';
export type InviteUses = 'one' | 'five' | 'any';

export interface InviteOptions {
  duration: InviteDuration;
  uses: InviteUses;
  /** For the host's own list, for example "for Sam". Empty for none. */
  label: string;
}

export const DEFAULT_INVITE: InviteOptions = { duration: 'day', uses: 'one', label: '' };

export const DURATIONS: { id: InviteDuration; label: string; ttl: number }[] = [
  { id: 'hour', label: '1 hour', ttl: 3600 },
  { id: 'day', label: '24 hours', ttl: 86_400 },
  { id: 'week', label: '7 days', ttl: 604_800 },
];

/** `maxUses` 0 is the relay's word for any number until the link expires. */
export const USES: { id: InviteUses; label: string; help: string; maxUses: number }[] = [
  { id: 'one', label: 'One person', help: 'The link stops working once one person has joined.', maxUses: 1 },
  { id: 'five', label: 'Up to 5 people', help: 'The link stops working once five people have joined.', maxUses: 5 },
  { id: 'any', label: 'No limit', help: 'Anyone who has the link can join until it expires.', maxUses: 0 },
];

export const LABEL_CHARS = 24;

/** A label as typed, made safe to show. Never sent anywhere. */
export function cleanLabel(value: unknown): string {
  return typeof value === 'string' ? cleanText(value, LABEL_CHARS) : '';
}

const durationOf = (o: InviteOptions) => DURATIONS.find((d) => d.id === o.duration) ?? DURATIONS[1];
/** A view-through-host room hands out links for one person only; the relay refuses any other. */
const usesOf = (o: InviteOptions, kind: RoomKind) => (kind === 'host-view' ? USES[0] : (USES.find((u) => u.id === o.uses) ?? USES[0]));

/** The two numbers the relay is asked for. */
export function inviteRequest(o: InviteOptions, kind: RoomKind): { ttl: number; maxUses: number } {
  return { ttl: durationOf(o).ttl, maxUses: usesOf(o, kind).maxUses };
}

/** What a link made with these choices does, said wherever one is handed out. */
export function linkRule(o: InviteOptions, kind: RoomKind): string {
  const after = `stops working after ${durationOf(o).label}.`;
  const uses = usesOf(o, kind).id;
  if (uses === 'five') return `This link works for up to 5 people and ${after}`;
  if (uses === 'any') return `This link works for anyone who has it and ${after}`;
  return `Each link works for one person and ${after}`;
}

/** True while the link can still let someone in. */
export function inviteUsable(i: InviteInfo, now: number): boolean {
  return !i.revoked && i.expiresAt > now && (i.maxUses === 0 || i.uses < i.maxUses);
}

export function usesLeft(i: InviteInfo): string {
  if (i.maxUses === 0) return i.uses > 0 ? `no limit, ${i.uses} joined` : 'no limit';
  const left = Math.max(0, i.maxUses - i.uses);
  return i.maxUses === 1 ? `${left} ${left === 1 ? 'use' : 'uses'} left` : `${left} of ${i.maxUses} uses left`;
}

/** How long a link still works, in a few words. */
export function timeLeft(ms: number): string {
  if (ms <= 0) return 'expired';
  const minutes = ms / 60_000;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min left`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h left`;
  return `${Math.round(hours / 24)} days left`;
}

/** One row of the host's list: its label, or its place in the list when it has none. */
export function inviteLine(i: InviteInfo, label: string, n: number, now: number): string {
  return `${label || `Link ${n}`} · ${usesLeft(i)} · ${timeLeft(i.expiresAt - now)}`;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The relay's list of invites, without anything that is not one. */
export function parseInviteList(value: unknown): InviteInfo[] {
  if (!Array.isArray(value)) return [];
  const out: InviteInfo[] = [];
  for (const raw of value.slice(0, 128) as (Partial<InviteInfo> | null)[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
    if (raw.role !== 'editor' && raw.role !== 'viewer') continue;
    if (!isCount(raw.expiresAt) || !isCount(raw.maxUses) || !isCount(raw.uses)) continue;
    out.push({ id: raw.id, role: raw.role, expiresAt: raw.expiresAt, maxUses: raw.maxUses, uses: raw.uses, revoked: raw.revoked === true });
  }
  return out;
}
