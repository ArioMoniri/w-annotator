import type { Types } from '@cornerstonejs/core';
import { CrosshairsTool } from '@cornerstonejs/tools';
import { clipSegment } from './layout';

/** How far from a view's edge the reference lines stop, so they never run under the orientation letters. */
export const LINE_EDGE_INSET = 28;
/** Half the width of the gap the lines leave at the point where they would cross. */
export const LINE_CENTRE_GAP = 24;

type RenderAnnotation = CrosshairsTool['renderAnnotation'];
type DrawingHelper = Parameters<RenderAnnotation>[1];

/**
 * Cornerstone's crosshairs, kept to what a mask editor needs: each plane shows where the
 * other two planes cut it, and dragging a line scrolls that plane. The planes stay
 * orthogonal. Rotating a line would reslice obliquely, which makes left and right easy to
 * mistake, so the rotation handles are neither drawn nor grabbable.
 */
export class LinkedLinesTool extends CrosshairsTool {
  static toolName = 'LinkedLines';

  constructor(...args: ConstructorParameters<typeof CrosshairsTool>) {
    super(...args);
    const draw = this.renderAnnotation;
    this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
      const drawn = draw(enabledElement, svgDrawingHelper);
      this.trimLines(enabledElement, svgDrawingHelper);
      return drawn;
    };
  }

  /** No line can be rotated. */
  override _getRotationHandleNearImagePoint(): null {
    return null;
  }

  /** Shortens the lines just drawn so they end before the edge of the view. */
  private trimLines(enabledElement: Types.IEnabledElement, helper: DrawingHelper): void {
    const { viewport } = enabledElement;
    const own = this._getAnnotations(enabledElement).find((a) => (a.data as { viewportId?: string }).viewportId === viewport.id);
    if (!own?.annotationUID) return;
    const { clientWidth, clientHeight } = viewport.canvas;
    const box = {
      x: LINE_EDGE_INSET,
      y: LINE_EDGE_INSET,
      w: clientWidth - 2 * LINE_EDGE_INSET,
      h: clientHeight - 2 * LINE_EDGE_INSET,
    };
    // One line per other plane, drawn whole or as two halves either side of the gap.
    for (let index = 0; index < 3; index++) {
      for (const part of ['', 'One', 'Two']) {
        const node = helper.getSvgNode(`${own.annotationUID}::line::${index}${part}`) as SVGLineElement | undefined;
        if (!node) continue;
        const num = (name: string) => Number(node.getAttribute(name));
        const a: [number, number] = [num('x1'), num('y1')];
        const kept = clipSegment(a, [num('x2'), num('y2')], box) ?? [a, a];
        node.setAttribute('x1', `${kept[0][0]}`);
        node.setAttribute('y1', `${kept[0][1]}`);
        node.setAttribute('x2', `${kept[1][0]}`);
        node.setAttribute('y2', `${kept[1][1]}`);
      }
    }
  }
}
