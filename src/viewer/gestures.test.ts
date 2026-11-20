import { describe, expect, it } from 'vitest';
import {
  classifyWheel,
  createGestureState,
  pinchFactor,
  pixelsPerSlice,
  wheelAction,
  zoomAbout,
  zoomGain,
  type GestureAction,
  type GestureOptions,
  type WheelLike,
} from './gestures';
import {
  MAC_TRACKPAD_TOTAL,
  MAGIC_MOUSE_TOTAL,
  PINCH_TOTAL,
  PRECISION_TOUCHPAD_TOTAL,
  diagonalScroll,
  horizontalSwipe,
  macTrackpadScroll,
  magicMouseScroll,
  notchedMouse,
  notchedMouseFirefox,
  notchedMouseMacChromium,
  notchedMouseSafari,
  notchedMouseWebKitGtk,
  pinchAsCtrlWheel,
  precisionTouchpadScroll,
  slowTrackpadScroll,
} from './gestures.fixtures';

const OPTIONS: GestureOptions = {
  scrollDirection: 'natural',
  trackpadSpeed: 5,
  twoFingerScroll: 'slice',
  pinchZoom: true,
  wheelZooms: false,
  zoomSpeed: 5,
  pane: 'slice',
  brushActive: false,
  mac: false,
};

function run(events: WheelLike[], options: Partial<GestureOptions> = {}, state = createGestureState()): GestureAction[] {
  return events.map((e) => wheelAction(state, e, { ...OPTIONS, ...options }));
}

const devices = (events: WheelLike[], mac = false) => {
  const state = createGestureState();
  return events.map((e) => {
    const device = classifyWheel(state, e, mac);
    wheelAction(state, e, { ...OPTIONS, mac });
    return device;
  });
};

const slices = (actions: GestureAction[]) => actions.reduce((n, a) => n + (a.type === 'slice' ? a.steps : 0), 0);
const zoom = (actions: GestureAction[]) => actions.reduce((f, a) => f * (a.type === 'zoom' ? a.factor : 1), 1);
const types = (actions: GestureAction[]) => [...new Set(actions.map((a) => a.type))];

describe('telling a mouse wheel from a trackpad', () => {
  it('calls a notched mouse in Chromium a mouse', () => {
    expect(new Set(devices(notchedMouse(5)))).toEqual(new Set(['mouse']));
  });

  it('calls a line-mode wheel in Firefox a mouse', () => {
    expect(new Set(devices(notchedMouseFirefox(5)))).toEqual(new Set(['mouse']));
  });

  it('calls a notched mouse in Chromium on a Mac a mouse, despite its small pixel deltas', () => {
    expect(new Set(devices(notchedMouseMacChromium(), true))).toEqual(new Set(['mouse']));
  });

  it('calls a notched mouse in Safari a mouse, from its fractional deltas', () => {
    expect(new Set(devices(notchedMouseSafari(), true))).toEqual(new Set(['mouse']));
  });

  it('calls a notched mouse in WebKitGTK a mouse', () => {
    expect(new Set(devices(notchedMouseWebKitGtk(4)))).toEqual(new Set(['mouse']));
  });

  it('calls a Mac trackpad scroll a trackpad, through the momentum', () => {
    expect(new Set(devices(macTrackpadScroll(), true))).toEqual(new Set(['trackpad']));
  });

  it('calls a Magic Mouse a trackpad, because it scrolls like one', () => {
    expect(new Set(devices(magicMouseScroll(), true))).toEqual(new Set(['trackpad']));
  });

  it('calls a Windows precision touchpad a trackpad, even at its fastest', () => {
    expect(new Set(devices(precisionTouchpadScroll()))).toEqual(new Set(['trackpad']));
  });

  it('calls a pinch a trackpad', () => {
    expect(new Set(devices(pinchAsCtrlWheel('out'), true))).toEqual(new Set(['trackpad']));
  });

  it('keeps a stream with fractional deltas a trackpad on a Mac once it has started as one', () => {
    // Should a trackpad ever report part-pixels there, the scroll must not turn into wheel notches midway.
    const stream = macTrackpadScroll().map((e, i) => (i < 2 ? e : { ...e, deltaX: 0, deltaY: e.deltaY + 0.5, wheelDeltaY: Math.round(-3 * (e.deltaY + 0.5)) }));
    expect(new Set(devices(stream, true))).toEqual(new Set(['trackpad']));
  });

  it('calls a large lone delta with no wheelDelta a mouse', () => {
    const e = { ...notchedMouse(1)[0], wheelDeltaY: undefined };
    expect(classifyWheel(createGestureState(), e, false)).toBe('mouse');
  });

  it('keeps calling a stream a trackpad when one delta in it is large and has no wheelDelta', () => {
    const stream = precisionTouchpadScroll().map((e) => ({ ...e, wheelDeltaY: undefined }));
    expect(new Set(devices(stream))).toEqual(new Set(['trackpad']));
  });
});

