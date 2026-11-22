import { describe, expect, it } from 'vitest';
import { ROLE_CHOICES, VIEW_ONLY, canEdit, roleChangeText } from './roles';

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
    for (const text of [roleChangeText('Mina', 'viewer'), roleChangeText('Mina', 'editor'), VIEW_ONLY]) expect(text).not.toMatch(/!/);
  });

  it('gives a viewer a plain reason for tools that are off', () => {
    expect(VIEW_ONLY).toBe('You can view this room but not edit it. The host can change that.');
  });
});
