import { gunzip, gzip } from 'fflate';
import {
  autoWindow,
  baseName,
  fileKind,
  isDicomSeg,
  labelValues,
  readVolumeAsync,
  resampleNearest,
  sameGrid,
  toLabelmap,
  toRenderable,
  writeMask,
  type InputFile,
} from './io';
import type { ScalarArray, VolumeData } from './io/types';
import { hexToRgb } from './viewer/geometry';
import { History } from './mask/history';
import { interpolateSlices, sliceAxisFor } from './mask/interpolate';
import {
  combine,
  fillHoles,
  grow,
  keepLargestIsland,
  removeSmallIslands,
  segmentStats,
  shrink,
  smooth,
  statsCsv,
  type SegmentStats,
} from './mask/ops';
import {
  applyPatch,
  applyPatchWhereUnchanged,
  decodePatch,
  diffMask,
  encodePatch,
  patchSlices,
  restoreOverwritten,
  type Patch,
} from './mask/patch';
import { RoomClient } from './collab/client';
import {
  Assembler,
  FrameKind,
  chunk,
  formatCode,
  inviteLink,
  maskDigest,
  makeCode,
  parseInvite,
  renamePeer,
  userColor,
  type PeerMessage,
  type SegmentInfo,
  type VolumeMeta,
} from './collab/protocol';
import * as engine from './viewer/engine';
import { indexToWorld } from './viewer/geometry';
import { EDIT_TOOLS, SEGMENT_COLORS, get, set, toast, type ToolId, type ViewId } from './state/store';
import * as platform from './platform';
import { appLog } from './report';
import { makeSample } from './sample';
import { cleanName, setSetting } from './state/settings';

let image: VolumeData | null = null;
let mask: VolumeData | null = null;
let shadow: Uint8Array | null = null;
const history = new History();
let pointerDown = false;
let room: RoomClient | null = null;

export function getImage(): VolumeData | null {
  return image;
}

export function getMask(): VolumeData | null {
  return mask;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function sliceSize(): number {
  return mask ? mask.dims[0] * mask.dims[1] : 1;
}

function syncHistoryFlags(): void {
  set({ canUndo: history.canUndo || history.hasPending, canRedo: history.canRedo });
}

/* ───────────────────────── opening files ───────────────────────── */

const COMPANION = /\.(raw|zraw|img|img\.gz|raw\.gz)$/i;

function groupFiles(files: InputFile[]): InputFile[][] {
  const companions = files.filter((f) => COMPANION.test(f.name));
  const groups: InputFile[][] = [];
  const dicom: InputFile[] = [];
  for (const f of files) {
    if (COMPANION.test(f.name)) continue;
    const kind = fileKind(f.name);
    // A DICOM SEG is a mask of its own, not a slice of the image series.
    if ((kind === 'dicom' || kind === 'unknown') && isDicomSeg(f)) groups.push([f]);
    else if (kind === 'dicom' || kind === 'unknown') dicom.push(f);
    else groups.push([f, ...companions]);
  }
  if (dicom.length) groups.push(dicom);
  return groups;
}

function looksLikeMask(vol: VolumeData, name: string): boolean {
  const d = vol.data;
  if (d instanceof Float32Array || d instanceof Float64Array) {
    if (!/seg|mask|label/i.test(name)) return false;
  }
  const step = Math.max(1, Math.floor(d.length / 50000));
  const seen = new Set<number>();
  for (let i = 0; i < d.length; i += step) {
    const v = d[i];
    if (v < 0 || v > 255 || !Number.isInteger(v)) return false;
    seen.add(v);
    if (seen.size > 64) return false;
  }
  return true;
}

function describeError(err: unknown, name: string): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/memory|allocation|Array buffer/i.test(text)) return 'This image is too large to open on this device.';
  if (/not a supported/i.test(text)) return `Can't open ${name}. Use MHA, NIfTI, NRRD or DICOM.`;
  return text.length < 160 ? text : `Can't read ${name}. The file may be damaged or incomplete.`;
}

/**
 * Tells the user about an error nobody planned for, and offers to report it.
 * Errors with a known cause (a file that is too large or not supported) get no such offer.
 */
function unexpected(err: unknown, name: string): void {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Readers explain a bad file with an IoError; that is the file's problem, not the app's.
  const known = /^IoError|memory|allocation|Array buffer|not a supported/i.test(raw);
  if (!known) appLog.add('error', raw);
  toast('error', describeError(err, name), known ? undefined : { label: 'Report', run: () => set({ report: 'bug' }) });
}