describe('mouse wheel', () => {
  it('moves one slice per notch', () => {
    const actions = run(notchedMouse(5));
    expect(actions).toEqual(Array(5).fill({ type: 'slice', steps: 1 }));
  });

  it('moves back one slice per notch the other way', () => {
    expect(slices(run(notchedMouse(3, -1)))).toBe(-3);
  });

  it('moves one slice per notch whatever the size of the delta', () => {
    expect(slices(run(notchedMouseMacChromium(), { mac: true }))).toBe(5);
    expect(slices(run(notchedMouseSafari(), { mac: true }))).toBe(5);
    expect(slices(run(notchedMouseFirefox(4)))).toBe(4);
  });

  it('moves five slices per notch with Shift', () => {
    expect(slices(run(notchedMouse(2, 1, { shiftKey: true })))).toBe(10);
  });

  it('reads Shift+wheel when the browser has turned it into a sideways scroll', () => {
    const swapped = notchedMouse(2, 1, { shiftKey: true }).map((e) => ({ ...e, deltaX: e.deltaY, deltaY: 0, wheelDeltaY: 0 }));
    expect(slices(run(swapped))).toBe(10);
  });

  it('reads Shift+wheel as WebKitGTK sends it', () => {
    expect(slices(run(notchedMouseWebKitGtk(2, 1, { shiftKey: true })))).toBe(10);
    expect(slices(run(notchedMouseWebKitGtk(1, -1, { shiftKey: true })))).toBe(-5);
  });

  it('reads the fields of a real event, which are not its own properties', () => {
    // A DOM event keeps its fields on the prototype, so copying the object loses them.
    class DomLike {
      get deltaX() {
        return 86;
      }
      get deltaY() {
        return 0;
      }
      get deltaMode() {
        return 0;
      }
      get ctrlKey() {
        return false;
      }
      get metaKey() {
        return false;
      }
      get shiftKey() {
        return true;
      }
      get altKey() {
        return false;
      }
      get timeStamp() {
        return 1000;
      }
      get wheelDeltaY() {
        return 0;
      }
    }
    expect(wheelAction(createGestureState(), new DomLike(), OPTIONS)).toEqual({ type: 'slice', steps: 5 });
  });

  it('zooms in by a step per notch up with Ctrl', () => {
    const actions = run(notchedMouse(2, -1, { ctrlKey: true }));
    expect(types(actions)).toEqual(['zoom']);
    expect(zoom(actions)).toBeCloseTo(Math.exp(0.2), 6);
  });

  it('zooms out with Cmd and the wheel down', () => {
    expect(zoom(run(notchedMouse(1, 1, { metaKey: true })))).toBeCloseTo(Math.exp(-0.1), 6);
  });

  it('goes the other way when the scroll direction is reversed', () => {
    expect(slices(run(notchedMouse(3), { scrollDirection: 'reversed' }))).toBe(-3);
  });

  it('zooms without a modifier when the wheel is set to zoom, and changes slice with Ctrl', () => {
    expect(types(run(notchedMouse(2), { wheelZooms: true }))).toEqual(['zoom']);
    expect(slices(run(notchedMouse(2, 1, { ctrlKey: true }), { wheelZooms: true }))).toBe(2);
  });

  it('still changes slice when two-finger scroll is set to pan', () => {
    expect(slices(run(notchedMouse(2), { twoFingerScroll: 'pan' }))).toBe(2);
  });
});

