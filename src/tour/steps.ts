/**
 * The welcome tour as data and plain functions: what each step says and points
 * at, how the tour moves between steps, and where the card goes. Nothing here
 * touches the DOM, so it is all unit-tested.
 */

export type HintId = 'scroll' | 'brush' | 'slices' | 'cursors';
export type Side = 'right' | 'left' | 'bottom' | 'top';

export interface TourStep {
  id: string;
  /** `data-tour` names. The cut-out surrounds all that are on screen. */
  targets: string[];
  /** At most 4 words. */
  title: string;
  /** One sentence, at most 18 words. */
  body: string;
  hint?: HintId;
  /** Something the app must show first, e.g. the brush and its options. */
  prepare?: 'views' | 'brush' | 'panel';
  /** Sides to try first for the card. */
  prefer?: Side[];
}

export const FULL_STEPS: TourStep[] = [
  {
    id: 'views',
    targets: ['views'],
    title: 'Four views',
    body: 'Scroll over a view to move through slices, and double-click to enlarge it.',
    hint: 'scroll',
    prepare: 'views',
  },
  {
    id: 'tools',
    targets: ['tools'],
    title: 'Tools',
    body: 'The upper tools move around the image, and the lower ones edit the mask.',
    prefer: ['right'],
  },
  {
    id: 'brush',
    targets: ['brush'],
    title: 'Brush',
    body: 'Pick the brush, then drag on any slice to paint the selected segment.',
    hint: 'brush',
    prepare: 'brush',
    prefer: ['right'],
  },
  {
    id: 'options',
    targets: ['options'],
    title: 'Brush options',
    body: 'Set the size and shape here, and hold Shift while dragging to erase.',
    prepare: 'brush',
    prefer: ['bottom'],
  },
  {
    id: 'interpolate',
    targets: ['interpolate'],
    title: 'Fill between slices',
    body: 'Paint every few slices, then use this to fill the gaps between them.',
    hint: 'slices',
    prepare: 'brush',
    prefer: ['bottom'],
  },
  {
    id: 'segments',
    targets: ['segments'],
    title: 'Segments',
    body: 'Click a row to select it, double-click to rename, and use its buttons to hide, lock and more.',
    prepare: 'panel',
    prefer: ['left'],
  },
  {
    id: 'undo',
    targets: ['undo', 'redo'],
    title: 'Undo and redo',
    body: 'Each stroke is one step, so you can always go back.',
    prefer: ['right'],
  },
  {
    id: 'save',
    targets: ['file'],
    title: 'Save the mask',
    body: 'Save from this menu as NIfTI, MetaImage, NRRD or DICOM SEG.',
    prefer: ['bottom'],
  },
  {
    id: 'share',
    targets: ['share'],
    title: 'Work together',
    body: 'Start a room and send the invite, so others can edit the same mask with you.',
    hint: 'cursors',
    prefer: ['bottom'],
  },
  {
    id: 'shortcuts',
    targets: ['shortcuts'],
    title: 'Settings and shortcuts',
    body: 'Press ? to see or change any shortcut, and open Settings here or from the file menu.',
    prefer: ['right'],
  },
];

export const SHORT_STEPS: TourStep[] = [
  {
    id: 'drop',
    targets: ['drop'],
    title: 'Open an image',
    body: 'Drop an image here, with a mask if you have one, or use the buttons.',
    prefer: ['right', 'bottom'],
  },
  {
    id: 'join',
    targets: ['join'],
    title: 'Join a room',
    body: 'Paste an invite link to work on a mask with someone else.',
    hint: 'cursors',
    prefer: ['bottom', 'top'],
  },
  {
    id: 'settings',
    targets: ['settings'],
    title: 'Settings',
    body: 'Set your name, appearance and shortcuts here, and replay this tour at any time.',
    prefer: ['bottom', 'top'],
  },
];

export type TourKind = 'full' | 'short';

