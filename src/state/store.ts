import { create } from 'zustand';
import type { Role, RoomKind, SegmentInfo } from '../collab/protocol';
import type { SegmentStats } from '../mask/ops';
import type { MaskRow } from '../mask/collection';
import type { PaintOver } from '../mask/paintOver';
import type { ScissorsAction, ScissorsDepth, ScissorsShape } from '../mask/scissors';
import type { MrWindows, Voi, WindowSet } from '../viewer/window';

export type ToolId =
  | 'crosshair'
  | 'pan'
  | 'zoom'
  | 'window'
  | 'measure'
  | 'brush'
  | 'eraser'
  | 'threshold'
  | 'scissors'
  | 'fill';

export const EDIT_TOOLS: ToolId[] = ['brush', 'eraser', 'threshold', 'scissors', 'fill'];

export type SettingsSection = 'profile' | 'appearance' | 'mouse' | 'shortcuts' | 'files' | 'help';

export type ViewId = 'axial' | 'sagittal' | 'coronal' | 'volume3d';

export const SEGMENT_COLORS = [
  '#E69F00', '#56B4E9', '#F0E442', '#EE3377', '#009E73', '#B58CFF',
  '#D55E00', '#00D5C8', '#FFAABB', '#3D85F0', '#BBCC33', '#CC79A7',
];

/** Names for SEGMENT_COLORS, in the same order (DESIGN.md 3.1). */
export const SEGMENT_COLOR_NAMES = [
  'Orange', 'Sky', 'Yellow', 'Magenta', 'Green', 'Violet',
  'Vermilion', 'Aqua', 'Pink', 'Blue', 'Lime', 'Mauve',
];

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  action?: { label: string; run: () => void };
  /** Set while the toast fades out, just before it is removed. */
  leaving?: boolean;
}

export interface Peer {
  id: number;
  name: string;
  color: string;
  role: Role;
  cursor?: { vp: ViewId; w: [number, number, number]; r?: number };
  /** View through host, on the host's side: how many planes this guest has been sent. */
  seen?: number;
  /** For the host: this person's app follows a change of role. An older app does not, and is not offered one. */
  roles?: boolean;
}

/** What a merge after offline work left for the person to decide (`ROOMS.md` C6, rule 3). */
export interface MergeReview {
  /** The stored slices where my version differs from the room's, in order, with how many voxels on each. */
  slices: { z: number; voxels: number }[];
  voxels: number;
  /** The view that shows those slices face on: `axial` for a volume stored the usual way. */
  view: ViewId;
}

export interface RoomState {
  status: 'connecting' | 'online' | 'offline';
  id: string;
  kind: RoomKind;
  role: Role;
  selfId: number;
  name: string;
  /** The room runs on this computer. */
  hosting: boolean;
  /** The host's name, when the host is someone else and has said it. */
  hostName: string | null;
  /** The host is not connected. */
  hostAway: boolean;
  /** View through host, guest side: why the views are blanked, or null. */
  veil: string | null;
  /** View through host, guest side: the window the host looks through, when the host has said it. */
  hostVoi: { lower: number; upper: number } | null;
  /** A short line about what the room is waiting for, or null. */
  note: string | null;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  /** A third, quieter choice shown before Cancel. */
  other?: { label: string; run: () => void };
  run: () => void;
}

export interface Hover {
  ijk: [number, number, number];
  value: number;
  segment: number;
}

