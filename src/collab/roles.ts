/**
 * What a member may do in a room (`docs/design/ROOMS.md` C2). Who may only look is the host's
 * word: it is in the list of members the host signs, and an edit in the room's order says from
 * which place on (`ROOMS-PROTOCOL.md` §18.7). The room server refuses a viewer's edits too, and
 * a viewer's own tools are switched off so nothing is painted that would never count.
 */

import type { Role } from './protocol';

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
