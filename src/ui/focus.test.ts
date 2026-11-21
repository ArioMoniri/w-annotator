import { describe, expect, it } from 'vitest';
import { nextStop, takesTab, type Control } from './focus';

const control = (over: Partial<Control> = {}): Control => ({ tag: 'button', type: '', tabindex: null, disabled: false, shown: true, ...over });

describe('takesTab', () => {
  it('stops at buttons, fields, lists, links and disclosure headings', () => {
    for (const tag of ['button', 'input', 'select', 'textarea', 'a', 'summary']) expect(takesTab(control({ tag })), tag).toBe(true);
  });

  it('stops at every kind of input, not only text', () => {
    for (const type of ['text', 'checkbox', 'range', 'radio', 'number', 'file']) expect(takesTab(control({ tag: 'input', type })), type).toBe(true);
  });

  it('does not care about the case of the tag', () => {
    expect(takesTab(control({ tag: 'BUTTON' }))).toBe(true);
    expect(takesTab(control({ tag: 'TEXTAREA' }))).toBe(true);
  });

  it('skips a control that is disabled', () => {
    expect(takesTab(control({ disabled: true }))).toBe(false);
  });

  it('skips a control that is not on screen', () => {
    expect(takesTab(control({ shown: false }))).toBe(false);
  });

  it('skips a hidden input', () => {
    expect(takesTab(control({ tag: 'input', type: 'hidden' }))).toBe(false);
  });

  it('skips a control taken out of the order with a negative tabindex', () => {
    expect(takesTab(control({ tabindex: '-1' }))).toBe(false);
    expect(takesTab(control({ tag: 'div', tabindex: '-1' }))).toBe(false);
  });

  it('stops at anything given a tabindex of zero or more', () => {
    expect(takesTab(control({ tag: 'pre', tabindex: '0' }))).toBe(true);
    expect(takesTab(control({ tag: 'div', tabindex: '2' }))).toBe(true);
  });

  it('skips plain content', () => {
    expect(takesTab(control({ tag: 'div' }))).toBe(false);
    expect(takesTab(control({ tag: 'pre', tabindex: 'x' }))).toBe(false);
  });
});

describe('nextStop', () => {
  it('goes to the stop after the one with focus', () => {
    expect(nextStop(4, { before: 0, onStop: true }, false)).toBe(1);
    expect(nextStop(4, { before: 2, onStop: true }, false)).toBe(3);
  });

  it('goes to the stop before the one with focus with Shift', () => {
    expect(nextStop(4, { before: 3, onStop: true }, true)).toBe(2);
    expect(nextStop(4, { before: 1, onStop: true }, true)).toBe(0);
  });

  it('wraps from the last stop to the first, and back', () => {
    expect(nextStop(4, { before: 3, onStop: true }, false)).toBe(0);
    expect(nextStop(4, { before: 0, onStop: true }, true)).toBe(3);
  });

  it('starts at either end when focus is outside', () => {
    expect(nextStop(4, null, false)).toBe(0);
    expect(nextStop(4, null, true)).toBe(3);
  });

  it('goes to the nearest stop on that side when focus sits between two stops', () => {
    // Focus on something that is not a stop, with two stops before it.
    expect(nextStop(4, { before: 2, onStop: false }, false)).toBe(2);
    expect(nextStop(4, { before: 2, onStop: false }, true)).toBe(1);
    expect(nextStop(4, { before: 4, onStop: false }, false)).toBe(0);
    expect(nextStop(4, { before: 0, onStop: false }, true)).toBe(3);
  });

  it('stays on the only stop', () => {
    expect(nextStop(1, { before: 0, onStop: true }, false)).toBe(0);
    expect(nextStop(1, { before: 0, onStop: true }, true)).toBe(0);
  });

  it('has nowhere to go without stops', () => {
    expect(nextStop(0, null, false)).toBe(-1);
  });
});
