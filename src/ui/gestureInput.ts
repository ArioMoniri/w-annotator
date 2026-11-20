import { setBrushSize } from '../session';
import { getSettings } from '../state/settings';
import { useStore, type ViewId } from '../state/store';
import * as engine from '../viewer/engine';
import { createGestureState, pinchFactor, wheelAction, type GestureAction } from '../viewer/gestures';
import { isMac } from './common';

/**
 * Wheel, trackpad and pinch input for the viewports. This is the only place
 * that listens for them: Cornerstone's own wheel tools are not bound, because
 * they move one slice per event, which suits a mouse and nothing else.
 */

const BRUSH_TOOLS = ['brush', 'eraser', 'threshold'];

/** Safari and WKWebView report a pinch with these instead of wheel events. */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

function apply(view: ViewId, action: GestureAction, at: [number, number]): void {
  switch (action.type) {
    case 'slice':
      engine.scrollSlices(view, action.steps);
      break;
    case 'zoom':
      engine.zoomBy(view, action.factor, at);
      break;
    case 'pan':
      engine.panBy(view, action.dx, action.dy);
      break;
    case 'brush': {
      // The same steps as the bracket keys: 1 mm up to 10 mm, then 2 mm.
      let size = useStore.getState().brushSize;
      for (let i = 0; i < Math.abs(action.steps); i++) size += action.steps > 0 ? (size >= 10 ? 2 : 1) : -(size > 10 ? 2 : 1);
      setBrushSize(size);
      break;
    }
    case 'none':
      break;
  }
}

/** Listens on one viewport cell. Returns a function that stops listening. */
export function attachViewportGestures(cell: HTMLElement, view: ViewId): () => void {
  const state = createGestureState();
  const pointIn = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = cell.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onWheel = (e: WheelEvent) => {
    // Always ours: the page must never scroll, zoom or go back because of a gesture over the image.
    e.preventDefault();
    e.stopPropagation();
    const s = getSettings();
    const action = wheelAction(state, e as WheelEvent & { wheelDeltaY?: number }, {
      scrollDirection: s.scrollDirection,
      trackpadSpeed: s.trackpadSpeed,
      twoFingerScroll: s.twoFingerScroll,
      pinchZoom: s.pinchZoom,
      wheelZooms: s.wheelZooms,
      zoomSpeed: s.zoomSpeed,
      pane: view === 'volume3d' ? '3d' : 'slice',
      brushActive: BRUSH_TOOLS.includes(useStore.getState().tool),
      mac: isMac,
    });
    apply(view, action, pointIn(e));
  };

  let scale = 1;
  const onGesture = (evt: Event) => {
    const e = evt as GestureEvent;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'gesturestart') scale = e.scale > 0 ? e.scale : 1;
    if (e.type !== 'gesturechange') return;
    const s = getSettings();
    const factor = pinchFactor(scale, e.scale, s.zoomSpeed);
    if (e.scale > 0) scale = e.scale;
    if (s.pinchZoom) apply(view, { type: 'zoom', factor }, pointIn(e));
  };

  // Capture, so the event is handled here before anything inside the cell sees it.
  const wheel = { capture: true, passive: false } as const;
  cell.addEventListener('wheel', onWheel, wheel);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) cell.addEventListener(type, onGesture, wheel);
  return () => {
    cell.removeEventListener('wheel', onWheel, wheel);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) cell.removeEventListener(type, onGesture, wheel);
  };
}

/**
 * Keeps the webview itself still everywhere in the window: no page zoom from a
 * pinch or Ctrl+wheel, on the image or beside it. Lists and panels still scroll.
 */
export function guardPageGestures(target: Pick<Window, 'addEventListener'> = window): void {
  target.addEventListener(
    'wheel',
    (e) => {
      if ((e as WheelEvent).ctrlKey) e.preventDefault();
    },
    { capture: true, passive: false },
  );
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    target.addEventListener(type, (e) => e.preventDefault(), { capture: true, passive: false });
  }
}
