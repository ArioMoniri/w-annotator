import { describe, expect, it } from 'vitest';
import { ACTIONS, actionFor, comboFromEvent, defaultBindings, formatCombo, isReserved, rebind } from './shortcuts';

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
