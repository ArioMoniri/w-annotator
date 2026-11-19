import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEGMENT_COLORS, SEGMENT_COLOR_NAMES, TOAST_EXIT_MS, dismissToast, get, set, toast } from './store';

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

describe('segment palette', () => {
  it('has a name for every colour', () => {
    expect(SEGMENT_COLOR_NAMES).toHaveLength(SEGMENT_COLORS.length);
    expect(SEGMENT_COLOR_NAMES[0]).toBe('Orange');
    expect(SEGMENT_COLOR_NAMES[11]).toBe('Mauve');
  });
});
