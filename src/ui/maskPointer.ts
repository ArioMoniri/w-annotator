import { cutsWithOutline, ellipseOutline, rectangleOutline, thinOutline, type Point } from '../mask/scissors';
import { cutOutline, editIslandAt, pickSegmentAt } from '../session';
import { useStore, type ViewId } from '../state/store';

/**
 * Presses on a slice view that the app handles itself, ahead of the viewer's tools:
 * Alt-click picks the segment under the cursor, the scissors' outline (freehand, erase
 * outside, all slices) is drawn here, and the Fill tool's island actions take a click.
 * The outline is drawn over the view in its own layer; the image is never redrawn for it.
 */

const SVG = 'http://www.w3.org/2000/svg';
/** Freehand points closer together than this, in pixels, add nothing. */
const GAP = 1.5;
/** A press that moves less than this, in pixels, is not an outline. */
const SMALLEST = 3;

interface Drag {
  pointer: number;
  shape: 'rectangle' | 'circle' | 'freehand';
  /** In the view's own pixels, for the cut. */
  points: Point[];
  /** How far the view's pixels are from the cell's corner, for drawing. */
  offset: Point;
  layer: SVGSVGElement;
}

/** The points of the outline as it stands. */
function outlineOf(drag: Drag): Point[] {
  const first = drag.points[0];
  const last = drag.points[drag.points.length - 1];
  if (drag.shape === 'rectangle') return rectangleOutline(first, last);
  if (drag.shape === 'circle') return ellipseOutline(first, last);
  return thinOutline(drag.points, GAP);
}

function draw(drag: Drag): void {
  const [ox, oy] = drag.offset;
  const d = outlineOf(drag)
    .map(([x, y], n) => `${n === 0 ? 'M' : 'L'}${(x + ox).toFixed(1)} ${(y + oy).toFixed(1)}`)
    .join('');
  for (const path of drag.layer.querySelectorAll('path')) path.setAttribute('d', d ? `${d}Z` : '');
}

/** Listens on one viewport cell. Returns a function that stops listening. */
export function attachMaskPointer(cell: HTMLElement, view: ViewId): () => void {
  if (view === 'volume3d') return () => {};
  // True from a press the app took until the next press, so the viewer's tools and the click handlers never see it.
  let taken = false;
  let drag: Drag | null = null;

  const surface = () => (cell.querySelector('canvas') ?? cell).getBoundingClientRect();
  const pointIn = (e: { clientX: number; clientY: number }): Point => {
    const rect = surface();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const end = () => {
    if (!drag) return null;
    const done = drag;
    drag = null;
    done.layer.remove();
    window.removeEventListener('keydown', onKey, true);
    if (cell.hasPointerCapture(done.pointer)) cell.releasePointerCapture(done.pointer);
    return done;
  };

  // Esc while drawing drops the outline and nothing else.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    end();
  };

  const onDown = (e: PointerEvent) => {
    taken = false;
    if (e.button !== 0 || !e.isPrimary || (e.target as HTMLElement).closest('button, .menu')) return;
    const s = useStore.getState();
    if (e.altKey) {
      taken = true;
      pickSegmentAt(view, ...pointIn(e));
      return;
    }
    // A locked or hidden segment is refused, with the reason, by the cell itself.
    if (cell.dataset.blocked === 'true' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (s.tool === 'fill' && s.fillAction !== 'fill') {
      taken = true;
      void editIslandAt(view, ...pointIn(e));
      return;
    }
    if (s.tool !== 'scissors' || s.scissorsShape === 'sphere' || !cutsWithOutline(s.scissorsShape, s.scissorsAction, s.scissorsDepth)) return;
    taken = true;
    const rect = surface();
    const box = cell.getBoundingClientRect();
    const layer = document.createElementNS(SVG, 'svg');
    layer.setAttribute('class', 'outline-draw');
    layer.setAttribute('aria-hidden', 'true');
    for (const name of ['under', 'over']) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('class', name);
      layer.append(path);
    }
    cell.append(layer);
    drag = { pointer: e.pointerId, shape: s.scissorsShape, points: [pointIn(e)], offset: [rect.left - box.left, rect.top - box.top], layer };
    cell.setPointerCapture(e.pointerId);
    window.addEventListener('keydown', onKey, true);
  };

  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.points.push(pointIn(e));
    draw(drag);
  };

  const onUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.points.push(pointIn(e));
    const done = end()!;
    const xs = done.points.map((p) => p[0]);
    const ys = done.points.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) < SMALLEST && Math.max(...ys) - Math.min(...ys) < SMALLEST) return;
    void cutOutline(view, outlineOf(done));
  };

  const onCancel = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointer) end();
  };

  // The viewer's tools start on mousedown; a press the app took stops here.
  const swallow = (e: MouseEvent) => {
    if (!taken || e.button !== 0 || (e.target as HTMLElement).closest('button, .menu')) return;
    e.stopPropagation();
    e.preventDefault();
    // The click ends the press.
    if (e.type === 'click') taken = false;
  };

  cell.addEventListener('pointerdown', onDown, true);
  cell.addEventListener('pointermove', onMove);
  cell.addEventListener('pointerup', onUp);
  cell.addEventListener('pointercancel', onCancel);
  cell.addEventListener('mousedown', swallow, true);
  cell.addEventListener('click', swallow, true);
  return () => {
    end();
    cell.removeEventListener('pointerdown', onDown, true);
    cell.removeEventListener('pointermove', onMove);
    cell.removeEventListener('pointerup', onUp);
    cell.removeEventListener('pointercancel', onCancel);
    cell.removeEventListener('mousedown', swallow, true);
    cell.removeEventListener('click', swallow, true);
  };
}
