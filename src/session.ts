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
import { brushRadius, cleanBrushSize, minBrushSize } from './mask/brush';
import { MaskSet, TOO_MANY_MASKS, compareColor, shortName } from './mask/collection';
import { assignRoles, labelLook } from './files/roles';
import { sliceAxisFor } from './mask/interpolate';
import {
  combine,
  countIslands,
  fillHoles,
  formatVolume,
  grow,
  islandAt,
  keepLargestIsland,
  removeSmallIslands,
  segmentStats,
  shrink,
  smooth,
  splitIslands,
  statsCsv,
  type SegmentStats,
} from './mask/ops';
import { cleanPaintOver, eraseRule, strokeRule, writableValues, type PaintOver } from './mask/paintOver';
import {
  applyPatch,
  applyPatchWhereUnchanged,
  decodePatch,
  diffMask,
  encodePatch,
  patchSlices,
  restoreWhere,
  type Patch,
} from './mask/patch';
import { segmentAt } from './mask/pick';
import { FillPreview } from './mask/preview';
import { cut, sliceRange, viewMap, type Cut, type Point } from './mask/scissors';
import { RoomClient } from './collab/client';
import { joinProblem } from './collab/hosting';
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
import { indexToWorld, voxelAt } from './viewer/geometry';
import { EDIT_TOOLS, SEGMENT_COLORS, get, set, toast, useStore, type ToolId, type ViewId } from './state/store';
import * as platform from './platform';
import { appLog } from './report';
import { SAMPLE_WINDOW, loadSample, makeSample } from './sample';
import { cleanName, setSetting } from './state/settings';

let image: VolumeData | null = null;
// `mask`, `shadow` and `history` are those of the active mask: the one the tools, undo,
// the segments list, saving, autosave and rooms work on. The rest are kept in `masks`.
let mask: VolumeData | null = null;
let shadow: Uint8Array | null = null;
let history = new History();
let pointerDown = false;
let room: RoomClient | null = null;

/** One mask open on the image. For the active one the live state is in the variables above and in the store; `park` writes it back here. */
interface MaskEntry {
  id: string;
  vol: VolumeData;
  history: History;
  name: string | null;
  dirty: boolean;
  visible: boolean;
  segments: SegmentInfo[];
  activeSegment: number;
  removed: Map<number, SegmentInfo>;
  path?: string;
}
const masks = new MaskSet<MaskEntry>();
let maskSeq = 0;

export function getImage(): VolumeData | null {
  return image;
}

/** The active mask. */
export function getMask(): VolumeData | null {
  return mask;
}

/** The voxels of any open mask, for looking at from tests and the console. */
export function getMaskData(id: string): Uint8Array | null {
  return (masks.get(id)?.vol.data as Uint8Array | undefined) ?? null;
}

/**
 * What autosave listens for. `edit`: the mask or its segments changed. `opened`: an image
 * or mask finished loading. `saved`: the mask was written to a file. `discarded`: the user
 * chose not to save. `closed`: nothing is open any more.
 */
export type SessionEvent = 'edit' | 'opened' | 'saved' | 'discarded' | 'closed';
const watchers = new Set<(event: SessionEvent) => void>();