describe('trackpad scroll', () => {
  it('turns pixels into whole slices at the set speed, carrying the remainder', () => {
    const actions = run(macTrackpadScroll(), { mac: true });
    expect(slices(actions)).toBe(Math.floor(MAC_TRACKPAD_TOTAL / pixelsPerSlice(5)));
    expect(actions.every((a) => a.type === 'none' || (a.type === 'slice' && Number.isInteger(a.steps) && a.steps !== 0))).toBe(true);
  });

  it('advances smoothly: never more than one slice per event at the default speed on a Mac trackpad', () => {
    const steps = run(macTrackpadScroll(), { mac: true }).map((a) => (a.type === 'slice' ? a.steps : 0));
    expect(Math.max(...steps)).toBe(1);
    expect(steps.filter((s) => s === 1).length).toBeGreaterThan(5);
  });

  it('does not lose events smaller than one pixel', () => {
    const px = pixelsPerSlice(5);
    expect(slices(run(slowTrackpadScroll(px * 2 * 3)))).toBe(3);
  });

  it('scrolls back the same distance the other way', () => {
    expect(slices(run(macTrackpadScroll(-1), { mac: true }))).toBe(-Math.floor(MAC_TRACKPAD_TOTAL / pixelsPerSlice(5)));
  });

  it('moves further at a faster speed and less far at a slower one', () => {
    const at = (trackpadSpeed: number) => slices(run(macTrackpadScroll(), { mac: true, trackpadSpeed }));
    expect(at(1)).toBeLessThan(at(5));
    expect(at(5)).toBeLessThan(at(10));
    expect(at(1)).toBeGreaterThan(0);
  });

  it('handles a Magic Mouse and a precision touchpad the same way', () => {
    expect(slices(run(magicMouseScroll(), { mac: true }))).toBe(Math.floor(MAGIC_MOUSE_TOTAL / pixelsPerSlice(5)));
    expect(slices(run(precisionTouchpadScroll()))).toBe(Math.floor(PRECISION_TOUCHPAD_TOTAL / pixelsPerSlice(5)));
  });

  it('goes five times as far with Shift', () => {
    const plain = MAC_TRACKPAD_TOTAL / pixelsPerSlice(5);
    expect(slices(run(macTrackpadScroll(1, { shiftKey: true }), { mac: true }))).toBe(Math.floor(plain * 5));
  });

  it('goes the other way when the scroll direction is reversed', () => {
    expect(slices(run(macTrackpadScroll(), { mac: true, scrollDirection: 'reversed' }))).toBeLessThan(0);
  });

  it('drops the remainder when a new scroll starts', () => {
    const state = createGestureState();
    const px = pixelsPerSlice(5);
    const almost = slowTrackpadScroll(px * 2 - 2);
    expect(slices(run(almost, {}, state))).toBe(0);
    const later = slowTrackpadScroll(4, 5000);
    expect(slices(run(later, {}, state))).toBe(0);
  });

  it('does nothing for a sideways swipe', () => {
    expect(types(run(horizontalSwipe(), { mac: true }))).toEqual(['none']);
  });

  it('changes slice and never pans on a scroll that drifts sideways', () => {
    const actions = run(diagonalScroll(), { mac: true });
    expect(types(actions).includes('pan')).toBe(false);
    expect(slices(actions)).toBe(Math.floor((20 * 9) / pixelsPerSlice(5)));
  });

  it('does not turn a sideways swipe into slices with Shift held', () => {
    const swipe = horizontalSwipe().map((e) => ({ ...e, shiftKey: true }));
    expect(slices(run(swipe, { mac: true }))).toBe(0);
  });
});

describe('two-finger scroll set to pan', () => {
  const pan = { twoFingerScroll: 'pan', mac: true } as const;

  it('moves the image with the fingers on both axes', () => {
    const actions = run(diagonalScroll(), pan);
    expect(types(actions)).toEqual(['pan']);
    const total = actions.reduce((s, a) => (a.type === 'pan' ? [s[0] + a.dx, s[1] + a.dy] : s), [0, 0]);
    expect(total).toEqual([-60, -180]);
  });

  it('changes slice with Shift held', () => {
    const actions = run(macTrackpadScroll(1, { shiftKey: true }), pan);
    expect(slices(actions)).toBe(Math.floor(MAC_TRACKPAD_TOTAL / pixelsPerSlice(5)));
  });
});

describe('pinch', () => {
  it('zooms in continuously as the fingers move apart', () => {
    const actions = run(pinchAsCtrlWheel('out'), { mac: true });
    expect(types(actions)).toEqual(['zoom']);
    expect(actions.every((a) => a.type === 'zoom' && a.factor > 1 && a.factor < 1.05)).toBe(true);
    expect(zoom(actions)).toBeCloseTo(Math.exp(PINCH_TOTAL * 0.01), 6);
  });

  it('zooms out as the fingers move together, by the inverse amount', () => {
    expect(zoom(run(pinchAsCtrlWheel('in'), { mac: true }))).toBeCloseTo(Math.exp(-PINCH_TOTAL * 0.01), 6);
  });

  it('zooms further at a higher zoom speed', () => {
    const fast = zoom(run(pinchAsCtrlWheel('out'), { zoomSpeed: 10 }));
    const slow = zoom(run(pinchAsCtrlWheel('out'), { zoomSpeed: 1 }));
    expect(fast).toBeGreaterThan(Math.exp(PINCH_TOTAL * 0.01));
    expect(slow).toBeLessThan(Math.exp(PINCH_TOTAL * 0.01));
    expect(slow).toBeGreaterThan(1);
  });

  it('does nothing when pinch to zoom is off', () => {
    expect(types(run(pinchAsCtrlWheel('out'), { pinchZoom: false }))).toEqual(['none']);
  });

  it('still zooms with Ctrl and a mouse wheel when pinch to zoom is off', () => {
    expect(types(run(notchedMouse(1, -1, { ctrlKey: true }), { pinchZoom: false }))).toEqual(['zoom']);
  });

  it('turns the scale of a Safari gesture event into a factor since the last one', () => {
    expect(pinchFactor(1, 1.2, 5)).toBeCloseTo(1.2, 6);
    expect(pinchFactor(1.2, 1.5, 5)).toBeCloseTo(1.25, 6);
    expect(pinchFactor(1.5, 0.75, 5)).toBeCloseTo(0.5, 6);
  });

  it('applies the zoom speed to a Safari gesture', () => {
    expect(pinchFactor(1, 1.2, 10)).toBeGreaterThan(1.2);
    expect(pinchFactor(1, 1.2, 1)).toBeLessThan(1.2);
    expect(pinchFactor(1, 1.2, 1)).toBeGreaterThan(1);
  });

  it('ignores a gesture scale that is not a positive number', () => {
    expect(pinchFactor(1, 0, 5)).toBe(1);
    expect(pinchFactor(0, 1.2, 5)).toBe(1);
    expect(pinchFactor(1, NaN, 5)).toBe(1);
  });
});

