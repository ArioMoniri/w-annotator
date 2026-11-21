import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  actionFor,
  comboFromEvent,
  defaultBindings,
  formatCombo,
  isReserved,
  rebind,
  rebindNote,
  setShortcut,
  setShortcuts,
  useShortcuts,
} from './shortcuts';

describe('taking a key from another action', () => {
  it('says what the key does now and what lost it', () => {
    expect(rebindNote('tool.pan', 'mod+s', 'file.save', false)).toBe('Ctrl+S now selects Pan. Save mask has no shortcut.');
    expect(rebindNote('edit.undo', 'q', 'tool.zoom', false)).toBe('Q is now Undo. Zoom has no shortcut.');
  });

  it('says nothing when the key was free', () => {
    expect(rebindNote('tool.pan', 'q', null, false)).toBe('');
  });

  it('can be undone for both actions', () => {
    const before = { ...useShortcuts.getState().bindings };
    expect(setShortcut('tool.pan', 'mod+s')).toBe('file.save');
    expect(useShortcuts.getState().bindings['file.save']).toBe('');
    setShortcuts(before);
    expect(useShortcuts.getState().bindings).toEqual(defaultBindings());
  });
});

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('comboFromEvent', () => {
  it('spells plain keys in lower case', () => {
    expect(comboFromEvent(ev('B'))).toBe('b');
    expect(comboFromEvent(ev(' '))).toBe('space');
    expect(comboFromEvent(ev('ArrowUp'))).toBe('arrowup');
  });
  it('treats Ctrl and Cmd as the same modifier', () => {
    expect(comboFromEvent(ev('z', { ctrlKey: true }))).toBe('mod+z');
    expect(comboFromEvent(ev('Z', { metaKey: true, shiftKey: true }))).toBe('mod+shift+z');
  });
  it('does not count Shift for typed symbols', () => {
    expect(comboFromEvent(ev('?', { shiftKey: true }))).toBe('?');
    expect(comboFromEvent(ev('B', { shiftKey: true }))).toBe('shift+b');
  });
  it('ignores bare modifier presses', () => {
    expect(comboFromEvent(ev('Shift', { shiftKey: true }))).toBeNull();
    expect(comboFromEvent(ev('Meta', { metaKey: true }))).toBeNull();
  });
});

describe('bindings', () => {
  it('has no duplicate or reserved defaults', () => {
    const keys = ACTIONS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some(isReserved)).toBe(false);
  });
  it('gives each layout a key of its own', () => {
    const b = defaultBindings();
    expect(actionFor(b, 'mod+1')).toBe('layout.grid');
    expect(actionFor(b, 'mod+2')).toBe('layout.focus');
    expect(actionFor(b, 'mod+3')).toBe('layout.three');
    expect(actionFor(b, 'mod+4')).toBe('layout.two');
    expect(actionFor(b, 'mod+5')).toBe('layout.single');
  });
  it('steps through window presets with P and Shift+P, leaving the digits to the segments', () => {
    const b = defaultBindings();
    expect(actionFor(b, 'p')).toBe('window.next');
    expect(actionFor(b, 'shift+p')).toBe('window.previous');
    expect(ACTIONS.find((a) => a.id === 'window.next')?.label).toBe('Next window preset');
    expect(ACTIONS.find((a) => a.id === 'window.previous')?.label).toBe('Previous window preset');
  });
  it('has keys for brightness and contrast', () => {
    const b = defaultBindings();
    expect(actionFor(b, 'shift+arrowup')).toBe('window.brighter');
    expect(actionFor(b, 'shift+arrowdown')).toBe('window.darker');
    expect(actionFor(b, 'shift+arrowright')).toBe('window.moreContrast');
    expect(actionFor(b, 'shift+arrowleft')).toBe('window.lessContrast');
  });
  it('has keys for zoom', () => {
    const b = defaultBindings();
    expect(actionFor(b, '=')).toBe('view.zoomIn');
    expect(actionFor(b, '-')).toBe('view.zoomOut');
    expect(actionFor(b, '0')).toBe('view.fit');
    expect(ACTIONS.find((a) => a.id === 'view.fit')?.label).toBe('Fit to view');
  });
  it('finds the action for a key', () => {
    expect(actionFor(defaultBindings(), 'b')).toBe('tool.brush');
    expect(actionFor(defaultBindings(), 'q')).toBeNull();
  });
  it('rebinds and takes the key away from whoever had it', () => {
    const { bindings, displaced } = rebind(defaultBindings(), 'tool.brush', 'e');
    expect(displaced).toBe('tool.eraser');
    expect(bindings['tool.brush']).toBe('e');
    expect(bindings['tool.eraser']).toBe('');
    expect(actionFor(bindings, 'b')).toBeNull();
  });
  it('rebinding to its own key displaces nothing', () => {
    expect(rebind(defaultBindings(), 'tool.brush', 'b').displaced).toBeNull();
  });
});

describe('formatCombo', () => {
  it('shows platform names', () => {
    expect(formatCombo('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatCombo('mod+shift+z', true)).toBe('⌘ Shift Z');
    expect(formatCombo('arrowup', false)).toBe('↑');
    expect(formatCombo('', false)).toBe('—');
  });
});

describe('settings shortcut', () => {
  it('opens settings with mod+, by default and can be rebound', () => {
    expect(defaultBindings()['app.settings']).toBe('mod+,');
    expect(actionFor(defaultBindings(), comboFromEvent({ key: ',', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })!)).toBe('app.settings');
    const { bindings } = rebind(defaultBindings(), 'app.settings', 'mod+shift+p');
    expect(actionFor(bindings, 'mod+shift+p')).toBe('app.settings');
  });
});