export function onSessionEvent(fn: (event: SessionEvent) => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

function emit(event: SessionEvent): void {
  for (const fn of watchers) fn(event);
}

/** True during a stroke. */
export const isPointerDown = (): boolean => pointerDown;

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

/** Reader messages that only say the bytes made no sense. They get the file name and a next step instead. */
const PARSE_FAILURE = /not a valid|incomplete or damaged|invalid image size|not a DICOM segmentation|^RLE /i;

function describeError(err: unknown, name: string): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/memory|allocation|Array buffer/i.test(text)) return 'This image is too large to open on this device.';
  if (/not a supported/i.test(text)) return `Can't open ${name}. Use MHA, NIfTI, NRRD or DICOM.`;
  // Readers word their other messages for the user (a missing data file, an unsupported compression).
  const worded = err instanceof Error && err.name === 'IoError' && !PARSE_FAILURE.test(text);
  return worded ? text : `Can't read ${name}. The file may be damaged or incomplete.`;
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
  const loaded: { vol: VolumeData; name: string; path?: string }[] = [];
  try {
    for (const group of groups) {
      const name = group[0].name;
      set({ busy: `Opening ${name}…` });
      await nextFrame();
      try {
        const vol = await readVolumeAsync(group);
        for (const warning of vol.warnings ?? []) toast('warning', warning);
        loaded.push({ vol: { ...vol, name }, name, path: group[0].path });
      } catch (err) {
        toast('error', describeError(err, name));
      }
    }
    if (loaded.length === 0) return;

    // One image and any number of masks; the rules are in files/roles.ts.
    const looks = loaded.map((l) => labelLook(l.vol.data));
    const roles = assignRoles(
      loaded.map((l, i) => ({ name: l.name, look: looks[i] })),
      { role, hasImage: !!image },
    );
    const img = roles.image === null ? undefined : loaded[roles.image];
    const msks = roles.masks.map((i) => loaded[i]);
    if (roles.extra.length > 0) toast('warning', `One image can be open at a time. ${loaded[roles.extra[0]].name} was left out.`);

    if (msks.length > 0 && !img && !image) {
      toast('error', 'Open an image first, then add the mask.');
      return;
    }
    const addMasks = async () => {
      let changed = false;
      for (const m of msks) changed = (await loadMask(m.vol, m.path)) || changed;
      return changed;
    };
    if (img) {
      const next = img;
      const go = async () => {
        await loadImage(next.vol, next.path);
        await addMasks();
        emit('opened');
      };
      if (room && image) {
        toast('error', 'Leave the room before opening another image.');
        return;
      }
      // Asked for by name (Open image) it replaces at once; dropped or handed over by the system, it asks.
      const unsaved = anyUnsaved();
      if (image && (unsaved || role !== 'image')) {
        const maybeMask = loaded.length === 1 && roles.image !== null && looks[roles.image] !== 'image';
        set({
          confirm: {
            title: 'Replace the current image?',
            body: unsaved ? 'Unsaved mask changes will be lost.' : `${next.name} will open in place of ${image.name}.`,
            confirm: 'Replace',
            danger: true,
            run: () => void guarded(go),
            // Its values could be labels: the app took it for an image, the user may know better.
            other: maybeMask
              ? { label: 'Add as mask', run: () => void guarded(async () => void ((await loadMask(next.vol, next.path)) && emit('opened'))) }
              : undefined,
          },
        });
        return;
      }
      await go();
    } else if (await addMasks()) {
      emit('opened');
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

async function loadImage(vol: VolumeData, path?: string): Promise<void> {
  set({ busy: `Opening ${vol.name}…` });
  await nextFrame();
  const renderable = toRenderable(vol);
  const range = dataRange(renderable.data);
  // CT-like data opens on a soft-tissue window; everything else on a percentile window.
  const looksLikeCt = range[0] <= -500 && range[1] > 300;
  const auto = autoWindow(renderable);
  const voi = looksLikeCt ? { lower: -160, upper: 240 } : auto;
  cancelFillPreview();
  image = renderable;
  // The smallest brush is the one that still paints a voxel of this image.
  const brushMin = minBrushSize(vol.spacing);
  // Masks belong to the image they were opened on.
  masks.clear();
  set({
    image: { name: vol.name, dims: vol.dims, range, ct: looksLikeCt, path },
    voi,
    hover: null,
    maximized: null,
    imageDimmed: false,
    brushMin,
    brushSize: cleanBrushSize(get().brushSize, brushMin),
  });
  // The viewport elements mount when `image` is set; wait for them.
  await nextFrame();
  await engine.showImage(renderable, voi);
  set({ threshold: looksLikeCt ? [100, Math.round(range[1])] : [Math.round((auto.lower + auto.upper) / 2), Math.round(range[1])] });
  installBlankMask();
  setTool('crosshair');
}

/** An empty mask on the image grid, ready to be painted on. */
function installBlankMask(): void {
  if (!image) return;
  installMask({
    name: '',
    dims: image.dims,
    spacing: image.spacing,
    origin: image.origin,
    direction: image.direction,
    data: new Uint8Array(image.dims[0] * image.dims[1] * image.dims[2]),
  });
  set({ maskName: null, dirty: false });
}

/** Adds a mask to the image and makes it the active one. True when it was added. */
async function loadMask(vol: VolumeData, path?: string): Promise<boolean> {
  if (!image) return false;
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
      return false;
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
  const next: VolumeData = { ...image, name: vol.name, data, labels: vol.labels };
  const values = labelValues(next);
  const segments: SegmentInfo[] = values.map((index) => ({
    index,
    name: vol.labels?.[index] ?? `Segment ${index}`,
    color: vol.colors?.[index] ? rgbToHex(vol.colors[index]) : SEGMENT_COLORS[(index - 1) % SEGMENT_COLORS.length],
    visible: true,
    locked: false,
  }));
  // An empty mask nobody has touched makes way. Any other stays open, as a comparison.
  const untouched = isUntouched();
  if (!untouched && masks.full) {
    toast('error', TOO_MANY_MASKS);
    return false;
  }
  if (!untouched && room) {
    // Everyone in a room edits the room's mask. This one stays on this computer, read-only, and is never sent.
    const entry = newEntry(next, path);
    Object.assign(entry, { name: vol.name, segments, activeSegment: segments[0]?.index ?? 0 });
    masks.add(entry, false);
    showOthers();
    toast('info', `${shortName(vol.name)} is shown as an outline, on this computer only. The room keeps editing its own mask.`);
    return false;
  }
  if (!untouched) park();
  installMask(next, !untouched, path);
  set({ segments, activeSegment: segments[0]?.index ?? 0, maskName: vol.name, dirty: false });
  pushSegments();
  if (room && before) {
    // Share the newly opened mask with the room as one edit.
    const patch = diffMask(before, data, sliceSize());
    if (patch) room.sendFrame(FrameKind.Patch, encodePatch(patch));
    sendSegments();
  }
  return true;
}

function rgbToHex(c: [number, number, number]): string {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/**
 * Makes `vol` the active mask, with a fresh undo history. It takes the place of the
 * active mask, or with `add` joins the list and leaves the others open for comparison.
 */
function installMask(vol: VolumeData, add = false, path?: string): void {
  const entry = newEntry(vol, path);
  const current = masks.active;
  if (current && !add) masks.replace(current.id, entry);
  else masks.add(entry, true);
  mask = vol;
  shadow = (vol.data as Uint8Array).slice();
  history = entry.history;
  removedSegments.clear();
  syncHistoryFlags();
  engine.showMask(vol);
  // A newly opened mask is shown, whatever the last one was set to.
  set({ segments: [], activeSegment: 0, maskHidden: false, newSegment: null });
  engine.setMaskStyle(get().opacity, get().outlineOnly);
  engine.set3dImageVisible(get().show3dImage);
  set({ stats: {} });
  showOthers();
  scheduleStats();
}

/* ───────────────────────── several masks ───────────────────────── */

function newEntry(vol: VolumeData, path?: string): MaskEntry {
  return { id: `m${++maskSeq}`, vol, history: new History(), name: null, dirty: false, visible: true, segments: [], activeSegment: 0, removed: new Map(), path };
}

/** True for the empty mask every image starts with, while nothing has been done to it. */
function isUntouched(): boolean {
  const s = get();
  return !s.maskName && !s.dirty && s.segments.length === 0 && !history.canUndo && !history.hasPending;
}

/** Writes the live state of the active mask back into its entry, before another one takes its place. */
function park(): void {
  const entry = masks.active;
  if (!entry || !mask) return;
  cancelFillPreview();
  flushEdits();
  history.commit();
  const s = get();
  Object.assign(entry, {
    vol: mask,
    history,
    name: s.maskName,
    dirty: s.dirty,
    visible: !s.maskHidden,
    segments: s.segments,
    activeSegment: s.activeSegment,
    removed: new Map(removedSegments),
  });
}

/** The list of masks in the store, for the Files section. */
function syncRows(): void {
  set({ masks: masks.all.map(({ id, name, dirty, visible, path }) => ({ id, name, dirty, visible, path })), activeMask: masks.active?.id ?? null });
}

/** The list in the store, and the outlines of the masks that are not being edited. */
function showOthers(): void {
  const active = masks.active?.id ?? null;
  syncRows();
  engine.showComparisons(
    masks.others.map((entry, n) => ({ id: entry.id, vol: entry.vol, color: compareColor(n), visible: entry.visible })).filter((x) => x.visible),
  );
  // Adding or removing an outline must not change how the active mask is drawn.
  if (active) pushSegments();
}

/** Puts a mask from the list in front of the tools. Its own undo history and segments come with it. */
function mount(entry: MaskEntry): void {
  mask = entry.vol;
  shadow = (entry.vol.data as Uint8Array).slice();
  history = entry.history;
  removedSegments.clear();
  for (const [index, seg] of entry.removed) removedSegments.set(index, seg);
  dirtySlices = null;
  engine.showMask(entry.vol);
  set({
    segments: entry.segments,
    activeSegment: entry.activeSegment,
    maskHidden: !entry.visible,
    newSegment: null,
    maskName: entry.name,
    dirty: entry.dirty,
    stats: {},
  });
  syncHistoryFlags();
  engine.setMaskStyle(get().opacity, get().outlineOnly);
  engine.set3dImageVisible(get().show3dImage);
  showOthers();
  scheduleStats();
  // The edit tools need a segment to paint with.
  if (EDIT_TOOLS.includes(get().tool) && entry.segments.length === 0) setTool('crosshair');
  else applyTool();
}

/** True when any open mask has edits that are not in a file. */
export function anyUnsaved(): boolean {
  return get().dirty || masks.others.some((entry) => entry.dirty);
}

/** Chooses the mask to edit. The one edited until now stays open, shown as an outline. */
export function setActiveMask(id: string): void {
  const next = masks.get(id);
  if (!next || masks.active?.id === id) return;
  if (room) {
    toast('info', "In a room everyone edits the room's mask. Leave the room to edit another one.");
    return;
  }
  park();
  masks.activate(id);
  mount(next);
}

/** Shows or hides one mask. For the active mask this is the same switch as its shortcut. */
export function setMaskVisible(id: string, visible: boolean): void {
  const entry = masks.get(id);
  if (!entry) return;
  if (masks.active?.id === id) return setMaskHidden(!visible);
  entry.visible = visible;
  showOthers();
}

/** Draws the image darker so the masks stand out, or back at full strength. */
export function setImageDimmed(imageDimmed: boolean): void {
  set({ imageDimmed });
  engine.setImageDimmed(imageDimmed);
}

/** Closes one mask, asking first when it has unsaved edits. The image always keeps one mask to edit. */
export function closeMask(id: string): void {
  const entry = masks.get(id);
  if (!entry) return;
  const active = masks.active?.id === id;
  if (active && room) {
    toast('info', "This is the room's mask. Leave the room to close it.");
    return;
  }
  if (active) park();
  const go = () => {
    masks.remove(id);
    if (!active) return showOthers();
    emit('discarded');
    const next = masks.active;
    if (next) mount(next);
    else {
      installBlankMask();
      if (EDIT_TOOLS.includes(get().tool)) setTool('crosshair');
    }
  };
  if (!entry.dirty) return go();
  set({
    confirm: {
      title: `Save changes to ${fileNameFor(entry.name)}?`,
      body: 'Your mask edits have not been saved to a file.',
      confirm: 'Save',
      run: () => void saveMaskById(id).then((saved) => saved && go()),
      other: { label: "Don't save", run: go },
    },
  });
}

export function closeImage(force = false): void {
  const go = () => {
    cancelFillPreview();
    leaveRoom(true);
    image = null;
    mask = null;
    shadow = null;
    history.clear();
    masks.clear();
    engine.unmountViewports();
    set({ image: null, maskName: null, dirty: false, segments: [], activeSegment: 0, canUndo: false, canRedo: false, hover: null, slices: {}, stats: {}, measurementsOpen: false, masks: [], activeMask: null, imageDimmed: false });
    emit('closed');
  };
  // Only the active mask can be saved from here; the others are named so nothing is lost by surprise.
  const others = masks.others.filter((entry) => entry.dirty);
  if (force !== true && others.length > 0) {
    set({
      confirm: {
        title: 'Close without saving every mask?',
        body: `${others.map((entry) => fileNameFor(entry.name)).join(', ')} ${others.length === 1 ? 'has' : 'have'} unsaved changes. To keep them, save from the Files list first.`,
        confirm: 'Close',
        danger: true,
        run: () => closeImage(true),
      },
    });
    return;
  }
  if (get().dirty) {
    set({
      confirm: {
        title: `Save changes to ${defaultMaskName()}?`,
        body: 'Your mask edits have not been saved to a file.',
        confirm: 'Save',
        run: () => void saveMask().then(() => !get().dirty && go()),
        other: {
          label: "Don't save",
          run: () => {
            emit('discarded');
            go();
          },
        },
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
  if (tool !== s.tool) cancelFillPreview(PREVIEW_CANCELLED);
  set({ tool });
  applyTool();
}

/**
 * The radius the brush tools use, in mm. The number on screen is a diameter. On a view
 * whose voxels are larger than the brush, the radius is widened to reach the voxel under
 * the cursor, so a click always paints.
 */
export function currentBrushRadius(): number {
  const s = get();
  if (!image) return s.brushSize / 2;
  const view = s.activeView === 'volume3d' ? 'axial' : s.activeView;
  return brushRadius(s.brushSize, image.spacing, sliceAxisFor(image.direction, view));
}

// Each view cuts the voxels along a different plane, so the smallest radius follows the view in use.
useStore.subscribe((now, before) => {
  if (now.activeView !== before.activeView && image) engine.setBrushSize(currentBrushRadius());
});

function applyTool(): void {
  const s = get();
  engine.setBrushSize(currentBrushRadius());
  engine.setThreshold(s.threshold);
  engine.setTool(s.tool, {
    brushShape: s.brushShape,
    scissorsShape: s.scissorsShape,
    scissorsAction: s.scissorsAction,
    scissorsDepth: s.scissorsDepth,
    fillAction: s.fillAction,
  });
}

export function setBrushSize(mm: number): void {
  set({ brushSize: cleanBrushSize(mm, get().brushMin) });
  engine.setBrushSize(currentBrushRadius());
}

export function setToolOption(
  patch: Partial<Pick<ReturnType<typeof get>, 'brushShape' | 'scissorsShape' | 'scissorsAction' | 'scissorsDepth' | 'fillAction' | 'threshold'>>,
): void {
  set(patch);
  // A sphere has no outside to erase on a slice; it goes back to erasing inside.
  if (get().scissorsShape === 'sphere' && get().scissorsAction === 'outside') set({ scissorsAction: 'erase' });
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
        endStroke();
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
/** What the stroke in hand has done so far: voxels put back by the paint over limit, and voxels it did change. */
const stroke = { limited: false, wrote: false };

/** A stroke that the paint over limit left nothing of says why. */
function endStroke(): void {
  if (stroke.limited && !stroke.wrote) limitHint();
  stroke.limited = false;
  stroke.wrote = false;
}

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
      endStroke();
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
  const s = get();
  const limit = strokeRule(s.paintOver);
  // Scissors erase the segment being edited and leave its neighbours.
  const erase = s.tool === 'scissors' && s.scissorsAction === 'erase' ? eraseRule(s.activeSegment) : null;
  const takeBack = limit && erase ? (b: number, a: number) => limit(b, a) || erase(b, a) : (limit ?? erase);
  if (takeBack && restoreWhere(data, patch, takeBack) > 0) {
    // The stroke ran over voxels it may not take: those are back, so diff again and repaint.
    const touched = patchSlices(patch, sliceSize());
    patch = diffMask(shadow, data, sliceSize(), touched);
    engine.refreshMask(touched);
    if (limit) stroke.limited = true;
    if (!patch) return;
  }
  stroke.wrote = true;
  cancelFillPreview(PREVIEW_CANCELLED);
  applyPatch(shadow, patch, 'after');
  history.add(patch);
  room?.sendFrame(FrameKind.Patch, encodePatch(patch));
  scheduleDigest();
  scheduleStats();
  if (!get().dirty) set({ dirty: true });
  syncHistoryFlags();
  emit('edit');
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
  emit('edit');
}

export function redo(): void {
  const patches = history.redo();
  if (!patches) return;
  for (const p of patches) writeOwn(p, 'after');
  set({ dirty: true });
  syncHistoryFlags();
  emit('edit');
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
  emit('edit');
  return patch.after.length;
}

/**
 * Put back a recovered mask as one undo step. In a room the others get it like any
 * other edit. Returns false when the copy does not fit the mask on screen.
 */
export function restoreMask(data: Uint8Array, segments: Omit<SegmentInfo, 'visible'>[], maskName: string | null): boolean {
  if (!mask || data.length !== mask.data.length) return false;
  editMask((d) => d.set(data));
  ensureSegments(data);
  const s = get();
  const restored = new Map(segments.map((x) => [x.index, x]));
  const shown = new Map(s.segments.map((x) => [x.index, x]));
  // Names, colours and locks come from the copy; segments that only exist on screen stay.
  const list = [...new Set([...restored.keys(), ...shown.keys()])]
    .sort((a, b) => a - b)
    .map((index) => ({ ...shown.get(index), ...restored.get(index), visible: shown.get(index)?.visible ?? true }) as SegmentInfo);
  updateSegments(list, list.some((x) => x.index === s.activeSegment) ? s.activeSegment : (list[0]?.index ?? 0));
  set({ dirty: true, maskName: s.maskName ?? maskName });
  return true;
}

/* ───────────────────────── segments ───────────────────────── */

function pushSegments(): void {
  const s = get();
  engine.applySegments(s.segments, s.activeSegment, s.maskHidden);
}

/** Turns the whole mask off or back on. Opacity, outline-only and each segment's own setting are untouched. */
export function setMaskHidden(maskHidden: boolean): void {
  set({ maskHidden });
  pushSegments();
}

/** How long a new row keeps its highlight (DESIGN.md 5.3, segment add). */
const NEW_ROW_MS = 600;

function sendSegments(): void {
  room?.send({ t: 'segments', list: get().segments });
}

function updateSegments(list: SegmentInfo[], active = get().activeSegment): void {
  set({ segments: list, activeSegment: active });
  pushSegments();
  sendSegments();
  emit('edit');
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
  // Its row animates in and holds a highlight; rows that come from a file or the room do not.
  set({ newSegment: index });
  setTimeout(() => get().newSegment === index && set({ newSegment: null }), NEW_ROW_MS);
  if (!EDIT_TOOLS.includes(s.tool)) setTool('brush');
}

export function selectSegment(index: number): void {
  if (!get().segments.some((x) => x.index === index)) return;
  if (index !== get().activeSegment) cancelFillPreview(PREVIEW_CANCELLED);
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

/** The active segment if it can be edited now; otherwise says why not and returns null. */
function activeEditable(): SegmentInfo | null {
  const s = get();
  const seg = s.segments.find((x) => x.index === s.activeSegment);
  if (!mask || !seg) {
    toast('info', 'Add a segment to start editing.');
    return null;
  }
  if (seg.locked || !seg.visible || s.maskHidden) {
    toast(
      'info',
      seg.locked ? `${seg.name} is locked. Unlock it to edit.` : s.maskHidden ? 'The mask is hidden. Show it to edit.' : `${seg.name} is hidden. Show it to edit.`,
    );
    return null;
  }
  return seg;
}

/* ───────────────────────── fill between slices ───────────────────────── */

const fillPreview = new FillPreview();
/** What the preview is drawn from. It has the mask's grid and is never the mask. */
let previewVol: VolumeData | null = null;
const PREVIEW_CANCELLED = 'Fill preview cancelled.';

/**
 * Shows what filling the gaps between painted slices of the active segment would add, in
 * the plane of the active view. Nothing is written to the mask until `applyFillPreview`.
 */
export function fillBetweenSlices(): void {
  const s = get();
  const seg = activeEditable();
  if (!mask || !seg) return;
  flushEdits();
  cancelFillPreview();
  const view = s.activeView === 'volume3d' ? 'axial' : s.activeView;
  const axis = sliceAxisFor(mask.direction, view);
  // Gaps are filled where they are empty, or inside the one segment painting is limited to.
  const writable = writableValues(typeof s.paintOver === 'number' ? s.paintOver : 'empty', s.segments);
  const shown: VolumeData = { ...mask, name: 'preview', labels: undefined, data: new Uint8Array(mask.data.length) };
  const count = fillPreview.start(mask.data as Uint8Array, mask.dims, { label: seg.index, axis, writable }, shown.data as Uint8Array);
  if (count === 0) {
    toast('info', `Paint ${seg.name} on two ${view} slices with a gap between them, then fill.`);
    return;
  }
  previewVol = shown;
  engine.showPreview(shown, seg.color);
  set({ preview: { count, view, segment: seg.index } });
}

function endPreview(): void {
  previewVol = null;
  engine.hidePreview();
  set({ preview: null });
}

/** Does the fill that is being previewed, as one undo step. It is worked out again from the mask as it is now. */
export function applyFillPreview(): void {
  const p = get().preview;
  if (!p || !mask || !previewVol) return;
  if (!activeEditable()) return cancelFillPreview();
  const shown = previewVol.data as Uint8Array;
  const { dims } = mask;
  const n = editMask((d) => {
    fillPreview.apply(d, dims, shown);
  });
  endPreview();
  if (n > 0) toast('info', `Filled ${n.toLocaleString('en-US')} voxels between ${p.view} slices`, { label: 'Undo', run: undo });
  else toast('info', 'There was nothing left to fill.');
}

/** Drops the preview. The mask was never touched. */
export function cancelFillPreview(note?: string): void {
  if (!previewVol) return;
  fillPreview.cancel(previewVol.data as Uint8Array);
  endPreview();
  if (note) toast('info', note);
}

/* ───────────────────────── outline scissors, islands, picking ───────────────────────── */

/**
 * Cuts with an outline drawn on a slice view, in the view's pixels: erases the active
 * segment inside or outside it, or fills inside it, on the slice on screen or on every slice.
 */
export async function cutOutline(view: ViewId, outline: Point[]): Promise<void> {
  const s = get();
  if (view === 'volume3d' || outline.length < 3) return;
  const seg = activeEditable();
  const frame = engine.viewFrame(view);
  if (!mask || !seg || !frame) return;
  const all = s.scissorsDepth === 'all';
  const fill = s.scissorsAction === 'fill';
  const { dims } = mask;
  const c: Cut = {
    map: viewMap(mask, frame),
    outline,
    depth: all ? null : sliceRange(mask, frame, sliceAxisFor(mask.direction, view)),
    action: fill ? 'fill' : s.scissorsAction === 'outside' ? 'eraseOutside' : 'erase',
    label: seg.index,
    writable: writableValues(s.paintOver, s.segments),
  };
  const n = await runOperation(fill ? `Filling ${seg.name}…` : `Erasing ${seg.name}…`, (d) => {
    cut(d, dims, c);
  });
  // A cut through the stack changes slices that are not on screen, so it says what it did.
  if (n > 0 && all) toast('info', `${fill ? 'Filled' : 'Erased'} ${voxels(n)} of ${seg.name} on all ${view} slices`, { label: 'Undo', run: undo });
  else if (n === 0 && fill) limitHint();
}

/** Makes the segment under a point of a slice view the active one. False when there is none to pick. */
export function pickSegmentAt(view: ViewId, x: number, y: number): boolean {
  const s = get();
  if (!mask || view === 'volume3d') return false;
  flushEdits();
  const w = engine.canvasToWorld(view, x, y);
  const index = w ? segmentAt(mask, w, s.segments, s.maskHidden) : 0;
  if (index === 0) return false;
  selectSegment(index);
  set({ pickedSegment: index });
  setTimeout(() => get().pickedSegment === index && set({ pickedSegment: null }), NEW_ROW_MS);
  return true;
}

/** Fill tool, "Remove island" and "Keep island": acts on the island of the active segment under a point of a slice view. */
export async function editIslandAt(view: ViewId, x: number, y: number): Promise<void> {
  const action = get().fillAction;
  if (action === 'fill' || view === 'volume3d') return;
  const seg = activeEditable();
  if (!mask || !seg) return;
  flushEdits();
  const w = engine.canvasToWorld(view, x, y);
  const ijk = w && voxelAt(mask, w);
  const { dims, spacing } = mask;
  if (!ijk || mask.data[ijk[0] + (ijk[1] + ijk[2] * dims[1]) * dims[0]] !== seg.index) {
    toast('info', `Click a part of ${seg.name}.`);
    return;
  }
  const n = await runOperation(`Looking for islands in ${seg.name}…`, (d) => {
    islandAt(d, dims, seg.index, ijk, action);
  });
  const size = formatVolume((n * spacing[0] * spacing[1] * spacing[2]) / 1000);
  if (n > 0) {
    toast('info', action === 'remove' ? `Removed an island of ${seg.name}, ${size}` : `Removed ${size} of ${seg.name} outside this island`, { label: 'Undo', run: undo });
  } else if (n === 0) toast('info', `${seg.name} is already one island.`);
}

/** The most new segments one split makes. */
const SPLIT_MAX = 20;
/** A split that makes more new segments than this asks first. */
const SPLIT_ASK = 5;

/** Gives every island of a segment, after the largest, a segment of its own. */
export function splitSegment(index: number): void {
  const seg = editableSegment(index);
  if (!seg || !mask) return;
  flushEdits();
  const { dims } = mask;
  const islands = countIslands(mask.data as Uint8Array, dims, index);
  if (islands < 2) {
    toast('info', islands === 0 ? `${seg.name} is empty.` : `${seg.name} is already one island.`);
    return;
  }
  const used = new Set(get().segments.map((x) => x.index));
  const free: number[] = [];
  for (let v = 1; v <= 255 && free.length < Math.min(islands - 1, SPLIT_MAX); v++) if (!used.has(v)) free.push(v);
  if (free.length === 0) {
    toast('error', 'A mask can hold up to 255 segments.');
    return;
  }
  const go = async () => {
    let made: number[] = [];
    let left = 0;
    const n = await runOperation(`Splitting ${seg.name}…`, (d) => {
      ({ labels: made, left } = splitIslands(d, dims, index, free));
    });
    if (n <= 0) return;
    const added: SegmentInfo[] = made.map((label, i) => ({
      index: label,
      name: `${seg.name} ${i + 2}`,
      color: SEGMENT_COLORS[(label - 1) % SEGMENT_COLORS.length],
      visible: true,
      locked: false,
    }));
    updateSegments([...get().segments.filter((x) => !made.includes(x.index)), ...added].sort((a, b) => a.index - b.index));
    const rest = left > 0 ? ` The ${left === 1 ? 'smallest island stays' : `${left} smallest islands stay`} in ${seg.name}.` : '';
    toast('info', `Split ${seg.name} into ${made.length + 1} segments.${rest}`, { label: 'Undo', run: undo });
  };
  const more = islands - 1 - free.length;
  if (free.length <= SPLIT_ASK && more === 0) return void go();
  set({
    confirm: {
      title: `Split ${seg.name} into ${free.length + 1} segments?`,
      body:
        more > 0
          ? `${seg.name} has ${islands.toLocaleString('en-US')} islands. The ${free.length + 1} largest become segments of their own; the rest stay in ${seg.name}.`
          : `${seg.name} has ${islands} islands. Each becomes a segment of its own.`,
      confirm: 'Split',
      run: () => void go(),
    },
  });
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

export function setPaintOver(paintOver: PaintOver): void {
  const s = get();
  limitHinted = false;
  set({ paintOver: cleanPaintOver(paintOver, s.segments, s.activeSegment) });
}

let limitHinted = false;

/** Said once per choice, when a stroke painted nothing because of the paint over limit. */
function limitHint(): void {
  const s = get();
  if (limitHinted || s.paintOver === 'all') return;
  limitHinted = true;
  const inside = s.segments.find((x) => x.index === s.paintOver);
  toast('info', inside ? `Nothing was painted: Paint over is set to Only ${inside.name}.` : 'Nothing was painted: Paint over is set to Empty only.');
}

// Painting inside a segment needs that segment, and it cannot be the one being painted.
useStore.subscribe((now, before) => {
  if (typeof now.paintOver !== 'number' || (now.segments === before.segments && now.activeSegment === before.activeSegment)) return;
  if (cleanPaintOver(now.paintOver, now.segments, now.activeSegment) === now.paintOver) return;
  set({ paintOver: 'all' });
  toast('info', 'Paint over is back to Everything.');
});

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
  return fileNameFor(get().maskName);
}

/** The file name a mask is saved under: its own when it has one in a format the app writes. */
function fileNameFor(name: string | null): string {
  if (name && /\.(nii|nii\.gz|mha|nrrd|dcm)$/i.test(name)) return name;
  return `${baseName(name ?? get().image?.name ?? 'mask')}${name ? '' : '_mask'}.nii.gz`;
}

/** Saves any open mask to a file. True when it was written. */
export async function saveMaskById(id: string): Promise<boolean> {
  const entry = masks.get(id);
  if (!entry) return false;
  if (masks.active?.id === id) {
    await saveMask();
    return !get().dirty;
  }
  try {
    const labels: Record<number, string> = {};
    const colors: Record<number, [number, number, number]> = {};
    for (const seg of entry.segments) {
      labels[seg.index] = seg.name;
      colors[seg.index] = hexToRgb(seg.color);
    }
    const saved = await platform.saveBytes(fileNameFor(entry.name), (name) =>
      writeMask({ ...entry.vol, name, labels, colors }, formatOf(name), { source: image?.dicom }),
    );
    if (!saved) return false;
    Object.assign(entry, { dirty: false, name: saved, path: platform.lastSavedPath() ?? undefined });
    syncRows();
    toast('success', `Saved to ${saved}`);
    return true;
  } catch {
    toast('error', "Couldn't save the mask. Check that the folder is writable.");
    return false;
  }
}

export async function saveMask(): Promise<void> {
  if (!mask) return;
  cancelFillPreview(PREVIEW_CANCELLED);
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
    if (masks.active) {
      masks.active.path = platform.lastSavedPath() ?? undefined;
      syncRows();
    }
    emit('saved');
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

export interface RoomStarted {
  code: string;
  link: string;
  /** True when the room is hosted here and the computer has no network address. */
  localOnly?: boolean;
}

export async function startRoom(name: string): Promise<RoomStarted | string> {
  if (!image) return 'Open an image first.';
  const server = platform.relayServer();
  hostingLocally = false;
  const code = makeCode();
  if (server) return connect(server, code, name, true);
  const hosted = await platform.hostRoom();
  if (!hosted) return "Rooms need a room server. Add one under 'Server'.";
  hostingLocally = true;
  // The host talks to its own relay over loopback; the invite carries the network address.
  const result = await connect(hosted.connect, code, name, true, hosted.share);
  return typeof result === 'string' ? result : { ...result, localOnly: hosted.localOnly };
}

export async function joinRoom(name: string, invite: string): Promise<RoomStarted | string> {
  const server = platform.relayServer() ?? '';
  const parsed = parseInvite(invite, server);
  if (!parsed) return joinProblem(invite, server);
  return connect(parsed.server, parsed.code, name, false);
}

function connect(server: string, code: string, name: string, starting: boolean, shareServer = server): Promise<RoomStarted | string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: RoomStarted | string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const link = inviteLink(shareServer, code);
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

/**
 * Opens the sample used by the welcome tour: the scan shipped with the app, on
 * a lung window, or a small phantom when that scan cannot be loaded.
 */
export async function openSample(): Promise<void> {
  const hadImage = !!image;
  set({ busy: 'Opening the sample…' });
  let sample = await loadSample();
  await openFiles(sample.files);
  if (sample.bundled && !image && !hadImage) {
    // The files were there but would not open. The phantom always does.
    sample = { files: makeSample(), bundled: false };
    await openFiles(sample.files);
  }
  if (!sample.bundled) {
    toast('info', "The sample scan couldn't be loaded. A simple test image is open instead.");
    return;
  }
  if (get().image?.name === sample.files[0].name) setVoi(SAMPLE_WINDOW.lower, SAMPLE_WINDOW.upper);
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
    emit('edit');
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
    if (!meta.resync) emit('opened');
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
  room.send({ t: 'cursor', vp, w, r: painting ? currentBrushRadius() : undefined });
}

export function roomCodeLabel(): string {
  const r = get().room;
  return r ? formatCode(r.code) : '';
}