export async function openFiles(files: InputFile[], role?: 'image' | 'mask'): Promise<void> {
  if (files.length === 0) return;
  // So that these names never appear in a problem report.
  for (const file of files) appLog.noteName(file.name);
  const groups = groupFiles(files);
  const loaded: { vol: VolumeData; name: string }[] = [];
  try {
    for (const group of groups) {
      const name = group[0].name;
      set({ busy: `Opening ${name}…` });
      await nextFrame();
      try {
        const vol = await readVolumeAsync(group);
        for (const warning of vol.warnings ?? []) toast('warning', warning);
        loaded.push({ vol: { ...vol, name }, name });
      } catch (err) {
        toast('error', describeError(err, name));
      }
    }
    if (loaded.length === 0) return;

    let img: (typeof loaded)[number] | undefined;
    let msk: (typeof loaded)[number] | undefined;
    if (role === 'mask') msk = loaded[0];
    else if (role === 'image' && loaded.length === 1) img = loaded[0];
    else if (loaded.length >= 2) {
      msk = loaded.find((l) => /seg|mask|label/i.test(l.name)) ?? loaded.find((l) => looksLikeMask(l.vol, l.name));
      img = loaded.find((l) => l !== msk);
    } else if (image && looksLikeMask(loaded[0].vol, loaded[0].name)) msk = loaded[0];
    else img = loaded[0];

    if (msk && !img && !image) {
      toast('error', 'Open an image first, then add the mask.');
      return;
    }
    if (img) {
      const next = img;
      const nextMask = msk;
      const go = async () => {
        await loadImage(next.vol);
        if (nextMask) await loadMask(nextMask.vol);
      };
      if (image && get().dirty) {
        set({
          confirm: {
            title: 'Replace the current image?',
            body: 'Unsaved mask changes will be lost.',
            confirm: 'Replace',
            danger: true,
            run: () => void guarded(go),
          },
        });
        return;
      }
      if (room && image) {
        toast('error', 'Leave the room before opening another image.');
        return;
      }
      await go();
    } else if (msk) {
      await loadMask(msk.vol);
    }
  } catch (err) {
    unexpected(err, files[0].name);
  } finally {
    set({ busy: null });
  }
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    unexpected(err, 'the file');
  } finally {
    set({ busy: null });
  }
}

function dataRange(d: ScalarArray): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return [lo, hi];
}

async function loadImage(vol: VolumeData): Promise<void> {
  set({ busy: `Opening ${vol.name}…` });
  await nextFrame();
  const renderable = toRenderable(vol);
  const range = dataRange(renderable.data);
  // CT-like data opens on a soft-tissue window; everything else on a percentile window.
  const looksLikeCt = range[0] <= -500 && range[1] > 300;
  const auto = autoWindow(renderable);
  const voi = looksLikeCt ? { lower: -160, upper: 240 } : auto;
  image = renderable;
  set({ image: { name: vol.name, dims: vol.dims, range }, voi, hover: null, maximized: null });
  // The viewport elements mount when `image` is set; wait for them.
  await nextFrame();
  await engine.showImage(renderable, voi);
  set({ threshold: looksLikeCt ? [100, Math.round(range[1])] : [Math.round((auto.lower + auto.upper) / 2), Math.round(range[1])] });
  installMask({
    name: '',
    dims: vol.dims,
    spacing: vol.spacing,
    origin: vol.origin,
    direction: vol.direction,
    data: new Uint8Array(vol.dims[0] * vol.dims[1] * vol.dims[2]),
  });
  set({ maskName: null, dirty: false });
  setTool('crosshair');
}

async function loadMask(vol: VolumeData): Promise<void> {
  if (!image) return;
  set({ busy: `Opening ${vol.name}…` });
  await nextFrame();
  let fitted = vol;
  const sameDims = vol.dims.every((n, i) => n === image!.dims[i]);
  // Within a tenth of a voxel the grids are the same. Anything else goes through
  // world coordinates, so a mask stored in another axis order is never mirrored.
  if (!sameGrid(vol, image, Math.min(...image.spacing) * 0.1)) {
    fitted = resampleNearest(vol, image);
    const kept = labelValues(toLabelmap(fitted)).length;
    if (kept === 0 && labelValues(toLabelmap(vol)).length > 0) {
      toast('error', "This mask doesn't overlap the image. Check that it belongs to this scan.");
      return;
    }
    toast(
      'warning',
      sameDims
        ? 'The mask is stored on a different grid from the image (orientation or position). It was resampled onto the image.'
        : `The mask is ${vol.dims.join(' × ')} but the image is ${image.dims.join(' × ')}. It was resampled to fit.`,
    );
  }
  const label = toLabelmap(fitted);
  const data = label.data === vol.data ? (label.data as Uint8Array).slice() : (label.data as Uint8Array);
  const before = mask?.data as Uint8Array | undefined;
  installMask({ ...image, name: vol.name, data, labels: vol.labels });
  const values = labelValues(mask!);
  const segments: SegmentInfo[] = values.map((index) => ({
    index,
    name: vol.labels?.[index] ?? `Segment ${index}`,
    color: vol.colors?.[index] ? rgbToHex(vol.colors[index]) : SEGMENT_COLORS[(index - 1) % SEGMENT_COLORS.length],
    visible: true,
    locked: false,
  }));
  set({ segments, activeSegment: segments[0]?.index ?? 0, maskName: vol.name, dirty: false });
  pushSegments();
  if (room && before) {
    // Share the newly opened mask with the room as one edit.
    const patch = diffMask(before, data, sliceSize());
    if (patch) room.sendFrame(FrameKind.Patch, encodePatch(patch));
    sendSegments();
  }
}

