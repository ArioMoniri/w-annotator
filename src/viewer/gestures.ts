/**
 * Turns wheel and pinch input into what the viewer should do. Pure: no DOM,
 * no Cornerstone. `src/viewer/input.ts` feeds it events and applies the result.
 *
 * A mouse wheel sends one event per notch. A trackpad sends a stream of small
 * pixel deltas, 60 to 120 a second, and keeps sending them as momentum after
 * the fingers lift. The two need different handling: a notch is one step, a
 * trackpad stream is a distance.
 */

/** The parts of a WheelEvent that matter here. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Milliseconds; only differences are used. */
  timeStamp: number;
  /** Legacy field, still sent by every engine. Counts notches for a real wheel in Chromium. */
  wheelDeltaY?: number;
}

export type Device = 'mouse' | 'trackpad';

export interface GestureOptions {
  /** Natural follows the system: scrolling down goes to the next slice. */
  scrollDirection: 'natural' | 'reversed';
  /** 1 (slow) to 10 (fast). */
  trackpadSpeed: number;
  twoFingerScroll: 'slice' | 'pan';
  pinchZoom: boolean;
  /** A plain mouse wheel zooms, and Ctrl/Cmd+wheel changes slice. */
  wheelZooms: boolean;
  /** 1 (slow) to 10 (fast). */
  zoomSpeed: number;
  /** A slice view, or the 3D view where every scroll is a zoom. */
  pane: 'slice' | '3d';
  /** A brush tool is selected, so Alt+scroll changes its size. */
  brushActive: boolean;
  /** Running on a Mac, where a notched mouse sends small fractional pixel deltas. */
  mac: boolean;
}

export type GestureAction =
  | { type: 'none' }
  | { type: 'slice'; steps: number }
  /** Multiply the zoom by `factor`, about the pointer. */
  | { type: 'zoom'; factor: number }
  /** Move the image by this many canvas pixels. */
  | { type: 'pan'; dx: number; dy: number }
  /** Positive is larger. */
  | { type: 'brush'; steps: number };

export interface GestureState {
  lastTime: number;
  lastDevice: Device | null;
  /** Which way the current trackpad scroll is going, once that is clear. */
  axis: 'x' | 'y' | null;
  weightX: number;
  weightY: number;
  /** Vertical pixels seen before the axis was clear. */
  pending: number;
  /** Pixels not yet spent on a whole slice. */
  slicePixels: number;
  /** Pixels not yet spent on a whole brush step. */
  brushPixels: number;
}

export function createGestureState(): GestureState {
  return { lastTime: -Infinity, lastDevice: null, axis: null, weightX: 0, weightY: 0, pending: 0, slicePixels: 0, brushPixels: 0 };
}

/** A pause this long ends a trackpad scroll; the next event starts a new one. */
const STREAM_GAP_MS = 250;
/** Longest gap between two events of one trackpad scroll, for telling its large deltas from wheel notches. */
const STICKY_MS = 100;
/** With nothing else to go on, a lone delta at least this large is a wheel notch. */
const NOTCH_PIXELS = 50;
/** Movement needed before deciding whether a scroll is vertical or sideways. */
const AXIS_PIXELS = 3;
const FAST = 5;
const BRUSH_PIXELS = 16;
/** Zoom per mouse notch, per pinch pixel and per scrolled pixel, as exponents. */
const NOTCH_ZOOM = 0.1;
const PINCH_ZOOM = 0.01;
const SCROLL_ZOOM = 0.005;

const NONE: GestureAction = { type: 'none' };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const whole = (v: number) => Number.isInteger(v);

/** Pixels of trackpad travel for one slice: 80 at speed 1 down to 8 at speed 10. */
export function pixelsPerSlice(speed: number): number {
  return Math.round(80 * Math.pow(0.1, (clamp(speed, 1, 10) - 1) / 9));
}

/** Multiplier for every zoom gesture: 1 at speed 5, about a third at 1, four at 10. */
export function zoomGain(speed: number): number {
  return Math.pow(2, (clamp(speed, 1, 10) - 5) / 2.5);
}

/**
 * Mouse wheel or trackpad. The engines disagree on what a notch looks like,
 * so several signs are checked, most reliable first.
 */
export function classifyWheel(state: GestureState, e: WheelLike, mac: boolean): Device {
  // Lines or pages: only real wheels (Firefox) report these.
  if (e.deltaMode !== 0) return 'mouse';
  const dy = e.deltaY;
  const wd = e.wheelDeltaY;
  // Pixel-precise devices report wheelDelta as -3 × pixels.
  const precise = wd !== undefined && wd !== 0 && Math.abs(wd + 3 * dy) <= 3;
  // Chromium and WebKitGTK report ±120 per notch for a real wheel, whatever the pixel delta.
  if (wd !== undefined && wd !== 0 && !precise && wd % 120 === 0) return 'mouse';
  // Trackpad events arrive every frame, so anything this soon after one belongs to the same scroll.
  const inStream = state.lastDevice === 'trackpad' && e.timeStamp - state.lastTime < STICKY_MS;
  if (inStream) return 'trackpad';
  // WebKit on a Mac reports a notched mouse like a trackpad, but its deltas are fractional
  // (4.0002, 12.0007) where a trackpad's are whole pixels. A pinch is fractional too, and exempt.
  if (mac && !e.ctrlKey && e.deltaX === 0 && Math.abs(dy) >= 3 && !whole(dy)) return 'mouse';
  // With nothing else to go on, a large lone delta is a notch.
  if (!precise && e.deltaX === 0 && Math.abs(dy) >= NOTCH_PIXELS) return 'mouse';
  return 'trackpad';
}

