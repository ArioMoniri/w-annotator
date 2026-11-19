import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from './settings';

describe('parseSettings', () => {
  it('returns the defaults for nothing or for garbage', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
  });
  it('autosave is on unless turned off', () => {
    expect(parseSettings('{}').autosave).toBe(true);
    expect(parseSettings('{"autosave":false}').autosave).toBe(false);
  });
  it('ignores values of the wrong type and unknown keys', () => {
    const s = parseSettings('{"autosave":"yes","displayName":"Mina","extra":1}');
    expect(s.autosave).toBe(true);
    expect(s.displayName).toBe('Mina');
    expect('extra' in s).toBe(false);
  });
});