function rgbToHex(c: [number, number, number]): string {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function installMask(vol: VolumeData): void {
  mask = vol;
  shadow = (vol.data as Uint8Array).slice();
  history.clear();
  syncHistoryFlags();
  engine.showMask(vol);
  set({ segments: [], activeSegment: 0 });
  engine.setMaskStyle(get().opacity, get().outlineOnly);
  engine.set3dImageVisible(get().show3dImage);
  set({ stats: {} });
  scheduleStats();
}

export function closeImage(): void {
  const go = () => {
    leaveRoom(true);
    image = null;
    mask = null;
    shadow = null;
    history.clear();
    engine.unmountViewports();
    set({ image: null, maskName: null, dirty: false, segments: [], activeSegment: 0, canUndo: false, canRedo: false, hover: null, slices: {}, stats: {}, measurementsOpen: false });
  };
  if (get().dirty) {
    set({
      confirm: {
        title: `Save changes to ${defaultMaskName()}?`,
        body: 'Your mask edits have not been saved to a file.',
        confirm: 'Save',
        run: () => void saveMask().then(() => !get().dirty && go()),
        other: { label: "Don't save", run: go },
      },
    });
  } else go();
}

/* ───────────────────────── tools ───────────────────────── */

export function setTool(tool: ToolId): void {
  const s = get();
  if (!image) return;
  if (EDIT_TOOLS.includes(tool) && s.segments.length === 0) {
    toast('info', 'Add a segment to start editing.');
    return;
  }
  set({ tool });
  applyTool();
}

function applyTool(): void {
  const s = get();
  engine.setBrushSize(s.brushSize / 2);
  engine.setThreshold(s.threshold);
  engine.setTool(s.tool, { brushShape: s.brushShape, scissorsShape: s.scissorsShape, scissorsAction: s.scissorsAction });
}

export function setBrushSize(mm: number): void {
  const size = Math.min(100, Math.max(1, Math.round(mm)));
  set({ brushSize: size });
  // The number on screen is the brush diameter; the tools want a radius.
  engine.setBrushSize(size / 2);
}

export function setToolOption(
  patch: Partial<Pick<ReturnType<typeof get>, 'brushShape' | 'scissorsShape' | 'scissorsAction' | 'threshold'>>,
): void {
  set(patch);
  applyTool();
}

export function setVoi(lower: number, upper: number): void {
  if (upper <= lower) upper = lower + 1;
  set({ voi: { lower, upper } });
  engine.setVoi(lower, upper);
}

/* ───────────────────────── mask edits ───────────────────────── */

export function attachEditTracking(): () => void {
  const off = engine.onMaskEdited((slices) => recordEdit(slices));
  const down = () => {
    pointerDown = true;
  };
  const up = () => {
    pointerDown = false;
    // Tools write their last voxels on mouse up; let that land first.
    setTimeout(() => {
      if (!pointerDown) {
        recordEdit(undefined, true);
        history.commit();
        syncHistoryFlags();
      }
    }, 30);
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  return () => {
    off();
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
  };
}

let dirtySlices: Set<number> | 'all' | null = null;

function recordEdit(slices: number[] | undefined, flush = false): void {
  if (!mask || !shadow) return;
  // While dragging, remember which slices changed and diff them in one go per frame.
  if (!flush) {
    if (!slices || slices.length === 0) dirtySlices = 'all';
    else if (dirtySlices !== 'all') {
      dirtySlices ??= new Set();
      for (const s of slices) dirtySlices.add(s);
    }
    scheduleFlush();
    return;
  }
  flushEdits();
}

let flushQueued = false;
function scheduleFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    flushEdits();
    if (!pointerDown) {
      history.commit();
      syncHistoryFlags();
    }
  });
}

function flushEdits(): void {
  if (!mask || !shadow || !dirtySlices) return;
  const which = dirtySlices === 'all' ? undefined : [...dirtySlices];
  dirtySlices = null;
  const data = mask.data as Uint8Array;
  let patch = diffMask(shadow, data, sliceSize(), which);
  if (!patch) return;
  if (get().paintOver === 'empty' && restoreOverwritten(data, patch) > 0) {
    // The stroke ran over a neighbour: those voxels are back, so diff again and repaint.
    const touched = patchSlices(patch, sliceSize());
    patch = diffMask(shadow, data, sliceSize(), touched);
    engine.refreshMask(touched);
    if (!patch) return;
  }
  applyPatch(shadow, patch, 'after');
  history.add(patch);
  room?.sendFrame(FrameKind.Patch, encodePatch(patch));
  scheduleDigest();
  scheduleStats();
  if (!get().dirty) set({ dirty: true });
  syncHistoryFlags();
}

/** Write a patch into the mask from outside the tools (undo, redo, room). */
function writePatch(patch: Patch, side: 'before' | 'after'): void {
  if (!mask || !shadow) return;
  applyPatch(mask.data as Uint8Array, patch, side);
  applyPatch(shadow, patch, side);
  ensureSegments(patch[side]);
  engine.refreshMask(patchSlices(patch, sliceSize()));
  scheduleStats();
}

/** Undo or redo one of my patches without touching voxels others changed since. */
function writeOwn(patch: Patch, side: 'before' | 'after'): void {
  if (!mask || !shadow) return;
  const written = applyPatchWhereUnchanged(mask.data as Uint8Array, patch, side);
  if (!written) return;
  applyPatch(shadow, written, 'after');
  ensureSegments(written.after);
  engine.refreshMask(patchSlices(written, sliceSize()));
  room?.sendFrame(FrameKind.Patch, encodePatch(written));
  scheduleStats();
}

/** What deleted segments looked like, so undo brings back the name, colour and lock too. */
const removedSegments = new Map<number, SegmentInfo>();