/**
 * Shift+wheel arrives as a sideways scroll in some browsers. Turn it back, but
 * only for a wheel: a sideways trackpad swipe with Shift held stays sideways.
 */
function unswapShift(state: GestureState, e: WheelLike, mac: boolean): WheelLike {
  if (!e.shiftKey || e.deltaY !== 0 || e.deltaX === 0) return e;
  const turned = { ...e, deltaY: e.deltaX, deltaX: 0, wheelDeltaY: undefined };
  return classifyWheel(state, turned, mac) === 'mouse' ? turned : e;
}

/** A plain copy. A DOM event keeps its fields on the prototype, so spreading one would lose them. */
function plain(e: WheelLike): WheelLike {
  return {
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaMode: e.deltaMode,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    timeStamp: e.timeStamp,
    wheelDeltaY: e.wheelDeltaY,
  };
}

/** Whole steps out of an accumulated distance; what is left stays in the accumulator. */
function take(total: number, per: number): [steps: number, left: number] {
  const steps = Math.trunc(total / per);
  return [steps, total - steps * per];
}

/** The vertical part of a trackpad event, or 0 while the scroll is sideways or undecided. */
function lockedVertical(state: GestureState, e: WheelLike): number {
  // Recent movement counts for more once the direction is known; before that, all of it counts.
  const keep = state.axis ? 0.8 : 1;
  state.weightX = state.weightX * keep + Math.abs(e.deltaX);
  state.weightY = state.weightY * keep + Math.abs(e.deltaY);
  if (!state.axis) {
    if (state.weightX + state.weightY < AXIS_PIXELS) {
      state.pending += e.deltaY;
      return 0;
    }
    state.axis = state.weightY >= state.weightX ? 'y' : 'x';
    const dy = state.axis === 'y' ? state.pending + e.deltaY : 0;
    state.pending = 0;
    return dy;
  }
  // A scroll can turn, but only when the other direction clearly takes over.
  if (state.axis === 'x' && state.weightY > 2 * state.weightX) state.axis = 'y';
  else if (state.axis === 'y' && state.weightX > 2 * state.weightY) state.axis = 'x';
  return state.axis === 'y' ? e.deltaY : 0;
}

/** What one wheel event should do. Call it for every event, in order, with the same state. */
export function wheelAction(state: GestureState, raw: WheelLike, o: GestureOptions): GestureAction {
  const e = unswapShift(state, plain(raw), o.mac);
  const device = classifyWheel(state, e, o.mac);
  if (e.timeStamp - state.lastTime > STREAM_GAP_MS || device !== state.lastDevice) {
    state.axis = null;
    state.weightX = state.weightY = state.pending = state.slicePixels = state.brushPixels = 0;
  }
  state.lastTime = e.timeStamp;
  state.lastDevice = device;

  const gain = zoomGain(o.zoomSpeed);
  const mod = e.ctrlKey || e.metaKey;
  const sign = Math.sign(e.deltaY);
  const direction = o.scrollDirection === 'reversed' ? -1 : 1;

  if (device === 'mouse') {
    if (sign === 0) return NONE;
    const zooms = o.pane === '3d' || mod !== o.wheelZooms;
    if (zooms) return { type: 'zoom', factor: Math.exp(-sign * NOTCH_ZOOM * gain) };
    if (e.altKey && o.brushActive) return { type: 'brush', steps: -sign };
    return { type: 'slice', steps: sign * direction * (e.shiftKey ? FAST : 1) };
  }

  // Ctrl with trackpad deltas is how Chromium and Firefox report a pinch.
  if (e.ctrlKey) {
    if (!o.pinchZoom || e.deltaY === 0) return NONE;
    return { type: 'zoom', factor: Math.exp(-e.deltaY * PINCH_ZOOM * gain) };
  }
  if (e.metaKey || o.pane === '3d') {
    return e.deltaY === 0 ? NONE : { type: 'zoom', factor: Math.exp(-e.deltaY * SCROLL_ZOOM * gain) };
  }
  if (o.twoFingerScroll === 'pan' && !e.shiftKey && !(e.altKey && o.brushActive)) {
    return e.deltaX === 0 && e.deltaY === 0 ? NONE : { type: 'pan', dx: -e.deltaX || 0, dy: -e.deltaY || 0 };
  }

  const dy = lockedVertical(state, e);
  if (e.altKey && o.brushActive) {
    const [steps, left] = take(state.brushPixels - dy, BRUSH_PIXELS);
    state.brushPixels = left;
    return steps ? { type: 'brush', steps } : NONE;
  }
  // In pan mode Shift is what asks for slices, so it does not also mean "fast".
  const fast = e.shiftKey && o.twoFingerScroll !== 'pan' ? FAST : 1;
  const [steps, left] = take(state.slicePixels + dy * direction * fast, pixelsPerSlice(o.trackpadSpeed));
  state.slicePixels = left;
  return steps ? { type: 'slice', steps } : NONE;
}

/**
 * Safari and WKWebView report a pinch as gesture events whose `scale` grows
 * from 1 over the whole gesture. This is the zoom factor since the last event.
 */
export function pinchFactor(previousScale: number, scale: number, zoomSpeed: number): number {
  if (!(previousScale > 0) || !(scale > 0) || !Number.isFinite(scale / previousScale)) return 1;
  return Math.pow(scale / previousScale, zoomGain(zoomSpeed));
}

type Point3 = [number, number, number];

/**
 * Where the centre of an orthographic view must move so that `point` stays at
 * the same place on screen when the view is magnified by `factor`.
 */
export function zoomAbout(focal: Point3, point: Point3, factor: number): Point3 {
  return [0, 1, 2].map((i) => point[i] + (focal[i] - point[i]) / factor) as Point3;
}
