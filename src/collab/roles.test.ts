import { describe, expect, it } from 'vitest';
import type { Member } from './protocol';
import { CAPS, ROLE_CHOICES, VIEW_ONLY, acceptsEditFrom, canEdit, cleanCaps, needsUpdateText, roleChangeText, supportsRoles } from './roles';

const member = (id: number, role: Member['role']): Member => ({ id, key: 'k', xkey: null, role, online: true });

describe('roles in a room', () => {
  it('lets the host and editors edit, and viewers look', () => {
    expect(canEdit('host')).toBe(true);
    expect(canEdit('editor')).toBe(true);
    expect(canEdit('viewer')).toBe(false);
  });

  it('offers the host two choices for a member, in plain words', () => {
    expect(ROLE_CHOICES).toEqual([
      { role: 'editor', label: 'Can edit' },
      { role: 'viewer', label: 'Can view' },
    ]);
  });

  it('tells the member who changed what', () => {
    expect(roleChangeText('Mina', 'viewer')).toBe('Mina changed you to view only.');
    expect(roleChangeText('Mina', 'editor')).toBe('Mina changed you back to editing.');
    expect(roleChangeText(null, 'viewer')).toBe('The host changed you to view only.');
    for (const text of [roleChangeText('Mina', 'viewer'), roleChangeText('Mina', 'editor'), VIEW_ONLY, needsUpdateText('Ben')]) expect(text).not.toMatch(/!/);
  });

  it('gives a viewer a plain reason for tools that are off', () => {
    expect(VIEW_ONLY).toBe('You can view this room but not edit it. The host can change that.');
  });

  it('leaves out edits from a member the room knows as a viewer', () => {
    const roster = [member(1, 'host'), member(2, 'editor'), member(3, 'viewer')];
    expect(acceptsEditFrom(roster, 1)).toBe(true);
    expect(acceptsEditFrom(roster, 2)).toBe(true);
    expect(acceptsEditFrom(roster, 3)).toBe(false);
    // Whether someone is a member at all is the room server's decision; only a known viewer is refused here.
    expect(acceptsEditFrom(roster, 9)).toBe(true);
  });

  it('knows which apps understand a role change', () => {
    expect(CAPS).toContain('roles');
    expect(supportsRoles(cleanCaps(CAPS))).toBe(true);
    // An app from before roles could be changed says nothing about what it can do.
    expect(supportsRoles(cleanCaps(undefined))).toBe(false);
    expect(supportsRoles(cleanCaps(['other']))).toBe(false);
    expect(cleanCaps(['roles', 5, 'x'.repeat(40), 'roles'])).toEqual(['roles']);
    expect(cleanCaps('roles')).toEqual([]);
    expect(needsUpdateText('Ben')).toBe('Ben needs a newer W Annotator before this can be changed.');
  });
});
