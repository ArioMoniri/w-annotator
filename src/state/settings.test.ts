import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, applyReduceMotion, cleanName, parseSettings } from './settings';

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
  it('starts with mouse and trackpad defaults that suit both', () => {
    const s = parseSettings(null);
    expect(s.scrollDirection).toBe('natural');
    expect(s.trackpadSpeed).toBe(5);
    expect(s.twoFingerScroll).toBe('slice');
    expect(s.pinchZoom).toBe(true);
    expect(s.wheelZooms).toBe(false);
    expect(s.zoomSpeed).toBe(5);
  });
  it('keeps saved mouse and trackpad choices', () => {
    const s = parseSettings('{"scrollDirection":"reversed","trackpadSpeed":8,"twoFingerScroll":"pan","pinchZoom":false,"wheelZooms":true,"zoomSpeed":2}');
    expect(s).toMatchObject({ scrollDirection: 'reversed', trackpadSpeed: 8, twoFingerScroll: 'pan', pinchZoom: false, wheelZooms: true, zoomSpeed: 2 });
  });
  it('falls back to the default for a choice that does not exist', () => {
    const s = parseSettings('{"scrollDirection":"sideways","twoFingerScroll":"rotate"}');
    expect(s.scrollDirection).toBe('natural');
    expect(s.twoFingerScroll).toBe('slice');
  });
  it('keeps speeds within 1 to 10', () => {
    const s = parseSettings('{"trackpadSpeed":400,"zoomSpeed":-2}');
    expect(s.trackpadSpeed).toBe(10);
    expect(s.zoomSpeed).toBe(1);
    expect(parseSettings('{"trackpadSpeed":null}').trackpadSpeed).toBe(5);
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
