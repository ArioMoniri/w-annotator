import { create } from 'zustand';
import type { SegmentInfo } from '../collab/protocol';

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

export type ViewId = 'axial' | 'sagittal' | 'coronal' | 'volume3d';

export const SEGMENT_COLORS = [
  '#E69F00', '#56B4E9', '#F0E442', '#EE3377', '#009E73', '#B58CFF',
  '#D55E00', '#00D5C8', '#FFAABB', '#3D85F0', '#BBCC33', '#CC79A7',
];

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  action?: { label: string; run: () => void };
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
  image: { name: string; dims: [number, number, number]; range: [number, number] } | null;
  maskName: string | null;
  dirty: boolean;
  busy: string | null;
  progress: number | null;

  tool: ToolId;
  brushSize: number;
  brushShape: 'circle' | 'sphere';
  threshold: [number, number];
  scissorsShape: 'rectangle' | 'circle' | 'sphere';
  scissorsAction: 'erase' | 'fill';

  segments: SegmentInfo[];
  activeSegment: number;
  opacity: number;
  outlineOnly: boolean;
  show3dImage: boolean;

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
  shortcutsOpen: boolean;
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
  brushShape: 'circle',
  threshold: [0, 0],
  scissorsShape: 'rectangle',
  scissorsAction: 'erase',

  segments: [],
  activeSegment: 0,
  opacity: 0.5,
  outlineOnly: false,
  show3dImage: false,

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
  shortcutsOpen: false,
  confirm: null,
  toasts: [],
  update: null,
  updateDismissed: false,
}));

export const set = useStore.setState;
export const get = useStore.getState;

let toastId = 0;

export function toast(kind: Toast['kind'], text: string, action?: Toast['action']): void {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }].slice(-3) }));
  if (kind !== 'error') {
    setTimeout(() => dismissToast(id), action ? 6000 : 4000);
  }
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function activeSegmentInfo(s: State): SegmentInfo | undefined {
  return s.segments.find((x) => x.index === s.activeSegment);
}