function ensureSegments(values: Uint8Array): void {
  const s = get();
  const known = new Set(s.segments.map((x) => x.index));
  const missing = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== 0 && !known.has(v)) missing.add(v);
  }
  if (missing.size === 0) return;
  const added = [...missing].map(
    (index) =>
      removedSegments.get(index) ?? {
        index,
        name: `Segment ${index}`,
        color: SEGMENT_COLORS[(index - 1) % SEGMENT_COLORS.length],
        visible: true,
        locked: false,
      },
  );
  set({ segments: [...s.segments, ...added].sort((a, b) => a.index - b.index) });
  pushSegments();
  if (added.some((x) => removedSegments.has(x.index))) sendSegments();
}

export function undo(): void {
  flushEdits();
  const patches = history.undo();
  if (!patches) return;
  for (const p of patches) writeOwn(p, 'before');
  set({ dirty: true });
  syncHistoryFlags();
}

export function redo(): void {
  const patches = history.redo();
  if (!patches) return;
  for (const p of patches) writeOwn(p, 'after');
  set({ dirty: true });
  syncHistoryFlags();
}

/** Run a direct edit of the mask buffer as one undo step. Returns changed voxel count. */
function editMask(fn: (data: Uint8Array) => void): number {
  if (!mask || !shadow) return 0;
  flushEdits();
  history.commit();
  fn(mask.data as Uint8Array);
  const patch = diffMask(shadow, mask.data as Uint8Array, sliceSize());
  if (!patch) return 0;
  applyPatch(shadow, patch, 'after');
  history.add(patch);
  history.commit();
  room?.sendFrame(FrameKind.Patch, encodePatch(patch));
  engine.refreshMask(patchSlices(patch, sliceSize()));
  set({ dirty: true });
  syncHistoryFlags();
  scheduleDigest();
  scheduleStats();
  return patch.after.length;
}

/* ───────────────────────── segments ───────────────────────── */

function pushSegments(): void {
  const s = get();
  engine.applySegments(s.segments, s.activeSegment);
}

function sendSegments(): void {
  room?.send({ t: 'segments', list: get().segments });
}

function updateSegments(list: SegmentInfo[], active = get().activeSegment): void {
  set({ segments: list, activeSegment: active });
  pushSegments();
  sendSegments();
}

export function addSegment(): void {
  const s = get();
  if (!image) return;
  const used = new Set(s.segments.map((x) => x.index));
  let index = 1;
  while (used.has(index)) index++;
  if (index > 255) {
    toast('error', 'A mask can hold up to 255 segments.');
    return;
  }
  const seg: SegmentInfo = {
    index,
    name: `Segment ${index}`,
    color: SEGMENT_COLORS[(index - 1) % SEGMENT_COLORS.length],
    visible: true,
    locked: false,
  };
  updateSegments([...s.segments, seg].sort((a, b) => a.index - b.index), index);
  if (!EDIT_TOOLS.includes(s.tool)) setTool('brush');
}

export function selectSegment(index: number): void {
  if (!get().segments.some((x) => x.index === index)) return;
  set({ activeSegment: index });
  pushSegments();
}

export function patchSegment(index: number, patch: Partial<Omit<SegmentInfo, 'index'>>): void {
  updateSegments(get().segments.map((x) => (x.index === index ? { ...x, ...patch } : x)));
}

export function showOnly(index: number): void {
  const list = get().segments;
  const alreadyOnly = list.every((x) => x.visible === (x.index === index));
  updateSegments(list.map((x) => ({ ...x, visible: alreadyOnly ? true : x.index === index })));
}

export function clearSegment(index: number): void {
  const seg = get().segments.find((x) => x.index === index);
  if (!seg) return;
  const n = editMask((d) => {
    for (let i = 0; i < d.length; i++) if (d[i] === index) d[i] = 0;
  });
  if (n > 0) toast('info', `${seg.name} cleared`, { label: 'Undo', run: undo });
}

export function deleteSegment(index: number): void {
  const s = get();
  const seg = s.segments.find((x) => x.index === index);
  if (!seg) return;
  const n = editMask((d) => {
    for (let i = 0; i < d.length; i++) if (d[i] === index) d[i] = 0;
  });
  removedSegments.set(index, { ...seg, visible: true });
  const rest = s.segments.filter((x) => x.index !== index);
  const active = s.activeSegment === index ? (rest[0]?.index ?? 0) : s.activeSegment;
  updateSegments(rest, active);
  if (rest.length === 0 && EDIT_TOOLS.includes(s.tool)) setTool('crosshair');
  toast('info', `${seg.name} deleted`, n > 0 ? { label: 'Undo', run: undo } : undefined);
}

/** Fill the gaps between painted slices of the active segment, in the plane of the active view. */
export function fillBetweenSlices(): void {
  const s = get();
  const seg = s.segments.find((x) => x.index === s.activeSegment);
  if (!mask || !seg) {
    toast('info', 'Add a segment to start editing.');
    return;
  }
  if (seg.locked || !seg.visible) {
    toast('info', seg.locked ? `${seg.name} is locked. Unlock it to edit.` : `${seg.name} is hidden. Show it to edit.`);
    return;
  }
  const view = s.activeView === 'volume3d' ? 'axial' : s.activeView;
  const axis = sliceAxisFor(mask.direction, view);
  const n = editMask((d) => {
    interpolateSlices(d, mask!.dims, seg.index, axis);
  });
  if (n > 0) toast('info', `Filled ${n.toLocaleString('en-US')} voxels between ${view} slices`, { label: 'Undo', run: undo });
  else toast('info', `Paint ${seg.name} on two ${view} slices with a gap between them, then fill.`);
}

