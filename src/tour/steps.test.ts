import { describe, expect, it } from 'vitest';
import { FULL_STEPS, SHORT_STEPS, cutout, initialTour, placeCard, shouldShowTour, stepsFor, tourReducer, type Rect } from './steps';

const words = (text: string) => text.trim().split(/\s+/).length;

describe('tour copy', () => {
  it('has 9 to 11 steps with a sample and 3 without', () => {
    expect(FULL_STEPS.length).toBeGreaterThanOrEqual(9);
    expect(FULL_STEPS.length).toBeLessThanOrEqual(11);
    expect(SHORT_STEPS).toHaveLength(3);
  });
  it('keeps every title to 4 words and every body to one sentence of 18 words', () => {
    for (const step of [...FULL_STEPS, ...SHORT_STEPS]) {
      expect(words(step.title), step.id).toBeLessThanOrEqual(4);
      expect(words(step.body), step.id).toBeLessThanOrEqual(18);
      // A sentence ends at the end of the text or before a capital; "press ? to" is not an ending.
      expect(step.body.match(/[.!?](\s+[A-Z]|$)/g), step.id).toHaveLength(1);
      expect(step.title + step.body, step.id).not.toContain('!');
    }
  });
  it('anchors every step to a data-tour target and uses each id once', () => {
    const all = [...FULL_STEPS, ...SHORT_STEPS];
    for (const step of all) expect(step.targets.length, step.id).toBeGreaterThan(0);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  });
});

describe('shouldShowTour', () => {
  it('shows on a first launch only', () => {
    expect(shouldShowTour(false, '')).toBe(true);
    expect(shouldShowTour(true, '')).toBe(false);
  });
  it('stays away with ?tour=0', () => {
    expect(shouldShowTour(false, '?tour=0')).toBe(false);
    expect(shouldShowTour(false, '?x=1&tour=0')).toBe(false);
    expect(shouldShowTour(false, '?tour=1')).toBe(true);
  });
});

describe('tourReducer', () => {
  const start = tourReducer(initialTour, { type: 'start', hasImage: false });
  it('starts by offering the sample', () => {
    expect(start).toMatchObject({ phase: 'offer' });
  });
  it('goes straight to the steps when an image is already open', () => {
    expect(tourReducer(initialTour, { type: 'start', hasImage: true })).toMatchObject({ phase: 'steps', kind: 'full', index: 0, sample: false });
  });
  it('walks the full tour to the end card and remembers the sample', () => {
    let s = tourReducer(start, { type: 'choose', kind: 'full', sample: true });
    expect(s).toMatchObject({ phase: 'steps', kind: 'full', index: 0, sample: true });
    for (let i = 0; i < FULL_STEPS.length - 1; i++) s = tourReducer(s, { type: 'next' });
    expect(s).toMatchObject({ phase: 'steps', index: FULL_STEPS.length - 1 });
    s = tourReducer(s, { type: 'next' });
    expect(s).toMatchObject({ phase: 'end', sample: true });
    expect(tourReducer(s, { type: 'back' })).toMatchObject({ phase: 'steps', index: FULL_STEPS.length - 1 });
  });
  it('runs three steps without the sample', () => {
    let s = tourReducer(start, { type: 'choose', kind: 'short', sample: false });
    expect(stepsFor(s.kind)).toBe(SHORT_STEPS);
    s = tourReducer(tourReducer(tourReducer(s, { type: 'next' }), { type: 'next' }), { type: 'next' });
    expect(s.phase).toBe('end');
  });
  it('does not go back past the first step, and closes from anywhere', () => {
    const s = tourReducer(start, { type: 'choose', kind: 'short', sample: false });
    expect(tourReducer(s, { type: 'back' })).toEqual(s);
    expect(tourReducer(s, { type: 'close' }).phase).toBe('off');
    expect(tourReducer(start, { type: 'close' }).phase).toBe('off');
  });
  it('ignores next and back when no steps are showing', () => {
    expect(tourReducer(initialTour, { type: 'next' })).toEqual(initialTour);
    expect(tourReducer(start, { type: 'back' })).toEqual(start);
  });
});

describe('cutout', () => {
  it('pads the target and stays inside the window', () => {
    expect(cutout({ x: 100, y: 100, w: 40, h: 40 }, { w: 1024, h: 640 }, 6)).toEqual({ x: 94, y: 94, w: 52, h: 52 });
    expect(cutout({ x: 0, y: 44, w: 48, h: 596 }, { w: 1024, h: 640 }, 6)).toEqual({ x: 0, y: 38, w: 54, h: 602 });
  });
});

describe('placeCard', () => {
  const view = { w: 1024, h: 640 };
  const card = { w: 300, h: 190 };
  const inside = (r: Rect) => r.x >= 12 && r.y >= 12 && r.x + r.w <= view.w - 12 && r.y + r.h <= view.h - 12;
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('goes beside a control at the left edge without covering it', () => {
    const target = { x: 0, y: 44, w: 48, h: 570 };
    const at = placeCard(target, card, view);
    expect(at.x).toBe(60);
    expect(overlaps({ ...at, ...card }, target)).toBe(false);
  });
  it('goes below a control in the top bar and stays on screen at the right edge', () => {
    const target = { x: 930, y: 8, w: 82, h: 28 };
    const at = placeCard(target, card, view, ['bottom']);
    expect(at.y).toBe(48);
    expect(inside({ ...at, ...card })).toBe(true);
    expect(overlaps({ ...at, ...card }, target)).toBe(false);
  });
  it('goes to the left of the right-hand panel', () => {
    const target = { x: 760, y: 44, w: 264, h: 570 };
    const at = placeCard(target, card, view);
    expect(at.x + card.w).toBe(748);
  });
  it('centres on a small control and keeps to the side asked for', () => {
    const target = { x: 6, y: 300, w: 36, h: 36 };
    const at = placeCard(target, card, view, ['right']);
    expect(at.y + card.h / 2).toBe(318);
  });
  it('is always fully on screen, whatever the target', () => {
    const targets: Rect[] = [
      { x: 48, y: 84, w: 712, h: 530 },
      { x: 232, y: 170, w: 560, h: 300 },
      { x: 0, y: 0, w: 1024, h: 640 },
      { x: 6, y: 560, w: 36, h: 76 },
      { x: 1000, y: 620, w: 20, h: 20 },
      { x: -50, y: -50, w: 10, h: 10 },
    ];
    for (const size of [view, { w: 1440, h: 900 }, { w: 800, h: 500 }])
      for (const target of targets) {
        const at = placeCard(target, card, size);
        expect(at.x, JSON.stringify(target)).toBeGreaterThanOrEqual(12);
        expect(at.y, JSON.stringify(target)).toBeGreaterThanOrEqual(12);
        expect(at.x + card.w).toBeLessThanOrEqual(size.w - 12);
        expect(at.y + card.h).toBeLessThanOrEqual(size.h - 12);
      }
  });
  it('sits in the middle when there is nothing to point at', () => {
    expect(placeCard(null, card, view)).toEqual({ x: 362, y: 225 });
  });
});
