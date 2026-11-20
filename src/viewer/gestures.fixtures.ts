import type { WheelLike } from './gestures';

/**
 * Wheel event sequences as each kind of device sends them, written out from
 * how the browsers report them. Times are in ms.
 */

type Mods = Partial<Pick<WheelLike, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>>;

function ev(t: number, deltaY: number, more: Partial<WheelLike> = {}): WheelLike {
  return {
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    timeStamp: t,
    ...more,
  };
}

/** Browsers that scroll by pixels report wheelDelta as three times the pixels, the other way. */
const precise = (dy: number) => Math.round(-3 * dy) || 0;

/** A notched mouse in Chromium on Windows or Linux: 100 px and wheelDelta 120 per notch. */
export function notchedMouse(notches: number, direction: 1 | -1 = 1, mods: Mods = {}, start = 1000): WheelLike[] {
  return Array.from({ length: notches }, (_, i) => ev(start + i * 70, 100 * direction, { wheelDeltaY: -120 * direction, ...mods }));
}

/** The same mouse in Firefox: three lines per notch, deltaMode 1. */
export function notchedMouseFirefox(notches: number, direction: 1 | -1 = 1, start = 1000): WheelLike[] {
  return Array.from({ length: notches }, (_, i) => ev(start + i * 70, 3 * direction, { deltaMode: 1 }));
}

/** A notched mouse in Chromium on a Mac: small accelerated pixel deltas, but wheelDelta still counts notches. */
export function notchedMouseMacChromium(direction: 1 | -1 = 1, start = 1000): WheelLike[] {
  const dys = [4.000244140625, 4.000244140625, 12.000732421875, 28.001708984375, 4.000244140625];
  return dys.map((dy, i) => ev(start + i * 60, dy * direction, { wheelDeltaY: -120 * direction }));
}

/** A notched mouse in Safari and WKWebView: the same fractional deltas, wheelDelta three times the pixels. */
export function notchedMouseSafari(direction: 1 | -1 = 1, start = 1000): WheelLike[] {
  const dys = [4.000244140625, 4.000244140625, 12.000732421875, 28.001708984375, 4.000244140625];
  return dys.map((dy, i) => ev(start + i * 60, dy * direction, { wheelDeltaY: precise(dy * direction) }));
}

/**
 * A notched mouse in WebKitGTK, recorded from the built app under Xvfb with real
 * X11 wheel clicks: 86 px and wheelDelta 120 per notch. With Shift the notch
 * arrives sideways and wheelDeltaY is 0.
 */
export function notchedMouseWebKitGtk(notches: number, direction: 1 | -1 = 1, mods: Mods = {}, start = 1000): WheelLike[] {
  return Array.from({ length: notches }, (_, i) =>
    mods.shiftKey
      ? ev(start + i * 120, 0, { deltaX: 86 * direction, wheelDeltaY: 0, ...mods })
      : ev(start + i * 120, 86 * direction, { wheelDeltaY: -120 * direction, ...mods }),
  );
}

const TRACKPAD_DRAG = [1, 1, 2, 3, 5, 7, 9, 11, 12, 12, 11, 10, 9, 9, 8];
const MOMENTUM = [8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
const JITTER_X = [0, 1, 0, 0, -1, 0, 1, 1, 0, 0, -1, 0, 0, 1, 0];

/**
 * Two fingers down a Mac trackpad: a stream of small whole-pixel deltas every
 * frame, a little sideways drift, then momentum after the fingers lift.
 */
export function macTrackpadScroll(direction: 1 | -1 = 1, mods: Mods = {}, start = 1000): WheelLike[] {
  const out: WheelLike[] = [];
  let t = start;
  TRACKPAD_DRAG.forEach((dy, i) => {
    out.push(ev(t, dy * direction, { deltaX: JITTER_X[i], wheelDeltaY: precise(dy * direction), ...mods }));
    t += 16;
  });
  for (const dy of MOMENTUM) {
    out.push(ev(t, dy * direction, { wheelDeltaY: precise(dy * direction), ...mods }));
    t += 16;
  }
  return out;
}

/** Pixels travelled by `macTrackpadScroll`, momentum included. */
export const MAC_TRACKPAD_TOTAL = [...TRACKPAD_DRAG, ...MOMENTUM].reduce((a, b) => a + b, 0);

/** The slow start of a scroll: every event is under one pixel. */
export function slowTrackpadScroll(count: number, start = 1000): WheelLike[] {
  return Array.from({ length: count }, (_, i) => ev(start + i * 16, 0.5, { wheelDeltaY: precise(0.5) }));
}

/** A Magic Mouse: scrolls like a trackpad, with more sideways drift from the finger. */
export function magicMouseScroll(direction: 1 | -1 = 1, start = 1000): WheelLike[] {
  const dys = [1, 2, 4, 6, 9, 12, 14, 13, 11, 9, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1, 1];
  const dxs = [0, 1, 1, 2, 2, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return dys.map((dy, i) => ev(start + i * 16, dy * direction, { deltaX: dxs[i], wheelDeltaY: precise(dy * direction) }));
}

/** Pixels travelled by `magicMouseScroll`. */
export const MAGIC_MOUSE_TOTAL = 116;

/**
 * A Windows precision touchpad in Chromium (WebView2) at 125% display
 * scaling: fractional pixel deltas, some of them large, with inertia.
 */
export function precisionTouchpadScroll(direction: 1 | -1 = 1, start = 1000): WheelLike[] {
  const dys = [0.8, 2.4, 5.6, 8.8, 16.8, 24.8, 36, 44.8, 52, 48.8, 40, 32.8, 24, 17.6, 12, 8.8, 5.6, 3.2, 1.6, 0.8];
  return dys.map((dy, i) => ev(start + i * 8, dy * direction, { wheelDeltaY: precise(dy * direction) }));
}

/** Pixels travelled by `precisionTouchpadScroll`. */
export const PRECISION_TOUCHPAD_TOTAL = 387.2;

/** A swipe sideways with two fingers, the gesture browsers use for "back". */
export function horizontalSwipe(start = 1000): WheelLike[] {
  const dxs = [2, 5, 9, 14, 18, 16, 12, 9, 6, 4, 2, 1];
  const dys = [0, 1, 0, -1, 1, 0, 0, 1, 0, 0, 0, 0];
  return dxs.map((dx, i) => ev(start + i * 16, dys[i], { deltaX: dx, wheelDeltaY: precise(dys[i]) }));
}

/** A scroll that drifts: mostly down, a third as much to the right. */
export function diagonalScroll(start = 1000): WheelLike[] {
  return Array.from({ length: 20 }, (_, i) => ev(start + i * 16, 9, { deltaX: 3, wheelDeltaY: -27 }));
}

/**
 * Pinch on a trackpad in Chromium and Firefox: wheel events with ctrlKey set
 * and small fractional deltas. Fingers apart gives negative deltas.
 */
export function pinchAsCtrlWheel(direction: 'out' | 'in', start = 1000): WheelLike[] {
  const dys = [0.4, 0.9, 1.6, 2.3, 3.1, 3.4, 2.8, 2.2, 1.5, 0.9, 0.5, 0.4];
  const sign = direction === 'out' ? -1 : 1;
  return dys.map((dy, i) => ev(start + i * 16, dy * sign, { ctrlKey: true, wheelDeltaY: precise(dy * sign) }));
}

/** Sum of the deltas in `pinchAsCtrlWheel`, without the sign. */
export const PINCH_TOTAL = 20;
