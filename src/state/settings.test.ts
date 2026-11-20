import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, applyReduceMotion, cleanName, parseReferenceLines, parseSettings } from './settings';

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

describe('view settings', () => {
  it('start as the 2 × 2 grid in the usual order, with reference lines on hover', () => {
    const s = parseSettings(null);
    expect(s.layout).toBe('grid');
    expect(s.viewOrder).toBe('axial,sagittal,coronal,volume3d');
    expect(s.referenceLines).toBe('hover');
  });
  it('keep what was saved', () => {
    const s = parseSettings('{"layout":"focus","viewOrder":"coronal,sagittal,axial,volume3d","referenceLines":"always"}');
    expect(s.layout).toBe('focus');
    expect(s.viewOrder).toBe('coronal,sagittal,axial,volume3d');
    expect(s.referenceLines).toBe('always');
  });
  it('fall back when a saved value is not one of the choices', () => {
    const s = parseSettings('{"layout":"9x9","viewOrder":"axial,axial,axial,axial","referenceLines":"sometimes"}');
    expect(s.layout).toBe('grid');
    expect(s.viewOrder).toBe('axial,sagittal,coronal,volume3d');
    expect(s.referenceLines).toBe('hover');
    expect(parseReferenceLines('crosshair')).toBe('crosshair');
    expect(parseReferenceLines('')).toBe('hover');
  });
});

describe('cleanName', () => {
  it('trims and keeps at most 24 characters', () => {
    expect(cleanName('  Mina  ')).toBe('Mina');
    expect(cleanName('a'.repeat(40))).toHaveLength(24);
  });
  it('gives an empty name for anything that is not text', () => {
    expect(cleanName(undefined)).toBe('');
    expect(cleanName(12)).toBe('');
  });
});

describe('applyReduceMotion', () => {
  it('sets and removes data-reduce-motion on the root element', () => {
    const calls: string[] = [];
    const root = {
      setAttribute: (name: string, value: string) => calls.push(`set ${name}=${value}`),
      removeAttribute: (name: string) => calls.push(`remove ${name}`),
    };
    applyReduceMotion(root, true);
    applyReduceMotion(root, false);
    expect(calls).toEqual(['set data-reduce-motion=true', 'remove data-reduce-motion']);
  });
});