interface State {
  /** `ct` is true when the values look like Hounsfield units; it picks the default window and the unit shown. */
  image: {
    name: string;
    dims: [number, number, number];
    range: [number, number];
    ct: boolean;
    /** True for a guest who views through the host: 8-bit pictures in the host's window, not stored values. */
    grey?: boolean;
    /** The window the image would open on from its values alone, and the MR windows worked out from them. */
    auto: Voi;
    mr: MrWindows;
    path?: string;
  } | null;
  /** The preset list the user asked for, when the guess from the values was wrong. Null follows `image.ct`. */
  windowSet: WindowSet | null;
  /** Name, unsaved state and segments below are those of the active mask. */
  maskName: string | null;
  dirty: boolean;
  /** Every mask open on the image, in the order opened. The active one's name and unsaved state are the live fields above. */
  masks: MaskRow[];
  /** The mask being edited. The others are shown as outlines for comparison. */
  activeMask: string | null;
  /** The image is drawn darker so masks stand out. A view setting; the voxels are untouched. */
  imageDimmed: boolean;
  /** The Files section of the right panel is expanded. */
  filesOpen: boolean;
  busy: string | null;
  progress: number | null;

  tool: ToolId;
  /** Brush diameter in mm. */
  brushSize: number;
  /** The smallest diameter that paints a voxel of the open image. */
  brushMin: number;
  brushShape: 'circle' | 'sphere';
  threshold: [number, number];
  scissorsShape: ScissorsShape;
  scissorsAction: ScissorsAction;
  /** Whether the scissors cut the slice on screen or every slice. */
  scissorsDepth: ScissorsDepth;
  /** What a click with the Fill tool does: fill an enclosed area, or remove or keep the island under the cursor. */
  fillAction: 'fill' | 'remove' | 'keep';
  /** What painting may write over: everything, empty voxels only, or the inside of one segment (its index). */
  paintOver: PaintOver;
  /** A fill between slices that is shown but not yet done. */
  preview: { count: number; /** The same amount as a volume, ready to show. */ size: string; view: string; segment: number } | null;

  segments: SegmentInfo[];
  activeSegment: number;
  opacity: number;
  outlineOnly: boolean;
  /** The whole mask is off, fill and outline. Opacity and each segment's own setting are kept. */
  maskHidden: boolean;
  /** The segment just made with Add segment, so only its row animates in. */
  newSegment: number | null;
  /** The segment just picked from the image, so its row shows where it is. */
  pickedSegment: number | null;
  show3dImage: boolean;
  /** Measurements per segment index, refreshed shortly after edits stop. */
  stats: Record<number, SegmentStats>;
  measurementsOpen: boolean;
  /** The dialog that names a new window preset is open. */
  savePreset: boolean;

  maximized: ViewId | null;
  activeView: ViewId;
  panelOpen: boolean;
  slices: Record<string, { index: number; count: number }>;
  hover: Hover | null;
  voi: { lower: number; upper: number } | null;
  zoom: number | null;
  canUndo: boolean;
  canRedo: boolean;

  room: RoomState | null;
  /** My version put aside by a merge, until every slice is decided. It can outlast the room. */
  review: MergeReview | null;
  peers: Peer[];
  roomModal: 'start' | 'join' | null;
  /** The settings dialog and the section it shows; null when closed. */
  settings: SettingsSection | null;
  /** The report dialog, opened on the bug or the idea form. */
  report: 'bug' | 'idea' | null;
  /** True while the shortcut list is waiting for a new key, so nothing else reacts to it. */
  capturingShortcut: boolean;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  update: { version: string; install: () => Promise<void> } | null;
  updateDismissed: boolean;
}

export const useStore = create<State>(() => ({
  image: null,
  windowSet: null,
  maskName: null,
  dirty: false,
  masks: [],
  activeMask: null,
  imageDimmed: false,
  filesOpen: true,
  busy: null,
  progress: null,

  tool: 'crosshair',
  brushSize: 8,
  brushMin: 1,
  brushShape: 'circle',
  threshold: [0, 0],
  scissorsShape: 'rectangle',
  scissorsAction: 'erase',
  scissorsDepth: 'slice',
  fillAction: 'fill',
  paintOver: 'all',
  preview: null,

  segments: [],
  activeSegment: 0,
  opacity: 0.5,
  outlineOnly: false,
  maskHidden: false,
  newSegment: null,
  pickedSegment: null,
  show3dImage: false,
  stats: {},
  measurementsOpen: false,
  savePreset: false,

  maximized: null,
  activeView: 'axial',
  panelOpen: true,
  slices: {},
  hover: null,
  voi: null,
  zoom: null,
  canUndo: false,
  canRedo: false,

  room: null,
  review: null,
  peers: [],
  roomModal: null,
  settings: null,
  report: null,
  capturingShortcut: false,
  confirm: null,
  toasts: [],
  update: null,
  updateDismissed: false,
}));

