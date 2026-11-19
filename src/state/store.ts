import { create } from 'zustand';
import type { SegmentInfo } from '../collab/protocol';
import type { SegmentStats } from '../mask/ops';

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

export type SettingsSection = 'profile' | 'appearance' | 'shortcuts' | 'files' | 'help';

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
  cursor?: { vp: ViewId; w: [number, number, number]; r?: number };
}

export interface RoomState {
  status: 'connecting' | 'online' | 'reconnecting';
  code: string;
  link: string;
  selfId: number;
  name: string;
  hosting: boolean;
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
  image: { name: string; dims: [number, number, number]; range: [number, number]; ct: boolean } | null;
  maskName: string | null;
  dirty: boolean;
  busy: string | null;
  progress: number | null;

  tool: ToolId;
  /** Brush diameter in mm. */
  brushSize: number;
  /** The smallest diameter that paints a voxel of the open image. */
  brushMin: number;
  brushShape: 'circle' | 'sphere';
  threshold: [number, number];
  scissorsShape: 'rectangle' | 'circle' | 'sphere';
  scissorsAction: 'erase' | 'fill';
  /** Whether painting may take voxels from other segments. */
  paintOver: 'all' | 'empty';

  segments: SegmentInfo[];
  activeSegment: number;
  opacity: number;
  outlineOnly: boolean;
  /** The whole mask is off, fill and outline. Opacity and each segment's own setting are kept. */
  maskHidden: boolean;
  /** The segment just made with Add segment, so only its row animates in. */
  newSegment: number | null;
  show3dImage: boolean;
  /** Measurements per segment index, refreshed shortly after edits stop. */
  stats: Record<number, SegmentStats>;
  measurementsOpen: boolean;

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
  maskName: null,
  dirty: false,
  busy: null,
  progress: null,

  tool: 'crosshair',
  brushSize: 8,
  brushMin: 1,
  brushShape: 'circle',
  threshold: [0, 0],
  scissorsShape: 'rectangle',
  scissorsAction: 'erase',
  paintOver: 'all',

  segments: [],
  activeSegment: 0,
  opacity: 0.5,
  outlineOnly: false,
  maskHidden: false,
  newSegment: null,
  show3dImage: false,
  stats: {},
  measurementsOpen: false,

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
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

function toastTimer(id: number, ms: number | null, run: () => void): void {
  const running = toastTimers.get(id);
  if (running) clearTimeout(running);
  toastTimers.delete(id);
  if (ms !== null) toastTimers.set(id, setTimeout(run, ms));
}

/** A message that is already showing is not stacked again: it stays, and its time starts over. */
export function toast(kind: Toast['kind'], text: string, action?: Toast['action']): void {
  const same = get().toasts.find((t) => t.text === text && t.kind === kind);
  const id = same?.id ?? ++toastId;
  const entry: Toast = { id, kind, text, action };
  set((s) => ({ toasts: same ? s.toasts.map((t) => (t.id === id ? entry : t)) : [...s.toasts, entry].slice(-3) }));
  toastTimer(id, kind === 'error' ? null : action ? 6000 : 4000, () => dismissToast(id));
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  toastTimer(id, TOAST_EXIT_MS, () => {
    toastTimers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  });
}

export function activeSegmentInfo(s: State): SegmentInfo | undefined {
  return s.segments.find((x) => x.index === s.activeSegment);
}
