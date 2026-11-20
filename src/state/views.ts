import { formatOrder, parseLayout, parseOrder, swapViews, type LayoutId } from '../viewer/layout';
import { getSettings, setSetting } from './settings';
import { get, set, type ViewId } from './store';

/** How the views are arranged. The layout and the order are kept between launches; maximise is not. */

export const currentLayout = (): LayoutId => parseLayout(getSettings().layout);
export const currentOrder = (): ViewId[] => parseOrder(getSettings().viewOrder);

/** Picking a layout also leaves a maximised view, so the choice is what shows. */
export function chooseLayout(layout: LayoutId): void {
  setSetting('layout', layout);
  if (get().maximized) set({ maximized: null });
}

/** Shows `view` where `shown` is. The two trade places, so a view is never on screen twice. */
export function showViewInPlaceOf(shown: ViewId, view: ViewId): void {
  if (shown === view) return;
  setSetting('viewOrder', formatOrder(swapViews(currentOrder(), shown, view)));
  const s = get();
  set({ maximized: s.maximized === shown ? view : s.maximized, activeView: s.activeView === shown ? view : s.activeView });
}

export function toggleMaximise(view: ViewId): void {
  set({ maximized: get().maximized === view ? null : view });
}
