import { create } from 'zustand';
import * as session from '../session';
import { setSetting } from '../state/settings';
import { get, set } from '../state/store';
import { initialTour, stepsFor, tourReducer, type TourEvent, type TourState } from './steps';

export const useTour = create<TourState>(() => initialTour);

/** True once the tour has picked the brush, so it can put the first tool back afterwards. */
let pickedBrush = false;

function dispatch(event: TourEvent): void {
  const next = tourReducer(useTour.getState(), event);
  useTour.setState(next, true);
  if (next.phase === 'end') setSetting('tourSeen', true);
  if (next.phase !== 'steps') return;
  // Bring what the step points at onto the screen.
  switch (stepsFor(next.kind)[next.index].prepare) {
    case 'views':
      set({ maximized: null });
      break;
    case 'panel':
      set({ panelOpen: true });
      break;
    case 'brush':
      if (get().tool !== 'brush' && get().segments.length > 0) {
        session.setTool('brush');
        pickedBrush = true;
      }
      break;
  }
}

export function startTour(): void {
  set({ settings: null, roomModal: null, report: null });
  pickedBrush = false;
  dispatch({ type: 'start', hasImage: !!get().image });
}

/** Opens the built-in sample, then starts the full tour on it. */
export async function tourWithSample(): Promise<void> {
  await session.openSample();
  if (useTour.getState().phase !== 'offer') return;
  if (get().image) dispatch({ type: 'choose', kind: 'full', sample: true });
  else endTour();
}

export const tourWithoutSample = () => dispatch({ type: 'choose', kind: 'short', sample: false });
export const tourNext = () => dispatch({ type: 'next' });
export const tourBack = () => dispatch({ type: 'back' });

/** Finished or skipped: either way it does not come back by itself. */
export function endTour(closeSample = false): void {
  setSetting('tourSeen', true);
  dispatch({ type: 'close' });
  if (pickedBrush && get().image) session.setTool('crosshair');
  pickedBrush = false;
  if (closeSample) session.closeImage();
}
