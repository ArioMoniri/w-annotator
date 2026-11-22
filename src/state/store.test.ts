import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEGMENT_COLORS, SEGMENT_COLOR_NAMES, TOAST_EXIT_MS, dismissToast, dropToastActions, get, holdToast, set, toast } from './store';

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    set({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('shows the same message once however often it is raised', () => {
    toast('info', 'Segment 1 is locked. Unlock it to edit.');
    toast('info', 'Segment 1 is locked. Unlock it to edit.');
    toast('info', 'Segment 1 is locked. Unlock it to edit.');
    expect(get().toasts).toHaveLength(1);
  });

  it('keeps different messages apart', () => {
    toast('info', 'Mina joined');
    toast('info', 'Ravi joined');
    expect(get().toasts.map((t) => t.text)).toEqual(['Mina joined', 'Ravi joined']);
  });

  it('starts the timer again when a message repeats', () => {
    toast('info', 'Mina joined');
    vi.advanceTimersByTime(3000);
    toast('info', 'Mina joined');
    vi.advanceTimersByTime(3000);
    expect(get().toasts).toHaveLength(1);
    expect(get().toasts[0].leaving).toBeFalsy();
    vi.advanceTimersByTime(1000 + TOAST_EXIT_MS);
    expect(get().toasts).toHaveLength(0);
  });

  it('marks a toast as leaving before it is removed', () => {
    toast('error', 'Could not save.');
    const id = get().toasts[0].id;
    dismissToast(id);
    expect(get().toasts[0].leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(get().toasts).toHaveLength(0);
  });

  it('brings back a toast that repeats while it is leaving', () => {
    toast('info', 'Mina joined');
    dismissToast(get().toasts[0].id);
    toast('info', 'Mina joined');
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(get().toasts).toHaveLength(1);
    expect(get().toasts[0].leaving).toBeFalsy();
  });

  it('leaves an error up until it is dismissed', () => {
    toast('error', 'Could not save.');
    vi.advanceTimersByTime(60_000);
    expect(get().toasts).toHaveLength(1);
  });
});

describe('toast timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    set({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('stops while the pointer is over the toast and goes on with the time that was left', () => {
    toast('info', 'Liver cleared', { label: 'Undo', run: () => {} });
    const id = get().toasts[0].id;
    vi.advanceTimersByTime(5000);
    holdToast(id, 'hover', true);
    vi.advanceTimersByTime(60_000);
    expect(get().toasts).toHaveLength(1);
    expect(get().toasts[0].leaving).toBeFalsy();
    holdToast(id, 'hover', false);
    vi.advanceTimersByTime(900);
    expect(get().toasts[0].leaving).toBeFalsy();
    vi.advanceTimersByTime(100 + TOAST_EXIT_MS);
    expect(get().toasts).toHaveLength(0);
  });

  it('stays stopped until both the pointer and the keyboard focus have left', () => {
    toast('info', 'Mina joined');
    const id = get().toasts[0].id;
    holdToast(id, 'hover', true);
    holdToast(id, 'focus', true);
    holdToast(id, 'hover', false);
    vi.advanceTimersByTime(60_000);
    expect(get().toasts).toHaveLength(1);
    holdToast(id, 'focus', false);
    vi.advanceTimersByTime(4000 + TOAST_EXIT_MS);
    expect(get().toasts).toHaveLength(0);
  });

  it('does not bring a dismissed toast back when the pointer leaves it', () => {
    toast('info', 'Mina joined');
    const id = get().toasts[0].id;
    holdToast(id, 'hover', true);
    dismissToast(id);
    holdToast(id, 'hover', false);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(get().toasts).toHaveLength(0);
  });

  it('gives an error no timer when the pointer leaves it', () => {
    toast('error', 'Could not save.');
    const id = get().toasts[0].id;
    holdToast(id, 'hover', true);
    holdToast(id, 'hover', false);
    vi.advanceTimersByTime(60_000);
    expect(get().toasts).toHaveLength(1);
  });
});

describe('toast actions', () => {
  beforeEach(() => set({ toasts: [] }));

  it('takes an action off the toasts it no longer fits and leaves the others', () => {
    const undo = () => {};
    const retry = () => {};
    toast('info', 'Liver cleared', { label: 'Undo', run: undo });
    toast('error', "Couldn't save the mask.", { label: 'Retry', run: retry });
    dropToastActions((a) => a.run === undo);
    expect(get().toasts.map((t) => t.action?.label)).toEqual([undefined, 'Retry']);
    expect(get().toasts.map((t) => t.text)).toEqual(['Liver cleared', "Couldn't save the mask."]);
  });
});

describe('segment palette', () => {
  it('has a name for every colour', () => {
    expect(SEGMENT_COLOR_NAMES).toHaveLength(SEGMENT_COLORS.length);
    expect(SEGMENT_COLOR_NAMES[0]).toBe('Orange');
    expect(SEGMENT_COLOR_NAMES[11]).toBe('Mauve');
  });
});