export const set = useStore.setState;
export const get = useStore.getState;

let toastId = 0;
/** How long a toast takes to fade out; matches --dur-fast. */
export const TOAST_EXIT_MS = 120;

/** What keeps a toast on screen: the pointer over it, or keyboard focus inside it. */
type Hold = 'hover' | 'focus';

interface ToastClock {
  timer: ReturnType<typeof setTimeout> | null;
  /** Milliseconds still to run, or null for a toast that stays until dismissed. */
  left: number | null;
  /** When the running timer was started. */
  since: number;
  holds: Set<Hold>;
  /** Fading out; nothing stops it now. */
  leaving: boolean;
}

const clocks = new Map<number, ToastClock>();

function stop(clock: ToastClock): void {
  if (clock.timer) clearTimeout(clock.timer);
  clock.timer = null;
}

function run(id: number, clock: ToastClock): void {
  stop(clock);
  if (clock.left === null || clock.holds.size > 0) return;
  clock.since = Date.now();
  clock.timer = setTimeout(() => dismissToast(id), clock.left);
}

/** A message that is already showing is not stacked again: it stays, and its time starts over. */
export function toast(kind: Toast['kind'], text: string, action?: Toast['action']): void {
  const same = get().toasts.find((t) => t.text === text && t.kind === kind);
  const id = same?.id ?? ++toastId;
  const entry: Toast = { id, kind, text, action };
  set((s) => ({ toasts: same ? s.toasts.map((t) => (t.id === id ? entry : t)) : [...s.toasts, entry].slice(-3) }));
  const before = clocks.get(id);
  if (before) stop(before);
  const clock: ToastClock = { timer: null, left: kind === 'error' ? null : action ? 6000 : 4000, since: 0, holds: before?.leaving ? new Set() : (before?.holds ?? new Set()), leaving: false };
  clocks.set(id, clock);
  run(id, clock);
  for (const [other, c] of clocks) {
    if (!get().toasts.some((t) => t.id === other)) {
      stop(c);
      clocks.delete(other);
    }
  }
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  const clock = clocks.get(id) ?? { timer: null, left: null, since: 0, holds: new Set<Hold>(), leaving: true };
  stop(clock);
  clock.leaving = true;
  clocks.set(id, clock);
  clock.timer = setTimeout(() => {
    clocks.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, TOAST_EXIT_MS);
}

/** The timer of a toast stops while the pointer is over it or focus is inside it (DESIGN.md 4.5), and goes on afterwards. */
export function holdToast(id: number, why: Hold, on: boolean): void {
  const clock = clocks.get(id);
  if (!clock || clock.leaving) return;
  const held = clock.holds.size > 0;
  if (on) clock.holds.add(why);
  else clock.holds.delete(why);
  if (!held && clock.holds.size > 0) {
    if (clock.timer && clock.left !== null) clock.left = Math.max(0, clock.left - (Date.now() - clock.since));
    stop(clock);
  } else if (held && clock.holds.size === 0) run(id, clock);
}

/** Takes the action off every toast it no longer fits; the message stays for the time it has left. */
export function dropToastActions(stale: (action: NonNullable<Toast['action']>) => boolean): void {
  if (!get().toasts.some((t) => t.action && stale(t.action))) return;
  set((s) => ({ toasts: s.toasts.map((t) => (t.action && stale(t.action) ? { ...t, action: undefined } : t)) }));
}

export function activeSegmentInfo(s: State): SegmentInfo | undefined {
  return s.segments.find((x) => x.index === s.activeSegment);
}