/* ───────────────────────── whole-segment operations ───────────────────────── */

export type RefineOp = 'grow' | 'shrink' | 'smooth' | 'fillHoles' | 'keepLargest' | 'removeSmall';

/** The segment if it can be edited now; otherwise says why not and returns null. */
function editableSegment(index: number): SegmentInfo | null {
  const seg = get().segments.find((x) => x.index === index);
  if (!mask || !seg) return null;
  if (seg.locked || !seg.visible) {
    toast('info', seg.locked ? `${seg.name} is locked. Unlock it to edit.` : `${seg.name} is hidden. Show it to edit.`);
    return null;
  }
  return seg;
}

/** One undo step. Large masks show what is happening, since the work can take a moment. */
async function runOperation(label: string, fn: (data: Uint8Array) => void): Promise<number> {
  const large = (mask?.data.length ?? 0) > 4_000_000;
  if (large) {
    set({ busy: label });
    await nextFrame();
  }
  try {
    return editMask(fn);
  } catch {
    toast('error', 'Not enough memory for this. Close other apps or try a smaller distance.');
    return -1;
  } finally {
    if (large) set({ busy: null });
  }
}

const voxels = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'voxel' : 'voxels'}`;

/** Grow, shrink, smooth (mm), fill holes, keep the largest island or remove small islands (mm³) on one segment. */
export async function refineSegment(index: number, op: RefineOp, amount = 0): Promise<void> {
  const seg = editableSegment(index);
  if (!seg || !mask) return;
  const { dims, spacing } = mask;
  const name = seg.name;
  const steps: Record<RefineOp, { busy: string; run: (d: Uint8Array) => number; done: (n: number) => string; none: string }> = {
    grow: {
      busy: `Growing ${name}…`,
      run: (d) => grow(d, dims, spacing, index, amount),
      done: () => `Grew ${name} by ${amount} mm`,
      none: `${name} did not change.`,
    },
    shrink: {
      busy: `Shrinking ${name}…`,
      run: (d) => shrink(d, dims, spacing, index, amount),
      done: () => `Shrank ${name} by ${amount} mm`,
      none: `${name} did not change.`,
    },
    smooth: {
      busy: `Smoothing ${name}…`,
      run: (d) => smooth(d, dims, spacing, index, amount),
      done: () => `Smoothed ${name} by ${amount} mm`,
      none: `${name} did not change.`,
    },
    fillHoles: {
      busy: `Filling holes in ${name}…`,
      run: (d) => fillHoles(d, dims, index),
      done: (n) => `Filled ${voxels(n)} in ${name}`,
      none: `No holes in ${name}.`,
    },
    keepLargest: {
      busy: `Looking for islands in ${name}…`,
      run: (d) => keepLargestIsland(d, dims, index),
      done: (n) => `Removed ${voxels(n)} outside the largest island of ${name}`,
      none: `${name} is already one island.`,
    },
    removeSmall: {
      busy: `Looking for islands in ${name}…`,
      run: (d) => removeSmallIslands(d, dims, spacing, index, amount),
      done: (n) => `Removed ${voxels(n)} in small islands of ${name}`,
      none: `No islands under ${amount} mm³ in ${name}.`,
    },
  };
  const step = steps[op];
  const n = await runOperation(step.busy, (d) => {
    step.run(d);
  });
  if (n > 0) toast('info', step.done(n), { label: 'Undo', run: undo });
  else if (n === 0) toast('info', step.none);
}

/** Moves every voxel of `other` into `target`. Segments cannot overlap, so this is the one way to combine two. */
export async function addSegmentInto(target: number, other: number): Promise<void> {
  const seg = editableSegment(target);
  const from = seg && editableSegment(other);
  if (!seg || !from || target === other) return;
  const n = await runOperation(`Adding ${from.name} to ${seg.name}…`, (d) => {
    combine(d, target, other, 'union');
  });
  if (n > 0) toast('info', `Added ${from.name} to ${seg.name}, ${voxels(n)}`, { label: 'Undo', run: undo });
  else if (n === 0) toast('info', `${from.name} is empty.`);
}

/* ───────────────────────── measurements ───────────────────────── */

let statsTimer: ReturnType<typeof setTimeout> | null = null;

/** Measure again once edits have stopped; never in the middle of a stroke. */
function scheduleStats(delay = 250): void {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    statsTimer = null;
    if (pointerDown || dirtySlices) return scheduleStats();
    refreshStats();
  }, delay);
}

export function refreshStats(): SegmentStats[] {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = null;
  if (!mask) {
    set({ stats: {} });
    return [];
  }
  const sameGridImage = image && image.data.length === mask.data.length ? image.data : null;
  const list = segmentStats(mask.data as Uint8Array, sameGridImage, mask.dims, mask.spacing);
  const stats: Record<number, SegmentStats> = {};
  for (const s of list) stats[s.label] = s;
  set({ stats });
  return list;
}

/** Brings all three views to the middle of a segment. */
export function goToSegment(index: number): void {
  const seg = get().segments.find((x) => x.index === index);
  if (!mask || !seg) return;
  flushEdits();
  const found = refreshStats().find((s) => s.label === index);
  if (!found) {
    toast('info', `${seg.name} is empty.`);
    return;
  }
  engine.jumpTo(indexToWorld(mask, found.centre));
}

export function openMeasurements(): void {
  flushEdits();
  refreshStats();
  set({ measurementsOpen: true });
}

export async function copyMeasurements(): Promise<void> {
  const s = get();
  const names = new Map(s.segments.map((x) => [x.index, x.name]));
  const rows = s.segments.map((x) => s.stats[x.index]).filter((x): x is SegmentStats => !!x);
  const ok = await platform.copyText(statsCsv(rows, (label) => names.get(label) ?? `Segment ${label}`));
  toast(ok ? 'success' : 'error', ok ? 'Measurements copied' : "Couldn't copy. Allow clipboard access and try again.");
}

export function setPaintOver(paintOver: 'all' | 'empty'): void {
  set({ paintOver });
}

export function setOpacity(opacity: number): void {
  set({ opacity });
  engine.setMaskStyle(opacity, get().outlineOnly);
}

export function setOutlineOnly(outlineOnly: boolean): void {
  set({ outlineOnly });
  engine.setMaskStyle(get().opacity, outlineOnly);
}

export function setShow3dImage(show: boolean): void {
  set({ show3dImage: show });
  engine.set3dImageVisible(show);
}

/* ───────────────────────── saving ───────────────────────── */

type MaskFormat = 'nii.gz' | 'nii' | 'mha' | 'nrrd' | 'dcm';

function formatOf(name: string): MaskFormat {
  const n = name.toLowerCase();
  if (n.endsWith('.nii')) return 'nii';
  if (n.endsWith('.mha')) return 'mha';
  if (n.endsWith('.nrrd')) return 'nrrd';
  if (n.endsWith('.dcm')) return 'dcm';
  return 'nii.gz';
}

export function defaultMaskName(): string {
  const s = get();
  if (s.maskName && /\.(nii|nii\.gz|mha|nrrd|dcm)$/i.test(s.maskName)) return s.maskName;
  return `${baseName(s.maskName ?? s.image?.name ?? 'mask')}${s.maskName ? '' : '_mask'}.nii.gz`;
}

export async function saveMask(): Promise<void> {
  if (!mask) return;
  flushEdits();
  const suggested = defaultMaskName();
  try {
    const labels: Record<number, string> = {};
    const colors: Record<number, [number, number, number]> = {};
    for (const seg of get().segments) {
      labels[seg.index] = seg.name;
      colors[seg.index] = hexToRgb(seg.color);
    }
    const saved = await platform.saveBytes(suggested, (name) => {
      // A DICOM SEG refers back to the series the image came from, when there was one.
      return writeMask({ ...mask!, name, labels, colors }, formatOf(name), { source: image?.dicom });
    });
    if (!saved) return;
    set({ dirty: false, maskName: saved });
    toast('success', `Saved to ${saved}`);
  } catch {
    toast('error', "Couldn't save the mask. Check that the folder is writable.", { label: 'Retry', run: () => void saveMask() });
  }
}

/* ───────────────────────── rooms ───────────────────────── */

const DTYPES: Record<string, new (buffer: ArrayBuffer) => ScalarArray> = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
};

const gz = (data: Uint8Array) =>
  new Promise<Uint8Array>((resolve, reject) => gzip(data, { level: 1 }, (err, out) => (err ? reject(err) : resolve(out))));
const gunz = (data: Uint8Array) =>
  new Promise<Uint8Array>((resolve, reject) => gunzip(data, (err, out) => (err ? reject(err) : resolve(out))));

// File names can carry patient identifiers, so the room only ever sees neutral ones.
function metaOf(vol: VolumeData, bytes: number, name: string): VolumeMeta {
  return { name, dims: vol.dims, spacing: vol.spacing, origin: vol.origin, direction: vol.direction, dtype: vol.data.constructor.name, bytes };
}

function bytesOf(d: ScalarArray): Uint8Array {
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

let incoming: { meta: Extract<PeerMessage, { t: 'snapshot' }>; assembler: Assembler; queued: Uint8Array[] } | null = null;
let awaitingSnapshot = false;
let queuedPatches: Uint8Array[] = [];
let hostingLocally = false;
/** True once the name differs from the one the room server was given, so newcomers need telling. */
let renamed = false;

export async function startRoom(name: string): Promise<{ code: string; link: string } | string> {
  if (!image) return 'Open an image first.';
  let server = platform.relayServer();
  hostingLocally = false;
  if (!server) {
    const hosted = await platform.hostRoom();
    if (!hosted) return "Rooms need a room server. Add one under 'Server'.";
    server = hosted;
    hostingLocally = true;
  }
  const code = makeCode();
  return connect(server, code, name, true);
}

export async function joinRoom(name: string, invite: string): Promise<{ code: string; link: string } | string> {
  const parsed = parseInvite(invite, platform.relayServer() ?? '');
  if (!parsed) return 'Enter the room code or paste the invite link.';
  return connect(parsed.server, parsed.code, name, false);
}

function connect(server: string, code: string, name: string, starting: boolean): Promise<{ code: string; link: string } | string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { code: string; link: string } | string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const link = inviteLink(server, code);
    renamed = false;
    const client = new RoomClient(server, code, name, {
      onStatus: (status) => {
        const r = get().room;
        if (r) set({ room: { ...r, status } });
        if (status === 'reconnecting' && r?.status === 'online') {
          toast('warning', 'Connection lost. Reconnecting…');
        }
      },
      onWelcome: (msg, reconnected) => {
        if (!starting && !reconnected && msg.peers.length === 0) {
          client.close();
          room = null;
          finish('No room with that code. Check the code and try again.');
          return;
        }
        set({
          // After a reconnect the name may have changed since this connection was first made.
          room: { status: 'online', code, link, selfId: msg.id, name: get().room?.name ?? name, hosting: hostingLocally },
          peers: msg.peers.map((p) => ({ ...p, color: userColor(p.id) })),
        });
        if (msg.peers.length > 0) {
          const source = Math.min(...msg.peers.map((p) => p.id));
          awaitingSnapshot = true;
          queuedPatches = [];
          client.send({ t: 'need-snapshot', to: source, imageToo: !image });
          if (!image) set({ busy: 'Getting the image from the room…', progress: 0 });
          if (reconnected) toast('info', 'Back online. The mask was refreshed from the room.');
        } else if (reconnected) {
          toast('info', 'Back online.');
        }
        finish({ code, link });
      },
      onJoin: (id, peerName) => {
        set((s) => ({ peers: [...s.peers.filter((p) => p.id !== id), { id, name: peerName, color: userColor(id) }] }));
        toast('info', `${peerName} joined`);
        // The server introduced us by the name we connected with.
        const self = get().room;
        if (renamed && self) client.send({ t: 'rename', name: self.name });
      },
      onLeave: (id) => {
        const peer = get().peers.find((p) => p.id === id);
        set((s) => ({ peers: s.peers.filter((p) => p.id !== id) }));
        if (peer) toast('info', `${peer.name} left`);
      },
      onMessage: (msg) => void onPeerMessage(client, msg),
      onFrame: (from, kind, payload) => void onPeerFrame(from, kind, payload),
      onClosed: (reason) => {
        const wasIn = !!get().room;
        room = null;
        set({ room: null, peers: [], busy: null, progress: null });
        if (hostingLocally) void platform.stopHosting();
        const text =
          reason === 'full'
            ? 'This room is full.'
            : reason === 'lost'
              ? 'Still offline. Your changes are kept on this device.'
              : "Can't connect. Check the address and your network, then try again.";
        if (wasIn) toast('error', text);
        finish(text);
      },
    });
    room?.close();
    room = client;
    set({ room: { status: 'connecting', code, link, selfId: 0, name, hosting: hostingLocally }, peers: [] });
    client.connect();
  });
}

/**
 * Changes the name others see. It is saved as the name for future rooms and,
 * in a room, sent to everyone straight away.
 */
export function setDisplayName(name: string): void {
  const clean = cleanName(name);
  setSetting('displayName', clean);
  const r = get().room;
  if (!room || !r || !clean || clean === r.name) return;
  renamed = true;
  room.setName(clean);
  set({ room: { ...r, name: clean } });
  room.send({ t: 'rename', name: clean });
}

/** Opens the built-in synthetic image and mask used by the welcome tour. */
export async function openSample(): Promise<void> {
  await openFiles(makeSample());
}

export function leaveRoom(silent = false): void {
  if (!room) return;
  room.close();
  room = null;
  incoming = null;
  awaitingSnapshot = false;
  set({ room: null, peers: [], progress: null });
  if (hostingLocally) void platform.stopHosting();
  hostingLocally = false;
  if (!silent) toast('info', 'You left the room');
}

async function onPeerMessage(client: RoomClient, msg: PeerMessage): Promise<void> {
  switch (msg.t) {
    case 'cursor': {
      set((s) => ({
        peers: s.peers.map((p) =>
          p.id === msg.from ? { ...p, cursor: msg.vp && msg.w ? { vp: msg.vp as ViewId, w: msg.w, r: msg.r } : undefined } : p,
        ),
      }));
      break;
    }
    case 'rename':
      set((s) => ({ peers: renamePeer(s.peers, msg) }));
      break;
    case 'segments': {
      const s = get();
      const active = msg.list.some((x) => x.index === s.activeSegment) ? s.activeSegment : (msg.list[0]?.index ?? 0);
      const gone = s.segments.find((x) => x.index === s.activeSegment && active !== s.activeSegment);
      if (gone) {
        const who = s.peers.find((p) => p.id === msg.from)?.name ?? 'Someone';
        toast('warning', `${who} deleted ${gone.name}. You are now on ${msg.list.find((x) => x.index === active)?.name ?? 'no segment'}.`);
      }
      // Visibility is a personal view setting; keep ours.
      const mine = new Map(s.segments.map((x) => [x.index, x.visible]));
      set({ segments: msg.list.map((x) => ({ ...x, visible: mine.get(x.index) ?? true })), activeSegment: active });
      pushSegments();
      break;
    }
    case 'need-snapshot':
      await sendSnapshot(client, msg.from, msg.imageToo, msg.resync);
      break;
    case 'digest': {
      // Two people painting over each other at the same instant can end up a few
      // voxels apart. When that happens the person with the lower id is the reference.
      if (!mask || awaitingSnapshot || pointerDown || dirtySlices) break;
      if (maskDigest(mask.data as Uint8Array) === msg.h) break;
      const self = get().room?.selfId ?? 0;
      if (msg.from < self) {
        awaitingSnapshot = true;
        queuedPatches = [];
        client.send({ t: 'need-snapshot', to: msg.from, imageToo: false, resync: true });
      } else {
        scheduleDigest(200);
      }
      break;
    }
    case 'no-snapshot':
      awaitingSnapshot = false;
      set({ busy: null, progress: null });
      break;
    case 'snapshot':
      incoming = { meta: msg, assembler: new Assembler(msg.total), queued: [] };
      if (msg.total === 0) await finishSnapshot(new Uint8Array(0));
      break;
  }
}

async function sendSnapshot(client: RoomClient, to: number, imageToo: boolean, resync = false): Promise<void> {
  if (!image || !mask) {
    client.send({ t: 'no-snapshot', to });
    return;
  }
  flushEdits();
  // Copy the mask now so later strokes do not end up half inside the snapshot.
  const maskCopy = (mask.data as Uint8Array).slice();
  const segments = get().segments;
  const maskName = get().maskName;
  const maskZ = await gz(maskCopy);
  const imageZ = imageToo ? await gz(bytesOf(image.data).slice()) : null;
  const total = maskZ.length + (imageZ?.length ?? 0);
  client.send({
    t: 'snapshot',
    to,
    image: imageZ ? metaOf(image, imageZ.length, 'Room image') : null,
    mask: metaOf(mask, maskZ.length, 'Room mask'),
    maskName: maskName ? 'Room mask' : null,
    resync,
    segments,
    total,
  });
  const parts = [...(imageZ ? chunk(imageZ, 1 << 20) : []), ...chunk(maskZ, 1 << 20)];
  for (const part of parts) {
    while (client.backlog > 8 << 20) await new Promise((r) => setTimeout(r, 30));
    if (!client.open) return;
    client.sendFrame(FrameKind.Snapshot, part, to);
  }
}

async function onPeerFrame(_from: number, kind: number, payload: Uint8Array): Promise<void> {
  if (kind === FrameKind.Patch) {
    if (awaitingSnapshot) {
      queuedPatches.push(payload.slice());
      return;
    }
    applyRemotePatch(payload);
  } else if (kind === FrameKind.Snapshot && incoming) {
    const done = incoming.assembler.push(payload);
    set({ progress: incoming.assembler.progress });
    if (done) await finishSnapshot(done);
  }
}

function applyRemotePatch(payload: Uint8Array): void {
  if (!mask) return;
  try {
    writePatch(decodePatch(payload), 'after');
    scheduleDigest();
    if (!get().dirty) set({ dirty: true });
  } catch {
    /* a patch for a different mask; ignore it */
  }
}

async function finishSnapshot(all: Uint8Array): Promise<void> {
  const snap = incoming;
  if (!snap) return;
  incoming = null;
  const { meta } = snap;
  try {
    let offset = 0;
    if (meta.image) {
      const raw = await gunz(all.subarray(0, meta.image.bytes));
      offset = meta.image.bytes;
      const Ctor = DTYPES[meta.image.dtype];
      if (!Ctor) throw new Error('Unknown image data type');
      const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
      await loadImage({
        name: meta.image.name,
        dims: meta.image.dims,
        spacing: meta.image.spacing,
        origin: meta.image.origin,
        direction: meta.image.direction,
        data: new Ctor(buffer),
      });
    }
    if (!image || !mask) throw new Error('No image');
    if (!meta.mask.dims.every((n, i) => n === image!.dims[i])) {
      toast('error', 'The room is working on a different image. Close this one and join again.');
      leaveRoom(true);
      return;
    }
    const maskRaw = await gunz(all.subarray(offset, offset + meta.mask.bytes));
    const data = mask.data as Uint8Array;
    data.set(maskRaw);
    shadow = data.slice();
    engine.refreshMask();
    scheduleStats();
    if (meta.resync) {
      // A quiet correction: keep my undo history, view settings and file name.
      ensureSegments(data);
    } else {
      history.clear();
      syncHistoryFlags();
      const active = meta.segments[0]?.index ?? 0;
      set({ segments: meta.segments.map((x) => ({ ...x, visible: true })), activeSegment: active, maskName: meta.maskName, dirty: false });
      pushSegments();
    }
    awaitingSnapshot = false;
    for (const p of queuedPatches) applyRemotePatch(p);
    queuedPatches = [];
  } catch (err) {
    unexpected(err, 'the room data');
  } finally {
    awaitingSnapshot = false;
    set({ busy: null, progress: null });
  }
}

let digestTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDigest(delay = 1200): void {
  if (!room) return;
  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = setTimeout(() => {
    digestTimer = null;
    if (!room || !mask || get().peers.length === 0) return;
    if (pointerDown || awaitingSnapshot || dirtySlices) return scheduleDigest();
    room.send({ t: 'digest', h: maskDigest(mask.data as Uint8Array) });
  }, delay);
}

let lastCursor = 0;
export function shareCursor(vp: ViewId | null, w?: [number, number, number]): void {
  if (!room || get().peers.length === 0) return;
  const now = performance.now();
  if (vp && now - lastCursor < 60) return;
  lastCursor = now;
  const s = get();
  const painting = s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'threshold';
  room.send({ t: 'cursor', vp, w, r: painting ? s.brushSize / 2 : undefined });
}

export function roomCodeLabel(): string {
  const r = get().room;
  return r ? formatCode(r.code) : '';
}
