import { describe, expect, it } from 'vitest';
import { itemsToDrop, placeMenu } from './place';

describe('placeMenu', () => {
  it('stays where it was asked for when it fits', () => {
    expect(placeMenu(120, 200, 48, 576)).toEqual({ top: 120, maxHeight: 528 });
  });

  it('moves up so its last item stays above the bottom edge', () => {
    expect(placeMenu(300, 400, 48, 576).top).toBe(176);
  });

  it('never goes above the top edge', () => {
    expect(placeMenu(10, 100, 48, 576).top).toBe(48);
  });

  it('fills the band and scrolls inside when it is taller than the band', () => {
    expect(placeMenu(300, 900, 48, 576)).toEqual({ top: 48, maxHeight: 528 });
  });

  it('copes with a band that has no room', () => {
    expect(placeMenu(300, 100, 500, 400)).toEqual({ top: 500, maxHeight: 0 });
  });
});

describe('itemsToDrop', () => {
  it('drops nothing when everything fits', () => {
    expect(itemsToDrop([100, 60], 400, 600)).toBe(0);
  });

  it('drops whole items in order until the rest fits', () => {
    expect(itemsToDrop([100, 60, 80], 400, 600)).toBe(1);
    expect(itemsToDrop([100, 60, 80], 400, 500)).toBe(2);
  });

  it('drops them all when even the fixed part is too wide', () => {
    expect(itemsToDrop([100, 60], 700, 600)).toBe(2);
  });
});