describe('the 3D view', () => {
  it('zooms on a mouse wheel', () => {
    const actions = run(notchedMouse(2, -1), { pane: '3d' });
    expect(types(actions)).toEqual(['zoom']);
    expect(zoom(actions)).toBeGreaterThan(1);
  });

  it('zooms on a trackpad scroll, in small steps', () => {
    const actions = run(macTrackpadScroll(-1), { pane: '3d', mac: true });
    expect(types(actions)).toEqual(['zoom']);
    expect(actions.every((a) => a.type === 'zoom' && a.factor > 1 && a.factor < 1.1)).toBe(true);
  });

  it('zooms on a pinch', () => {
    expect(zoom(run(pinchAsCtrlWheel('out'), { pane: '3d' }))).toBeGreaterThan(1);
  });

  it('never changes slice, pans or resizes the brush', () => {
    const all = [
      ...run(macTrackpadScroll(), { pane: '3d', twoFingerScroll: 'pan', mac: true }),
      ...run(notchedMouse(2, 1, { altKey: true }), { pane: '3d', brushActive: true }),
    ];
    expect(types(all)).toEqual(['zoom']);
  });
});

describe('Alt and scroll', () => {
  it('makes the brush one step larger per notch up while a brush tool is active', () => {
    const actions = run(notchedMouse(3, -1, { altKey: true }), { brushActive: true });
    expect(actions).toEqual(Array(3).fill({ type: 'brush', steps: 1 }));
  });

  it('makes the brush smaller per notch down', () => {
    expect(run(notchedMouse(1, 1, { altKey: true }), { brushActive: true })).toEqual([{ type: 'brush', steps: -1 }]);
  });

  it('changes the brush in whole steps on a trackpad', () => {
    const actions = run(macTrackpadScroll(-1, { altKey: true }), { brushActive: true, mac: true });
    expect(types(actions).sort()).toEqual(['brush', 'none']);
    const total = actions.reduce((n, a) => n + (a.type === 'brush' ? a.steps : 0), 0);
    expect(total).toBe(Math.floor(MAC_TRACKPAD_TOTAL / 16));
  });

  it('changes slice as usual when no brush tool is active', () => {
    expect(slices(run(notchedMouse(2, 1, { altKey: true })))).toBe(2);
  });
});

describe('speed settings', () => {
  it('needs fewer pixels per slice the faster the trackpad speed', () => {
    expect(pixelsPerSlice(1)).toBe(80);
    expect(pixelsPerSlice(10)).toBe(8);
    expect(pixelsPerSlice(5)).toBeGreaterThan(pixelsPerSlice(6));
  });

  it('clamps a speed outside the range', () => {
    expect(pixelsPerSlice(0)).toBe(80);
    expect(pixelsPerSlice(99)).toBe(8);
    expect(zoomGain(-3)).toBe(zoomGain(1));
  });

  it('has a zoom gain of one in the middle', () => {
    expect(zoomGain(5)).toBe(1);
    expect(zoomGain(10)).toBeGreaterThan(1);
    expect(zoomGain(1)).toBeLessThan(1);
  });
});

describe('zooming about a point', () => {
  it('keeps the point under the pointer where it is', () => {
    // A point at offset d from the centre is drawn at d / scale. After zooming by f the scale is scale / f.
    const focal: [number, number, number] = [10, 20, 30];
    const point: [number, number, number] = [14, 12, 30];
    const scale = 50;
    const f = 1.6;
    const next = zoomAbout(focal, point, f);
    const before = [(point[0] - focal[0]) / scale, (point[1] - focal[1]) / scale];
    const after = [(point[0] - next[0]) / (scale / f), (point[1] - next[1]) / (scale / f)];
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(next[2]).toBe(30);
  });

  it('does not move the view when the pointer is at the centre', () => {
    expect(zoomAbout([1, 2, 3], [1, 2, 3], 2)).toEqual([1, 2, 3]);
  });
});
