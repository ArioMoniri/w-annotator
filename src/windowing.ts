import { sliceAxisFor } from './mask/interpolate';
import { getImage, setVoi } from './session';
import { getSettings, setSetting } from './state/settings';
import { get, set, toast, type ViewId } from './state/store';
import * as engine from './viewer/engine';
import {
  actualSizeFactor,
  boxValues,
  nudgeWindow,
  percentileWindow,
  presetNameError,
  stepChoice,
  windowSetFor,
  windowChoices,
  withPreset,
  type WindowChoice,
  type WindowSet,
} from './viewer/window';

/**
 * What the window and zoom controls do. Window and zoom are how one person looks at the
 * image: nothing here changes a voxel, and nothing here is sent to a room.
 */

/** The preset list in use: the one asked for, or the one that suits the image's values. */
export function currentWindowSet(): WindowSet {
  const s = get();
  return s.image ? windowSetFor(s.image, s.windowSet) : (s.windowSet ?? 'mr');
}

/** Every window on offer for the open image, in menu order. */
export function currentChoices(): WindowChoice[] {
  const image = get().image;
  return image ? windowChoices(image, getSettings().windowPresets, currentWindowSet()) : [];
}

export function applyWindowChoice(choice: WindowChoice): void {
  setVoi(choice.voi.lower, choice.voi.upper);
}

/** Shows the CT presets or the ones worked out from the image. The window on screen stays. */
export function setWindowSet(windowSet: WindowSet): void {
  set({ windowSet });
}

/** Goes to the next preset, or the one before. */
export function stepWindowPreset(step: 1 | -1): void {
  const voi = get().voi;
  if (!voi) return;
  const next = stepChoice(currentChoices(), voi, step);
  if (next) applyWindowChoice(next);
}

/** Brighter or darker (`dl`), more or less contrast (`dw`), in shares of the window's width. */
export function nudgeCurrentWindow(dw: number, dl: number): void {
  const voi = get().voi;
  if (!voi) return;
  const next = nudgeWindow(voi, dw, dl);
  setVoi(next.lower, next.upper);
}

/** One press of a brightness or contrast key. */
export const LEVEL_STEP = 0.05;
export const WIDTH_STEP = 0.1;

/**
 * Saves the window on screen under `name`. Returns why not, as a sentence, or '' when saved.
 */
export function saveWindowPreset(name: string): string {
  const voi = get().voi;
  if (!voi) return '';
  const custom = getSettings().windowPresets;
  const problem = presetNameError(name, custom);
  if (problem) return problem;
  setSetting('windowPresets', withPreset(custom, name, voi));
  return '';
}

export function removeWindowPreset(name: string): void {
  setSetting(
    'windowPresets',
    getSettings().windowPresets.filter((p) => p.name !== name),
  );
}

/**
 * Sets the window from the image values under a box drawn on a slice view, given by two
 * corners in the view's pixels: from the 1st to the 99th percentile of what is inside.
 */
export function windowFromBox(view: ViewId, a: [number, number], b: [number, number]): void {
  const image = getImage();
  const frame = view === 'volume3d' ? null : engine.viewFrame(view);
  if (!image || !frame) return;
  const voi = percentileWindow(boxValues(image, frame, a, b));
  if (!voi) {
    toast('info', 'Drag the box over the image to set the window from it.');
    return;
  }
  setVoi(voi.lower, voi.upper);
}

/** The view that zoom buttons and keys act on. */
const zoomView = (): ViewId => get().activeView;

/** One press of a zoom key or button. */
const ZOOM_STEP = 1.25;

/** Zooms the active view about its centre. */
export function zoomActive(direction: 1 | -1): void {
  engine.zoomBy(zoomView(), direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
}

/** Shows the active slice view with one voxel per screen pixel, about its centre. */
export function zoomActualSize(): void {
  const view = zoomView();
  const image = getImage();
  if (!image || view === 'volume3d') return;
  const frame = engine.viewFrame(view);
  if (!frame) return;
  const axis = sliceAxisFor(image.direction, view);
  const inPlane = [0, 1, 2].filter((x) => x !== axis).map((x) => image.spacing[x]) as [number, number];
  engine.zoomBy(view, actualSizeFactor(Math.hypot(frame.right[0], frame.right[1], frame.right[2]), inPlane));
}
