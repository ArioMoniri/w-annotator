/**
 * What a member may do in a room (`docs/design/ROOMS.md` C2). The room server is what
 * holds a viewer to looking: it refuses their edit frames (`ROOMS-PROTOCOL.md` §5.2).
 * Every app checks again on its own, and a viewer's own tools are switched off so
 * nothing is painted that would never arrive.
 */

import type { Member, Role } from './protocol';

export const canEdit = (role: Role): boolean => role !== 'viewer';

/** What the host can make of a member. The host's own role never changes. */
export const ROLE_CHOICES: { role: 'editor' | 'viewer'; label: string }[] = [
  { role: 'editor', label: 'Can edit' },
  { role: 'viewer', label: 'Can view' },
];

/** Why a viewer's edit tools are off. */
export const VIEW_ONLY = 'You can view this room but not edit it. The host can change that.';

/** What a member is told when the host changes what they may do. */
export function roleChangeText(host: string | null, role: Role): string {
  const who = host ?? 'The host';
  return role === 'viewer' ? `${who} changed you to view only.` : `${who} changed you back to editing.`;
}

/**
 * False for an edit from a member the room knows as a viewer. The room server refuses
 * those itself; this is for a server that does not. Call it only for edits as they are
 * made: one that is replayed was accepted when it was made, whatever its author is now.
 */
export function acceptsEditFrom(roster: Member[], from: number): boolean {
  return roster.find((m) => m.id === from)?.role !== 'viewer';
}

/**
 * What this app can do that an older one in the same room cannot, said in `hi`
 * (`ROOMS-PROTOCOL.md` §18.3). `roles`: it follows a change of its role at once, switches
 * its tools off and says so. An app that does not say this would go on painting what
 * nobody receives, so a host is not offered the change for it.
 */
export const CAPS = ['roles'];

export function cleanCaps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const v of value.slice(0, 16)) if (typeof v === 'string' && v.length > 0 && v.length <= 24) out.add(v);
  return [...out];
}

export const supportsRoles = (caps: string[] | undefined): boolean => !!caps?.includes('roles');

export function needsUpdateText(name: string): string {
  return `${name} needs a newer W Annotator before this can be changed.`;
}