export const stepsFor = (kind: TourKind): TourStep[] => (kind === 'full' ? FULL_STEPS : SHORT_STEPS);

/** The tour runs on a first launch unless the address says `?tour=0`. */
export function shouldShowTour(tourSeen: boolean, search: string): boolean {
  if (tourSeen) return false;
  return new URLSearchParams(search).get('tour') !== '0';
}

export interface TourState {
  phase: 'off' | 'offer' | 'steps' | 'end';
  kind: TourKind;
  index: number;
  /** True when the tour opened the sample, so the end card can offer to close it. */
  sample: boolean;
}

export const initialTour: TourState = { phase: 'off', kind: 'short', index: 0, sample: false };

export type TourEvent =
  | { type: 'start'; hasImage: boolean }
  | { type: 'choose'; kind: TourKind; sample: boolean }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'close' };

export function tourReducer(state: TourState, event: TourEvent): TourState {
  switch (event.type) {
    case 'start':
      return event.hasImage ? { phase: 'steps', kind: 'full', index: 0, sample: false } : { ...initialTour, phase: 'offer' };
    case 'choose':
      return { phase: 'steps', kind: event.kind, index: 0, sample: event.sample };
    case 'next':
      if (state.phase !== 'steps') return state;
      return state.index + 1 < stepsFor(state.kind).length ? { ...state, index: state.index + 1 } : { ...state, phase: 'end' };
    case 'back':
      if (state.phase === 'end') return { ...state, phase: 'steps', index: stepsFor(state.kind).length - 1 };
      if (state.phase !== 'steps' || state.index === 0) return state;
      return { ...state, index: state.index - 1 };
    case 'close':
      return initialTour;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** The hole in the dimming layer: the target with some air around it, clipped to the window. */
export function cutout(target: Rect, view: Size, pad = 6): Rect {
  const x = Math.max(0, target.x - pad);
  const y = Math.max(0, target.y - pad);
  const right = Math.min(view.w, target.x + target.w + pad);
  const bottom = Math.min(view.h, target.y + target.h + pad);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Top-left corner for the card. It goes on the first side of the target with
 * room for it, or failing that the side with the most room, and is then pulled
 * back inside the window, so it is always fully visible.
 */
export function placeCard(
  target: Rect | null,
  card: Size,
  view: Size,
  prefer: Side[] = [],
  gap = 12,
  margin = 12,
): { x: number; y: number } {
  if (!target) return { x: Math.round((view.w - card.w) / 2), y: Math.round((view.h - card.h) / 2) };
  const free: Record<Side, number> = {
    right: view.w - (target.x + target.w),
    left: target.x,
    bottom: view.h - (target.y + target.h),
    top: target.y,
  };
  const needs: Record<Side, number> = {
    right: card.w + gap + margin,
    left: card.w + gap + margin,
    bottom: card.h + gap + margin,
    top: card.h + gap + margin,
  };
  const order = [...prefer, ...(['right', 'left', 'bottom', 'top'] as Side[]).filter((s) => !prefer.includes(s))];
  const side = order.find((s) => free[s] >= needs[s]) ?? order.reduce((best, s) => (free[s] - needs[s] > free[best] - needs[best] ? s : best));

  // Along the other axis: centred on a small target, level with the start of a large one.
  const along = (start: number, length: number, size: number) => (length < size ? start + length / 2 - size / 2 : start);
  let x: number;
  let y: number;
  if (side === 'right' || side === 'left') {
    x = side === 'right' ? target.x + target.w + gap : target.x - gap - card.w;
    y = along(target.y, target.h, card.h);
  } else {
    y = side === 'bottom' ? target.y + target.h + gap : target.y - gap - card.h;
    x = along(target.x, target.w, card.w);
  }
  return {
    x: Math.round(clamp(x, margin, view.w - margin - card.w)),
    y: Math.round(clamp(y, margin, view.h - margin - card.h)),
  };
}
