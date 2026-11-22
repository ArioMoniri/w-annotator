import { gzip } from 'fflate';
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
  formatVoxels,
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
  patchFits,
  applyPatchWhereUnchanged,
  decodePatch,
  diffMask,
  encodePatch,
  patchSlices,
  restoreWhere,
  splitPatch,
  type Patch,
} from './mask/patch';
import { segmentAt } from './mask/pick';
import { FillPreview } from './mask/preview';
import { cut, offScreen, sliceRange, viewMap, type Cut, type Point } from './mask/scissors';
import { CLOSE_MISFIT, RoomClient, parseRoster, type JoinMode, type TextMessage } from './collab/client';
import { makeRoomKey, unwrapRoomKey, wrapRoomKey } from './collab/crypto';
import { decodeSlice, encodeSlice, indicesForPlane, planeLength, planeSlices, readPlane, windowTo8, withNeighbours, writePlane, type Axis } from './collab/hostview';
import { inviteKeys, makeInviteSecret, makeSeed, memberId, publicKey } from './collab/identity';
import { ReplayGuard } from './collab/guard';
import { OpLog } from './collab/oplog';
import {
  FrameKind,
  NOTHING_SAVED,
  b64decode,
  b64encode,
  cleanPeerName,
  closeMessage,
  displayNames,
  inviteLink,
  makeRoomId,
  parseInvite,
  userColor,
  type FrameHeader,
  type InviteInfo,
  type Member,
  type Meta,
  type Role,
  type RoomKind,
  type SegmentInfo,
  type Welcome,
} from './collab/protocol';
import { forgetRoom, rememberRoom, savedRooms } from './collab/rooms';
import { applySegOp, parseSegOp, segmentOps, type SegOp } from './collab/segops';
import { PartAssembler, SLAB_SLICES, TokenBucket, gunzipExactly, maxPacked, slabRanges, splitParts } from './collab/transfer';
import { conflictPatch, mergeMasks, mergeSummary, type Conflicts } from './mask/merge';
import { fingerprint } from './mask/recovery';
import * as engine from './viewer/engine';
import { indexToWorld, voxelAt } from './viewer/geometry';
import { mrWindows, sampleValues } from './viewer/window';
import { EDIT_TOOLS, SEGMENT_COLORS, dropToastActions, get, set, toast, useStore, type Peer, type RoomState, type ToolId, type ViewId } from './state/store';
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
let room: RoomCtx | null = null;

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
  if (isGuestView()) {
    toast('info', "Leave the room to open files. Here you see the host's image through their computer.");
    return;
  }
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
  // What was kept of a room belonged to the image before this one.
  kept = null;
  // The smallest brush is the one that still paints a voxel of this image.
  const brushMin = minBrushSize(vol.spacing);
  // Masks belong to the image they were opened on.
  masks.clear();
  set({
    image: { name: vol.name, dims: vol.dims, range, ct: looksLikeCt, auto, mr: mrWindows(sampleValues(renderable.data, 200_003)), path },
    windowSet: null,
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
    for (const seg of segments) roomSend({ k: 'seg', op: { op: 'set', seg: sharedSegment(seg) } });
    const patch = diffMask(before, data, sliceSize());
    if (patch) roomSend({ k: 'patch', patch });
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

/** Lets go of the image and everything opened on it, without asking. */
function dropImage(): void {
  if (!image) return;
  cancelFillPreview();
  leaveRoom(true);
  // Leaving as a guest of a view-through-host room has already let go of everything.
  if (!image) return;
  kept = null;
  image = null;
  mask = null;
  shadow = null;
  history.clear();
  masks.clear();
  engine.unmountViewports();
  set({ image: null, maskName: null, dirty: false, segments: [], activeSegment: 0, canUndo: false, canRedo: false, hover: null, slices: {}, stats: {}, measurementsOpen: false, masks: [], activeMask: null, imageDimmed: false });
  emit('closed');
}

export function closeImage(force = false): void {
  const go = dropImage;
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
  retireUndoToasts();
  applyPatch(shadow, patch, 'after');
  history.add(patch);
  roomSend({ k: 'patch', patch });
  scheduleStats();
  if (!get().dirty && !isGuestView()) set({ dirty: true });
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
  roomSend({ k: 'patch', patch: written });
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
  // A segment brought back by undo gets its name and colour back for everyone.
  for (const x of added) if (removedSegments.has(x.index)) roomSend({ k: 'seg', op: { op: 'set', seg: sharedSegment(x) } });
}

/**
 * Undo on a toast means the step the toast describes. Once that is no longer the newest
 * step (another edit, an undo or a redo), the button goes and the message stays.
 */
function retireUndoToasts(): void {
  dropToastActions((a) => a.run === undo);
}

/** The segments a split made, by the patch that made them, so undoing that patch takes them out of the list too. */
const madeBySplit = new WeakMap<Patch, { from: number; labels: number[] }>();

/**
 * After a split's patch was undone: the segments it made leave the list, in a room for
 * everyone. One that still holds voxels, because someone else has painted in it since, stays.
 * What they looked like is kept, so redo brings them back with the same name and colour.
 */
function dropSplitSegments(patch: Patch): void {
  const made = madeBySplit.get(patch);
  if (!made || !mask) return;
  const data = mask.data as Uint8Array;
  const inUse = new Uint8Array(256);
  for (let i = 0; i < data.length; i++) inUse[data[i]] = 1;
  const s = get();
  const gone = s.segments.filter((x) => made.labels.includes(x.index) && !inUse[x.index]);
  if (gone.length === 0) return;
  for (const seg of gone) removedSegments.set(seg.index, { ...seg, visible: true });
  const rest = s.segments.filter((x) => !gone.includes(x));
  const kept = rest.some((x) => x.index === s.activeSegment);
  // With the segment in hand gone, the one it was split from is in hand again.
  const active = kept ? s.activeSegment : rest.some((x) => x.index === made.from) ? made.from : (rest[0]?.index ?? 0);
  updateSegments(rest, active);
}

export function undo(): void {
  flushEdits();
  // A preview was worked out from the mask as it was; it goes before the mask changes under it.
  cancelFillPreview(PREVIEW_CANCELLED);
  const patches = history.undo();
  if (!patches) return;
  retireUndoToasts();
  for (const p of patches) {
    writeOwn(p, 'before');
    dropSplitSegments(p);
  }
  set({ dirty: !isGuestView() });
  syncHistoryFlags();
  emit('edit');
}

export function redo(): void {
  flushEdits();
  cancelFillPreview(PREVIEW_CANCELLED);
  const patches = history.redo();
  if (!patches) return;
  retireUndoToasts();
  for (const p of patches) writeOwn(p, 'after');
  set({ dirty: !isGuestView() });
  syncHistoryFlags();
  emit('edit');
}

/** The patch of the last direct edit, for a caller that ties more to that undo step. */
let lastEdit: Patch | null = null;

/** Run a direct edit of the mask buffer as one undo step. Returns changed voxel count. */
function editMask(fn: (data: Uint8Array) => void): number {
  if (!mask || !shadow) return 0;
  flushEdits();
  history.commit();
  lastEdit = null;
  fn(mask.data as Uint8Array);
  const patch = diffMask(shadow, mask.data as Uint8Array, sliceSize());
  if (!patch) return 0;
  retireUndoToasts();
  lastEdit = patch;
  applyPatch(shadow, patch, 'after');
  history.add(patch);
  history.commit();
  roomSend({ k: 'patch', patch });
  engine.refreshMask(patchSlices(patch, sliceSize()));
  set({ dirty: !isGuestView() });
  syncHistoryFlags();
  scheduleStats();
  emit('edit');
  return patch.after.length;
}

/**
 * Put back a recovered mask as one undo step. In a room the others get it like any
 * other edit. Returns false when the copy does not fit the mask on screen.
 */
export function restoreMask(data: Uint8Array, segments: Omit<SegmentInfo, 'visible'>[], maskName: string | null): boolean {
  if (!mask || data.length !== mask.data.length || isGuestView()) return false;
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

function updateSegments(list: SegmentInfo[], active = get().activeSegment): void {
  const before = get().segments;
  set({ segments: list, activeSegment: active });
  pushSegments();
  // The room hears about each segment that changed, not the whole list.
  for (const op of segmentOps(before, list)) roomSend({ k: 'seg', op });
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
  if (isGuestView()) {
    toast('info', WHOLE_MASK_OFF);
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
  set({ preview: { count, size: volumeOf(count), view, segment: seg.index } });
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
  if (n > 0) toast('info', `Filled ${volumeOf(n)} between ${p.view} slices`, { label: 'Undo', run: undo });
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
  // Erasing outside the outline on one slice also takes what is beyond the edge of a zoomed-in view.
  const size = c.action === 'eraseOutside' && !all ? engine.viewSize(view) : null;
  let unseen = 0;
  const n = await runOperation(fill ? `Filling ${seg.name}…` : `Erasing ${seg.name}…`, (d) => {
    if (size) unseen = offScreen(d, dims, c, size);
    cut(d, dims, c);
    if (size && unseen > 0) unseen -= offScreen(d, dims, c, size);
  });
  // A cut that changed what is not on screen says what it did: other slices, or parts out of view.
  if (n > 0 && all) toast('info', `${fill ? 'Filled' : 'Erased'} ${volumeOf(n)} of ${seg.name} on all ${view} slices`, { label: 'Undo', run: undo });
  else if (n > 0 && unseen > 0) toast('info', `Erased ${volumeOf(n)} of ${seg.name} on this slice, some of it outside the view`, { label: 'Undo', run: undo });
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
  const size = formatVoxels(n, spacing);
  if (n > 0) {
    // One click on a segment in one piece takes all of it, so the toast says so.
    const whole = action === 'remove' && !(mask.data as Uint8Array).includes(seg.index);
    const text = whole ? `Removed all of ${seg.name}, ${size}. It was one island.` : action === 'remove' ? `Removed an island of ${seg.name}, ${size}` : `Removed ${size} of ${seg.name} outside this island`;
    toast('info', text, { label: 'Undo', run: undo });
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
    if (lastEdit) madeBySplit.set(lastEdit, { from: index, labels: made });
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
  if (isGuestView()) {
    // A guest holds only the planes they have looked at, so an operation on the whole mask would work on gaps.
    toast('info', WHOLE_MASK_OFF);
    return -1;
  }
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

/** How much `n` voxels of the open mask are, in mL or mm³, as the measurements write a volume. */
const volumeOf = (n: number) => formatVoxels(n, mask?.spacing ?? [1, 1, 1]);

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
      done: (n) => `Filled ${volumeOf(n)} in ${name}`,
      none: `No holes in ${name}.`,
    },
    keepLargest: {
      busy: `Looking for islands in ${name}…`,
      run: (d) => keepLargestIsland(d, dims, index),
      done: (n) => `Removed ${volumeOf(n)} outside the largest island of ${name}`,
      none: `${name} is already one island.`,
    },
    removeSmall: {
      busy: `Looking for islands in ${name}…`,
      run: (d) => removeSmallIslands(d, dims, spacing, index, amount),
      done: (n) => `Removed ${volumeOf(n)} in small islands of ${name}`,
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
  if (n > 0) toast('info', `Added ${from.name} to ${seg.name}, ${volumeOf(n)}`, { label: 'Undo', run: undo });
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
  // A guest of a view-through-host room holds only the planes they have looked at:
  // a volume measured from those would be wrong, so none is shown.
  if (!mask || isGuestView()) {
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
  if (isGuestView()) {
    toast('info', WHOLE_MASK_OFF);
    return;
  }
  flushEdits();
  const found = refreshStats().find((s) => s.label === index);
  if (!found) {
    toast('info', `${seg.name} is empty.`);
    return;
  }
  engine.jumpTo(indexToWorld(mask, found.centre));
}

export function openMeasurements(): void {
  if (isGuestView()) {
    toast('info', WHOLE_MASK_OFF);
    return;
  }
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
  if (isGuestView()) {
    toast('info', SAVE_OFF);
    return false;
  }
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
  if (isGuestView()) {
    toast('info', SAVE_OFF);
    return;
  }
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

/* ───────────────────────── rooms ───────────────────────── */

const DTYPES: Record<string, new (length: number) => ScalarArray> = {
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bytesOf(d: ScalarArray): Uint8Array {
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

/** Largest image a shared-copy room will send (`ROOMS.md` C10). */
const ROOM_IMAGE_LIMIT = 2 * 1024 ** 3;
/** Encoded size of one edit on the wire; the relay takes 2 MiB a message. */
const PATCH_BYTES = 1 << 20;
/** A guest of a view-through-host room who cannot reach the host has what is in memory cleared after this long. */
const HOST_LOST_MS = 15_000;
const SAVE_OFF = "Saving is off in this room. The mask is kept on the host's computer.";
const WHOLE_MASK_OFF = "This works on the whole mask, which stays on the host's computer.";

/** One edit in a room's order. `none` holds the place of an edit that could not be read. */
type RoomOp = ({ k: 'patch'; patch: Patch } | { k: 'seg'; op: SegOp } | { k: 'none' }) & {
  /** Who made the edit, the tag of their visit and its number in that visit: what tells a repeat from a new edit. */
  sig?: [from: number, tag: string, n: number];
};

/** Edits kept while the mask is still on its way. Past this the transfer starts again rather than fill the memory. */
const QUEUE_LIMIT_BYTES = 64 << 20;
const QUEUE_LIMIT_FRAMES = 4096;
/** A member sending the image to several people at once would slow every one of them. */
const MAX_TRANSFERS = 2;
/** Sent and not yet reported as received, per transfer, when the receiver reports. Well under the relay's queue of 16 MiB. */
const TRANSFER_WINDOW = 4 << 20;
/** A receiver that reports nothing for this long has gone. */
const TRANSFER_STALL_MS = 20_000;

/** A number nobody else can guess, for matching an answer to its question. */
function randomId(): number {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return (a & 0x1fffff) * 2 ** 32 + b;
}

interface SyncBegin {
  head: number;
  segments: SegmentInfo[];
  dims: [number, number, number];
  /** The sender's list of edits already in the mask (`ReplayGuard`). */
  seen: unknown;
}

/** Getting the mask, and the image when it is not open yet, from another member. */
interface SyncJob {
  rid: number;
  source: number;
  tried: Set<number>;
  /** `new`: take the room's mask. `three`: merge against my base. `two`: no shared base, every difference is kept aside. */
  merge: 'new' | 'three' | 'two';
  begin: SyncBegin | null;
  imageMeta: { dims: [number, number, number]; spacing: [number, number, number]; origin: [number, number, number]; direction: number[] } | null;
  imageData: ScalarArray | null;
  dtype: string | null;
  theirs: Uint8Array | null;
  parts: PartAssembler;
  /** Slabs that have arrived, as `i<z0>` for the image and `m<z0>` for the mask, and how many there must be. */
  got: Set<string>;
  want: number;
  /** Packed bytes received. */
  received: number;
  /** True when the sender waits to hear how much has arrived before sending more. */
  flow: boolean;
  work: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The image slabs of a transfer that was cut, so the next try only fetches the rest. */
interface PartialImage {
  meta: NonNullable<SyncJob['imageMeta']>;
  dtype: string;
  data: ScalarArray;
  got: Set<number>;
}

/** One transfer this device is sending. */
interface Serving {
  rid: unknown;
  sent: number;
  acked: number;
  ackedAt: number;
  cancelled: boolean;
}

interface RoomCtx {
  client: RoomClient;
  id: string;
  server: string;
  /** The address that goes into invite links; differs from `server` when this computer hosts. */
  shareServer: string;
  hosting: boolean;
  kind: RoomKind;
  role: Role;
  selfId: number;
  seed: Uint8Array;
  key: Uint8Array | null;
  /** The secret of the link this device joined with, until the room key is unwrapped. */
  secret: Uint8Array | null;
  creator: boolean;
  welcomed: boolean;
  name: string;
  log: OpLog<RoomOp>;
  /** The mask as the room has confirmed it, without my unnumbered edits. Not kept by a guest of a view-through-host room. */
  synced: Uint8Array | null;
  /** While catching up after being away: the mask the room had when I left, and its place in the order. */
  base: Uint8Array | null;
  baseHead: number;
  /** The request id of the replay that is bringing `synced` up to date. */
  catching: number | null;
  session: string | null;
  /** True when my mask reflects the room and edits flow both ways. */
  ready: boolean;
  offline: boolean;
  queued: { seq: number; op: RoomOp; settles?: number }[];
  queuedBytes: number;
  /** The highest sequence number the relay has shown this device. */
  topSeq: number;
  /** A tag for this visit to the room; with an edit's number it tells a repeat from a new edit. */
  tag: string;
  guard: ReplayGuard;
  sync: SyncJob | null;
  partial: PartialImage | null;
  serving: Map<number, Serving>;
  roster: Member[];
  names: Map<number, string>;
  greeted: Set<number>;
  quietUntil: number;
  quietMerge: boolean;
  /** Segments I changed while edits could not be sent. */
  offlineSegs: Set<number>;
  /** Invite links made here, by invite id, so the list can offer them again. */
  links: Map<string, string>;
  selfEnded: boolean;
  settle: ((result: true | string) => void) | null;
  /* Host of a view-through-host room. */
  seen: Map<number, Set<string>>;
  buckets: Map<number, TokenBucket>;
  /* Guest of a view-through-host room. */
  have: Set<string>;
  asked: Map<string, { at: number; q: number }>;
  describeQ: number;
  askBucket: TokenBucket;
  pump: ReturnType<typeof setInterval> | null;
  lostTimer: ReturnType<typeof setTimeout> | null;
  work: Promise<void>;
}

/** What is left of a shared-copy room after leaving it, so coming back merges instead of replacing. */
let kept: { id: string; session: string | null; synced: Uint8Array; head: number; offlineSegs: Set<number>; guard: ReplayGuard } | null = null;
/** My voxels the last merge put aside, waiting for "Use mine" or "Keep the room's". */
let conflicts: Conflicts | null = null;
let nextRid = 1;

/** True for a guest of a view-through-host room: nothing may be kept on this device. */
export function isGuestView(): boolean {
  return !!room && room.welcomed && room.kind === 'host-view' && room.role !== 'host';
}

function patchRoom(patch: Partial<RoomState>): void {
  const r = get().room;
  if (r) set({ room: { ...r, ...patch } });
}

const sharedSegment = ({ index, name, color, locked }: SegmentInfo) => ({ index, name, color, locked });
const hostOf = (r: RoomCtx) => r.roster.find((m) => m.role === 'host');
const hostName = (r: RoomCtx) => {
  const host = hostOf(r);
  return host && host.id !== r.selfId ? (r.names.get(host.id) ?? null) : null;
};

export interface RoomStarted {
  kind: RoomKind;
  /** The first invite link. Each link works once. */
  link: string;
  /** True when the room is hosted here and the computer has no network address. */
  localOnly?: boolean;
}

export async function startRoom(name: string, kind: RoomKind = 'shared'): Promise<RoomStarted | string> {
  if (!image || !mask) return 'Open an image first.';
  if (kind === 'shared' && image.data.byteLength > ROOM_IMAGE_LIMIT) return 'This image is too large to share in a room (limit 2 GB).';
  let server = platform.relayServer();
  let share = server;
  let hosted: Awaited<ReturnType<typeof platform.hostRoom>> = null;
  if (!server) {
    hosted = await platform.hostRoom();
    if (!hosted) return "Rooms need a room server. Add one under 'Server'.";
    // The host talks to its own relay over loopback; the invite carries the network address.
    server = hosted.connect;
    share = hosted.share;
  }
  const entered = await enterRoom({
    server,
    shareServer: share ?? server,
    hosting: !!hosted,
    id: makeRoomId(),
    seed: makeSeed(),
    key: makeRoomKey(),
    mode: { t: 'create', type: kind },
    name,
  });
  if (typeof entered === 'string') return entered;
  const link = await createInvite();
  if (!link) return "The room started, but the invite link couldn't be made. Try again from the room menu.";
  return { kind, link, localOnly: hosted?.localOnly };
}

const JOIN_HELP = 'Paste the whole invite link, including the part after #.';

export async function joinRoom(name: string, invite: string): Promise<true | string> {
  const parsed = parseInvite(invite);
  if (!parsed) return JOIN_HELP;
  const blocked = joinBlocked(parsed.room);
  if (blocked) return blocked;
  // Someone who is already a member signs in with their own key; the link is not spent again.
  const known = savedRooms().find((r) => r.id === parsed.room);
  const seed = known ? b64decode(known.seed) : null;
  return enterRoom({
    server: parsed.server,
    shareServer: parsed.server,
    hosting: false,
    id: parsed.room,
    seed: seed ?? makeSeed(),
    key: (seed && known && b64decode(known.key)) || null,
    mode: { t: 'redeem', secret: parsed.secret },
    name,
    // Only shared-copy rooms are remembered, and a room never changes its kind or its host.
    known: seed && known ? { kind: 'shared', host: known.role === 'host' } : undefined,
  });
}

/** Back into a shared-copy room this device is already a member of. */
export async function rejoinRoom(name: string, id: string): Promise<true | string> {
  const known = savedRooms().find((r) => r.id === id);
  const seed = known && b64decode(known.seed);
  const key = known && b64decode(known.key);
  if (!known || !seed || !key) return 'This room is no longer on this device. Ask the host for a new invite link.';
  const blocked = joinBlocked(id);
  if (blocked) return blocked;
  return enterRoom({ server: known.server, shareServer: known.server, hosting: false, id, seed, key, mode: { t: 'auth' }, name, known: { kind: 'shared', host: known.role === 'host' } });
}

export function forgetSavedRoom(id: string): void {
  forgetRoom(id);
  if (kept?.id === id) kept = null;
}

/** Joining can replace the mask on screen, so unsaved work is saved first, unless it can be merged. */
function joinBlocked(id: string): string | null {
  if (room) return 'Leave the room you are in first.';
  if (image && anyUnsaved() && kept?.id !== id) return 'Save your mask first, then join.';
  return null;
}

interface EnterOptions {
  server: string;
  shareServer: string;
  hosting: boolean;
  id: string;
  seed: Uint8Array;
  key: Uint8Array | null;
  mode: JoinMode;
  name: string;
  known?: { kind?: RoomKind; host?: boolean };
}

function enterRoom(o: EnterOptions): Promise<true | string> {
  return new Promise((resolve) => {
    const prior = kept && kept.id === o.id && mask && kept.synced.length === mask.data.length ? kept : null;
    kept = null;
    const client = new RoomClient(
      o.server,
      o.id,
      o.seed,
      o.mode,
      o.key,
      {
        onStatus: (status) => r === room && onRoomStatus(r, status),
        onWelcome: (msg, first) => r === room && onWelcome(r, msg, first),
        onText: (msg) => r === room && onRoomText(r, msg),
        onFrame: (header, meta, body) => r === room && onRoomFrame(r, header, meta, body),
        onEnded: (code, reason) => r === room && onRoomEnded(r, code, reason),
        members: () => r.roster.filter((m) => m.role !== 'host').map((m) => ({ key: m.key, role: m.role as 'editor' | 'viewer' })),
      },
      o.known,
    );
    const r: RoomCtx = {
      client,
      id: o.id,
      server: o.server,
      shareServer: o.shareServer,
      hosting: o.hosting,
      kind: o.mode.t === 'create' ? o.mode.type : 'shared',
      role: o.mode.t === 'create' ? 'host' : 'editor',
      selfId: memberId(publicKey(o.seed)),
      seed: o.seed,
      key: o.key,
      secret: o.mode.t === 'redeem' ? o.mode.secret : null,
      creator: o.mode.t === 'create',
      welcomed: false,
      name: o.name,
      log: new OpLog<RoomOp>({
        confirm: (op, _own, shown) => confirmOp(r, op, shown),
        reapply: (op) => reapplyOp(r, op),
        replay: (after) => client.send({ t: 'replay', after }),
      }),
      synced: prior?.synced ?? null,
      base: null,
      baseHead: 0,
      catching: null,
      session: prior?.session ?? null,
      ready: false,
      offline: false,
      queued: [],
      queuedBytes: 0,
      topSeq: 0,
      tag: b64encode(crypto.getRandomValues(new Uint8Array(9))),
      guard: prior?.guard ?? new ReplayGuard(),
      sync: null,
      partial: null,
      serving: new Map(),
      roster: [],
      names: new Map(),
      greeted: new Set(),
      quietUntil: 0,
      quietMerge: false,
      offlineSegs: prior?.offlineSegs ?? new Set(),
      links: new Map(),
      selfEnded: false,
      settle: resolve,
      seen: new Map(),
      buckets: new Map(),
      have: new Set(),
      asked: new Map(),
      describeQ: 0,
      // The relay allows a guest 30 requests at once and 600 a minute; stay under it.
      askBucket: new TokenBucket(24, 9, performance.now()),
      pump: null,
      lostTimer: null,
      work: Promise.resolve(),
    };
    if (prior) r.log.reset(prior.head);
    room = r;
    conflicts = null;
    set({
      room: { status: 'connecting', id: o.id, kind: r.kind, role: r.role, selfId: r.selfId, name: o.name, hosting: o.hosting, hostName: null, hostAway: false, veil: null, hostVoi: null, review: null, note: null },
      peers: [],
    });
    client.connect();
  });
}

function settle(r: RoomCtx, result: true | string): void {
  const done = r.settle;
  r.settle = null;
  done?.(result);
}

/** Lets go of a room. `keep` remembers a shared copy's base so coming back merges; `wipe` clears a guest's memory. */
function teardown(r: RoomCtx, opts: { keep?: boolean; wipe?: boolean } = {}): void {
  r.client.close();
  if (r.pump) clearInterval(r.pump);
  if (r.lostTimer) clearTimeout(r.lostTimer);
  if (r.sync?.timer) clearTimeout(r.sync.timer);
  for (const s of r.serving.values()) s.cancelled = true;
  r.serving.clear();
  r.partial = null;
  const base = r.base ?? r.synced;
  if (opts.keep && r.kind === 'shared' && base && image && r.session) {
    // Edits the room has not numbered are simply part of my mask again.
    for (const op of r.log.unconfirmed()) noteOfflineSeg(r, op);
    kept = { id: r.id, session: r.session, synced: base, head: r.base ? r.baseHead : r.log.head, offlineSegs: r.offlineSegs, guard: r.guard };
  }
  if (room === r) room = null;
  conflicts = null;
  set({ room: null, peers: [], progress: null, busy: get().busy && r.sync ? null : get().busy });
  if (r.hosting) void platform.stopHosting();
  if (opts.wipe) wipeGuestCopy();
}

/** A guest of a view-through-host room keeps nothing: the pictures and labels in memory are zeroed and let go. */
function wipeGuestCopy(): void {
  if (image) bytesOf(image.data).fill(0);
  if (mask) (mask.data as Uint8Array).fill(0);
  shadow?.fill(0);
  dropImage();
}

export function leaveRoom(silent = false): void {
  const r = room;
  if (!r) return;
  const guest = isGuestView();
  teardown(r, { keep: true, wipe: guest });
  if (!silent) toast('info', guest ? `You left the room. ${NOTHING_SAVED}` : r.kind === 'host-view' && r.role === 'host' ? 'The room has ended.' : 'You left the room');
}

/** Host only. Ends the room for everyone: closes a view-through-host session, deletes a shared-copy room. */
export function endRoom(): void {
  const r = room;
  if (!r || r.role !== 'host') return;
  if (!r.client.open) {
    toast('error', "You're offline, so the room can't be ended now. Reconnect and try again.");
    return;
  }
  r.selfEnded = true;
  r.client.send({ t: r.kind === 'host-view' ? 'room-close' : 'room-delete' });
}

/** Host only. The person is disconnected and their key never works again. */
export async function removeMember(id: number): Promise<boolean> {
  const r = room;
  if (!r || r.role !== 'host') return false;
  const name = get().peers.find((p) => p.id === id)?.name ?? 'This person';
  const answer = await r.client.request({ t: 'member-remove', member: id });
  if (answer.t !== 'ok') {
    toast('error', `${name} couldn't be removed. Check your connection and try again.`);
    return false;
  }
  toast('info', `${name} was removed`);
  return true;
}

export interface InviteRow extends InviteInfo {
  /** The link, when it was made on this device in this session. */
  link: string | null;
}

/** Host only. A new link that works once and stops working after `ttl` seconds (a day unless said otherwise). */
export async function createInvite(ttl = 86_400): Promise<string | null> {
  const r = room;
  if (!r || r.role !== 'host' || !r.key) return null;
  const secret = makeInviteSecret();
  const keys = inviteKeys(secret);
  const answer = await r.client.request({
    t: 'invite-add',
    id: keys.id,
    authKey: b64encode(keys.authKey),
    wrappedKey: wrapRoomKey(keys.wrapKey, r.key),
    role: 'editor',
    ttl,
    maxUses: 1,
  });
  if (answer.t !== 'invite-added') return null;
  const link = inviteLink(r.shareServer, r.id, secret);
  r.links.set(keys.id, link);
  return link;
}

export async function listInvites(): Promise<InviteRow[]> {
  const r = room;
  if (!r || r.role !== 'host') return [];
  const answer = await r.client.request({ t: 'invite-list' });
  const list = answer.t === 'invites' && Array.isArray(answer.list) ? (answer.list as InviteInfo[]) : [];
  return list.map((i) => ({ ...i, link: r.links.get(i.id) ?? null }));
}

export async function revokeInvite(id: string): Promise<boolean> {
  const r = room;
  if (!r || r.role !== 'host') return false;
  return (await r.client.request({ t: 'invite-revoke', id })).t === 'ok';
}

// Closing the window is a clean exit: the relay hears a proper goodbye, so the guests of a
// view-through-host room are let go at once instead of after the 15 seconds a lost host gets.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const r = room;
    if (!r) return;
    if (r.kind === 'host-view' && r.role === 'host') r.client.send({ t: 'room-close' });
    r.client.close();
  });
}

export function reconnectRoom(): void {
  room?.client.reconnectNow();
}

/* ── connection ── */

function onRoomStatus(r: RoomCtx, status: 'connecting' | 'online' | 'offline'): void {
  patchRoom({ status });
  if (status !== 'offline' || r.offline || !r.welcomed) return;
  r.offline = true;
  r.ready = false;
  r.catching = null;
  if (r.sync?.timer) clearTimeout(r.sync.timer);
  if (r.sync) {
    // The image slabs that arrived are kept, so the next try fetches only the rest.
    stashPartial(r, r.sync);
    set({ busy: null, progress: null });
  }
  r.sync = null;
  r.queued = [];
  r.queuedBytes = 0;
  for (const s of r.serving.values()) s.cancelled = true;
  r.serving.clear();
  if (isGuestView()) {
    // This device's own connection is down. Whether the host is still there cannot be known from here,
    // so nothing is said about the host: the view is covered, the app keeps trying, and the guest stays
    // a member. What is in memory is cleared after a while, as it is when a room ends; it is fetched
    // again on return. If the room did end meanwhile, the room server says so on reconnecting.
    patchRoom({ veil: OFFLINE_VEIL });
    r.lostTimer ??= setTimeout(() => room === r && clearGuestPictures(r), HOST_LOST_MS);
    r.log.reset(r.log.head);
    return;
  }
  if (r.base) {
    // Cut off while catching up: start again from the same base next time.
    r.synced = r.base;
    r.base = null;
    r.log.reset(r.baseHead);
  } else {
    for (const op of r.log.unconfirmed()) noteOfflineSeg(r, op);
    r.log.reset(r.log.head);
  }
  toast('warning', r.kind === 'shared' ? 'Connection lost. Keep working: your changes are merged when you reconnect.' : 'Connection lost. Reconnecting…');
}

const waitingText = (r: RoomCtx) => `Waiting for ${hostName(r) ?? 'the host'}…`;
const OFFLINE_VEIL = 'Offline. Reconnecting…';

/** A guest long out of reach of the host: the pictures and labels in memory are zeroed. The image stays open, empty, to be filled again. */
function clearGuestPictures(r: RoomCtx): void {
  r.lostTimer = null;
  if (!isGuestView() || !r.offline) return;
  if (image) bytesOf(image.data).fill(0);
  if (mask) (mask.data as Uint8Array).fill(0);
  shadow?.fill(0);
  r.have.clear();
  r.asked.clear();
  engine.refreshImage();
  engine.refreshMask();
  patchRoom({ veil: `${OFFLINE_VEIL} What you were shown has been cleared from this device.` });
}

function noteOfflineSeg(r: RoomCtx, op: RoomOp): void {
  if (op.k !== 'seg') return;
  if (op.op.op === 'set') r.offlineSegs.add(op.op.seg.index);
  else if (op.op.op === 'del') r.offlineSegs.add(op.op.index);
}

function onWelcome(r: RoomCtx, w: Welcome, first: boolean): void {
  r.offline = false;
  if (r.lostTimer) clearTimeout(r.lostTimer);
  r.lostTimer = null;
  r.welcomed = true;
  r.selfId = w.self.id;
  r.role = w.self.role;
  r.kind = w.room.type;
  r.roster = w.roster;
  if (!r.key && r.secret && w.invite) {
    r.key = unwrapRoomKey(inviteKeys(r.secret).wrapKey, w.invite.wrappedKey);
    if (r.key) r.client.setKey(r.key);
  }
  r.secret = null;
  if (!r.key) {
    // A member, but without the room key: the link was used on another device.
    teardown(r);
    settle(r, closeMessage(4408, 'invite already used', { host: null, kind: null }));
    return;
  }
  const remade = r.session !== null && r.session !== w.room.session;
  r.session = w.room.session;
  r.topSeq = remade ? w.room.head : Math.max(r.topSeq, w.room.head);
  r.quietUntil = performance.now() + 3000;
  patchRoom({ status: 'online', kind: r.kind, role: r.role, selfId: r.selfId, hostAway: w.room.state === 'host-away', veil: null, note: null });
  syncPeople(r);
  sayHi(r);
  rememberThis(r);
  if (r.kind === 'host-view' && r.role !== 'host') {
    settle(r, true);
    guestEnter(r, w.room.state === 'host-away');
    return;
  }
  if (image && mask && r.role === 'host' && ((first && r.creator) || remade)) {
    // This computer is the reference: the room starts from the mask on screen.
    flushEdits();
    r.synced = (mask.data as Uint8Array).slice();
    r.log.reset(w.room.head);
    r.ready = true;
    settle(r, true);
    return;
  }
  settle(r, true);
  if (r.synced && !remade) catchUpByReplay(r);
  else if (r.synced || (image && !isUntouched())) startSync(r, 'two');
  else startSync(r, 'new');
}

function rememberThis(r: RoomCtx): void {
  // A view-through-host room is one session and leaves nothing behind.
  if (r.kind !== 'shared' || !r.key) return;
  rememberRoom({ id: r.id, server: r.server, role: r.role, seed: b64encode(r.seed), key: b64encode(r.key), host: hostName(r), at: Date.now() });
}

function onRoomEnded(r: RoomCtx, code: number, reason: string): void {
  const wasIn = r.welcomed;
  const guest = isGuestView();
  const rejoin = !wasIn && !r.secret && !r.creator;
  const text = r.selfEnded
    ? null
    : rejoin && code === 4404
      ? 'This room is not open right now. Ask the host to open it again.'
      : wasIn && r.role === 'host' && code === 4410
        ? 'The room ended while you were disconnected. Start a new room to carry on together.'
        : closeMessage(code, reason, { host: hostName(r), kind: wasIn ? r.kind : null });
  // A guest of a view-through-host room is wiped even when the room server's answer made no sense.
  if (code === CLOSE_MISFIT && !guest && r.kind === 'host-view' && r.role !== 'host') wipeGuestCopy();
  // The membership is over: nothing to come back to.
  const gone = [4401, 4403, 4410].includes(code);
  teardown(r, { wipe: guest, keep: !gone });
  if (gone) forgetSavedRoom(r.id);
  if (r.settle) settle(r, text ?? 'The room has ended.');
  else if (text) toast('error', text);
  else toast('info', 'The room has ended for everyone.');
}

function onRoomText(r: RoomCtx, msg: TextMessage): void {
  switch (msg.t) {
    case 'ack':
      if (Number.isSafeInteger(msg.seq)) r.topSeq = Math.max(r.topSeq, Number(msg.seq));
      r.log.ack(Number(msg.cid), Number(msg.seq));
      break;
    case 'roster': {
      const before = new Set(r.roster.map((m) => m.id));
      r.roster = parseRoster(msg.members) ?? r.roster;
      syncPeople(r);
      // Someone new needs to hear my name.
      if (r.roster.some((m) => !before.has(m.id))) sayHi(r);
      break;
    }
    case 'presence': {
      const id = Number(msg.member);
      r.roster = r.roster.map((m) => (m.id === id ? { ...m, online: !!msg.online } : m));
      if (msg.online) sayHi(r);
      else {
        const name = get().peers.find((p) => p.id === id)?.name;
        // A shared-copy room goes on without its host; say what does not until they are back.
        const wasHost = r.kind === 'shared' && id === hostOf(r)?.id;
        if (name && r.greeted.delete(id)) toast('info', wasHost ? `${name}, the host, left. You can keep working. Nobody can invite or remove people until they come back.` : `${name} left`);
      }
      syncPeople(r);
      if (r.sync && r.sync.source === 0) askForSync(r);
      break;
    }
    case 'room-state': {
      const away = msg.state === 'host-away';
      const back = !away && get().room?.hostAway;
      patchRoom({ hostAway: away, ...(isGuestView() ? { veil: away ? waitingText(r) : null } : {}) });
      // Whatever a guest sent while the host was away never arrived: start from the host's state again.
      if (back && isGuestView()) guestEnter(r, false);
      break;
    }
    case 'replay-end':
      if (msg.rid === r.catching && r.base) finishCatchUp(r, r.base, r.synced!);
      break;
    case 'error':
      if (msg.code === 'replay-too-old' || msg.code === 'replay-ahead') {
        if (isGuestView()) {
          guestEnter(r, false);
          break;
        }
        // The relay no longer has what was missed. Get the mask from someone who has it.
        if (r.base) {
          r.synced = r.base;
          r.base = null;
        }
        if (r.ready) {
          for (const op of r.log.unconfirmed()) noteOfflineSeg(r, op);
          r.log.reset(r.log.head);
          r.quietMerge = true;
        }
        startSync(r, msg.code === 'replay-ahead' ? 'two' : 'three');
      } else if (msg.code === 'busy' && typeof msg.to === 'number') {
        // The receiver's connection is not keeping up with a transfer from here. Stop; they will ask again.
        const serving = r.serving.get(msg.to);
        if (serving) serving.cancelled = true;
      } else if (msg.code === 'rate-limited' && (msg.kind === FrameKind.Patch || msg.kind === FrameKind.SegOp)) {
        // An edit of mine was dropped. A quiet catch-up sends again whatever the room is missing.
        setTimeout(() => r === room && r.ready && !isGuestView() && quietCatchUp(r), 1000);
      }
      break;
  }
}

function quietCatchUp(r: RoomCtx): void {
  for (const op of r.log.unconfirmed()) noteOfflineSeg(r, op);
  r.log.reset(r.log.head);
  r.ready = false;
  r.quietMerge = true;
  catchUpByReplay(r);
}

/* ── people ── */

function sayHi(r: RoomCtx): void {
  const names = r.kind === 'host-view' && r.role === 'host' ? { names: [...r.names] } : {};
  // The host says which kind of room it made: the others only have the room server's word for it.
  const kind = r.role === 'host' ? { kind: r.kind } : {};
  r.client.sendFrame(FrameKind.Presence, { t: 'hi', name: r.name, ...names, ...kind });
}

function syncPeople(r: RoomCtx): void {
  const all = new Map(r.names);
  all.set(r.selfId, r.name);
  const shown = displayNames(r.roster.map((m) => m.id), all, hostOf(r)?.id);
  const old = new Map(get().peers.map((p) => [p.id, p]));
  const peers: Peer[] = r.roster
    .filter((m) => m.id !== r.selfId && m.online)
    .map((m) => ({ id: m.id, name: shown.get(m.id) ?? 'Someone', color: userColor(m.id), role: m.role, cursor: old.get(m.id)?.cursor, seen: r.seen.get(m.id)?.size }));
  set({ peers });
  patchRoom({ hostName: hostName(r) });
}

function learnName(r: RoomCtx, id: number, value: unknown): boolean {
  const name = cleanPeerName(value);
  if (!name || id === r.selfId || r.names.get(id) === name) return false;
  r.names.set(id, name);
  return true;
}

function onPresence(r: RoomCtx, from: number, meta: Meta): void {
  if (meta.t === 'cursor') {
    const cursor =
      (engine.ORTHO_IDS as readonly unknown[]).includes(meta.vp) && isNumbers(meta.w, 3)
        ? { vp: meta.vp as ViewId, w: meta.w as [number, number, number], r: typeof meta.r === 'number' && meta.r > 0 && meta.r <= 500 ? meta.r : undefined }
        : undefined;
    set((s) => ({ peers: s.peers.map((p) => (p.id === from ? { ...p, cursor } : p)) }));
    return;
  }
  if (meta.t !== 'hi') return;
  const fromHost = from === hostOf(r)?.id;
  if (fromHost && r.role !== 'host' && (meta.kind === 'shared' || meta.kind === 'host-view') && meta.kind !== r.kind) {
    // The host made another kind of room than the room server said. Nothing it said can be relied on.
    forgetRoom(r.id);
    r.client.leaveAsMisfit();
    return;
  }
  let changed = learnName(r, from, meta.name);
  // In a view-through-host room guests only hear the host, who passes the other names on.
  if (Array.isArray(meta.names) && fromHost) {
    for (const pair of meta.names.slice(0, 64)) if (Array.isArray(pair)) changed = learnName(r, Number(pair[0]), pair[1]) || changed;
  }
  if (!changed) return;
  syncPeople(r);
  rememberThis(r);
  if (r.kind === 'host-view' && r.role === 'host') sayHi(r);
  const online = r.roster.some((m) => m.id === from && m.online);
  if (online && !r.greeted.has(from)) {
    r.greeted.add(from);
    if (performance.now() > r.quietUntil) toast('info', `${get().peers.find((p) => p.id === from)?.name ?? 'Someone'} joined`);
  }
}

/**
 * Changes the name others see. It is saved as the name for future rooms and,
 * in a room, sent to everyone straight away.
 */
export function setDisplayName(name: string): void {
  const clean = cleanName(name);
  setSetting('displayName', clean);
  const r = room;
  if (!r || !clean || clean === r.name) return;
  r.name = clean;
  patchRoom({ name: clean });
  syncPeople(r);
  sayHi(r);
}

let lastCursor = 0;
export function shareCursor(vp: ViewId | null, w?: [number, number, number]): void {
  if (!room?.ready || get().peers.length === 0) return;
  const now = performance.now();
  if (vp && now - lastCursor < 60) return;
  lastCursor = now;
  const s = get();
  const painting = s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'threshold';
  room.client.sendFrame(FrameKind.Presence, { t: 'cursor', vp, w, r: painting ? currentBrushRadius() : undefined }, undefined, { droppable: true });
}

/* ── edits in order ── */

/** Tells the room about an edit already made here. Offline it stays local and is merged later. */
function roomSend(op: RoomOp): void {
  const r = room;
  if (!r) return;
  if (op.k === 'patch') for (const part of splitPatch(op.patch, PATCH_BYTES)) sendOp(r, { k: 'patch', patch: part });
  else sendOp(r, op);
}

function sendOp(r: RoomCtx, op: RoomOp, extra: Meta = {}): void {
  if (op.k === 'none' || r.role === 'viewer') return;
  if (!r.ready || !r.client.open) {
    noteOfflineSeg(r, op);
    return;
  }
  const cid = r.log.local(op);
  // `s` and `c` tell everyone this edit from a repeat of it (see `ReplayGuard`).
  op.sig = [r.selfId, r.tag, cid];
  if (op.k === 'patch') r.client.sendFrame(FrameKind.Patch, { c: cid, s: r.tag, ...extra }, encodePatch(op.patch), { seq: cid });
  else r.client.sendFrame(FrameKind.SegOp, { c: cid, s: r.tag, ...extra, ...op.op }, undefined, { seq: cid });
}

function decodeOp(kind: number, meta: Meta | null, body: Uint8Array, from: number): RoomOp {
  const sig: RoomOp['sig'] = meta && typeof meta.s === 'string' && typeof meta.c === 'number' ? [from, meta.s, meta.c] : undefined;
  try {
    if (meta && kind === FrameKind.Patch) return { k: 'patch', patch: decodePatch(body), sig };
    const op = meta && kind === FrameKind.SegOp ? parseSegOp(meta) : null;
    if (op) return { k: 'seg', op, sig };
  } catch {
    /* not a patch */
  }
  return { k: 'none' };
}

function confirmOp(r: RoomCtx, op: RoomOp, shown: boolean): void {
  // The room server sending an old edit again as a new one: left out, by everyone alike.
  if (op.sig && !r.guard.fresh(...op.sig)) return;
  if (op.k === 'patch') {
    // Checked whole before any of it is written: a run outside the mask must not leave the others half applied.
    if (!patchFits(op.patch, r.synced?.length ?? mask?.data.length ?? 0)) return;
    if (r.synced) applyPatch(r.synced, op.patch, 'after');
    if (r.catching === null && !shown) applyRemotePatch(op.patch);
  } else if (op.k === 'seg' && !shown) applyRemoteSeg(r, op.op, true);
}

function reapplyOp(r: RoomCtx, op: RoomOp): void {
  if (r.catching !== null) return;
  if (op.k === 'patch') {
    try {
      writePatch(op.patch, 'after');
    } catch {
      /* does not fit */
    }
  } else if (op.k === 'seg') applyRemoteSeg(r, op.op, false);
}

function applyRemotePatch(patch: Patch): void {
  if (!mask) return;
  try {
    writePatch(patch, 'after');
    if (!get().dirty && !isGuestView()) set({ dirty: true });
    emit('edit');
  } catch {
    /* a patch for a different mask; ignore it */
  }
}

function applyRemoteSeg(r: RoomCtx, op: SegOp, announce: boolean): void {
  if (op.op === 'window') {
    // The pictures a guest holds were made with the host's old window.
    if (isGuestView()) {
      if (op.voi) patchRoom({ hostVoi: { lower: op.voi[0], upper: op.voi[1] } });
      r.have.clear();
      r.asked.clear();
      wantSlices(r);
    }
    return;
  }
  const s = get();
  const next = applySegOp(s.segments, op);
  const active = next.some((x) => x.index === s.activeSegment) ? s.activeSegment : (next[0]?.index ?? 0);
  if (announce && active !== s.activeSegment) {
    const gone = s.segments.find((x) => x.index === s.activeSegment);
    if (gone) toast('warning', `${gone.name} was deleted in the room. You are now on ${next.find((x) => x.index === active)?.name ?? 'no segment'}.`);
  }
  set({ segments: next, activeSegment: active });
  pushSegments();
  if (next.length === 0 && EDIT_TOOLS.includes(s.tool)) setTool('crosshair');
}

function onRoomFrame(r: RoomCtx, h: FrameHeader, meta: Meta | null, body: Uint8Array): void {
  if (h.kind === FrameKind.Patch || h.kind === FrameKind.SegOp) {
    if (r.kind === 'host-view' && r.role === 'host') {
      hostTakesGuestEdit(r, h, meta, body);
      return;
    }
    const op = decodeOp(h.kind, meta, body, h.from);
    r.topSeq = Math.max(r.topSeq, h.seq);
    // My own edit coming back: from the host of a view-through-host room, or in a replay.
    const origin = meta && Array.isArray(meta.o) ? meta.o : null;
    const settles = origin ? (origin[0] === r.selfId ? Number(origin[1]) : undefined) : meta && h.from === r.selfId ? Number(meta.c) : undefined;
    if (!r.ready && r.catching === null) {
      r.queued.push({ seq: h.seq, op, settles });
      r.queuedBytes += op.k === 'patch' ? 64 + op.patch.after.length + op.patch.starts.length * 8 : 256;
      if (r.queued.length > QUEUE_LIMIT_FRAMES || r.queuedBytes > QUEUE_LIMIT_BYTES) {
        // More edits than can be held while the mask is on its way: start again from a newer mask.
        r.queued = [];
        r.queuedBytes = 0;
        if (r.sync) startSync(r, r.sync.merge);
        else if (isGuestView()) guestEnter(r, false);
      }
    } else r.log.remote(h.seq, op, settles);
    return;
  }
  if (!meta) return;
  if (h.kind === FrameKind.Presence) onPresence(r, h.from, meta);
  else if (h.kind === FrameKind.SyncRequest) void serveSync(r, h.from, meta).catch((err) => console.error(err));
  else if (h.kind === FrameKind.SyncSlab || h.kind === FrameKind.ImageSlab) onSyncFrame(r, h, meta, body);
  else if (h.kind === FrameKind.SliceRequest) serveSlice(r, h.from, meta);
  else if (h.kind === FrameKind.Slice) onSlice(r, h.from, meta, body);
}

function drainQueue(r: RoomCtx): void {
  const queue = r.queued;
  r.queued = [];
  r.queuedBytes = 0;
  for (const f of queue) r.log.remote(f.seq, f.op, f.settles);
}

/* ── coming back: replay, then merge ── */

function catchUpByReplay(r: RoomCtx): void {
  r.base = r.synced!.slice();
  r.baseHead = r.log.head;
  r.catching = nextRid++;
  r.client.send({ t: 'replay', after: r.log.head, rid: r.catching });
}

/**
 * My mask meets the room's again (`ROOMS.md` C6). `base` is what the room had when I left,
 * or null when there is no shared starting point; `theirs` is the room now.
 */
function finishCatchUp(r: RoomCtx, base: Uint8Array | null, theirs: Uint8Array, segments?: SegmentInfo[]): void {
  if (!mask || !shadow) return;
  flushEdits();
  const data = mask.data as Uint8Array;
  const result = mergeMasks(base, data, theirs, sliceSize());
  if (result.changedSlices.length) {
    shadow.set(data);
    engine.refreshMask(result.changedSlices);
  }
  if (segments) {
    const mine = new Map(get().segments.map((x) => [x.index, x]));
    const list = segments.map((x) => ({ ...x, visible: mine.get(x.index)?.visible ?? true }));
    // What I changed while away is sent again below; until then my version of those stays on screen.
    for (const index of r.offlineSegs) {
      const own = mine.get(index);
      const at = list.findIndex((x) => x.index === index);
      if (own && at >= 0) list[at] = own;
      else if (own) list.push(own);
      else if (at >= 0) list.splice(at, 1);
    }
    list.sort((a, b) => a.index - b.index);
    const s = get();
    set({ segments: list, activeSegment: list.some((x) => x.index === s.activeSegment) ? s.activeSegment : (list[0]?.index ?? 0) });
    pushSegments();
  }
  ensureSegments(data);
  r.synced = theirs;
  r.base = null;
  r.catching = null;
  r.ready = true;
  drainQueue(r);
  // Whatever I have that the room does not goes out as one edit, like any other.
  const mineOnly = diffMask(r.synced, data, sliceSize());
  if (mineOnly) roomSend({ k: 'patch', patch: mineOnly });
  for (const index of r.offlineSegs) {
    const seg = get().segments.find((x) => x.index === index);
    sendOp(r, { k: 'seg', op: seg ? { op: 'set', seg: sharedSegment(seg) } : { op: 'del', index } });
  }
  r.offlineSegs.clear();
  conflicts = result.conflicts;
  patchRoom({ review: result.conflicts ? { slices: result.conflictSlices, voxels: result.conflicts.index.length } : null, note: null });
  if (!base && result.conflicts) {
    const n = result.conflictSlices;
    toast('info', `Your mask differs from the room's on ${n} ${n === 1 ? 'slice' : 'slices'}. The room's version is shown.`);
  } else if (!r.quietMerge || result.conflicts) toast('info', mergeSummary(result));
  r.quietMerge = false;
  if (result.taken > 0 || result.conflicts) {
    set({ dirty: true });
    emit('edit');
  }
  scheduleStats();
}

/** "Use mine": the voxels the merge put aside become an ordinary edit that everyone sees and that can be undone. */
export function takeMine(): void {
  const mine = conflicts;
  if (!mine || !mask) return;
  conflicts = null;
  patchRoom({ review: null });
  editMask((d) => applyPatch(d, conflictPatch(mine, d), 'after'));
}

/** Leaves the room's version where the two differed. */
export function keepRooms(): void {
  conflicts = null;
  patchRoom({ review: null });
}

/* ── getting the mask (and the image) from another member ── */

function startSync(r: RoomCtx, merge: SyncJob['merge']): void {
  r.ready = false;
  r.catching = null;
  if (r.sync) {
    if (r.sync.timer) clearTimeout(r.sync.timer);
    stashPartial(r, r.sync);
  }
  r.sync = {
    rid: 0,
    source: 0,
    tried: new Set(),
    merge,
    begin: null,
    imageMeta: null,
    imageData: null,
    dtype: null,
    theirs: null,
    parts: new PartAssembler(),
    got: new Set(),
    want: 0,
    received: 0,
    flow: false,
    work: Promise.resolve(),
    timer: null,
  };
  if (merge === 'new') set({ busy: image ? 'Getting the mask from the room…' : 'Getting the image from the room…', progress: r.partial ? null : 0 });
  askForSync(r);
}

/** Keeps the image slabs a transfer has brought so far. The image never changes, so they stay good. */
function stashPartial(r: RoomCtx, job: SyncJob): void {
  if (!job.imageData || !job.imageMeta || !job.dtype) return;
  const got = new Set<number>();
  for (const key of job.got) if (key.startsWith('i')) got.add(Number(key.slice(1)));
  if (got.size > 0) r.partial = { meta: job.imageMeta, dtype: job.dtype, data: job.imageData, got };
}

function askForSync(r: RoomCtx): void {
  const job = r.sync;
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  stashPartial(r, job);
  const others = r.roster.filter((m) => m.id !== r.selfId && m.online);
  // The host first; then whoever else is there.
  others.sort((a, b) => Number(b.role === 'host') - Number(a.role === 'host') || a.id - b.id);
  if (others.length > 0 && others.every((m) => job.tried.has(m.id))) job.tried.clear();
  const source = others.find((m) => !job.tried.has(m.id));
  if (!source) {
    if (job.merge === 'new') {
      teardown(r, { keep: true });
      set({ busy: null, progress: null });
      toast('error', 'Nobody is in the room right now. Join again when someone is there.');
      return;
    }
    job.source = 0;
    patchRoom({ note: 'Waiting for someone in the room to merge with.' });
    return;
  }
  // A number nobody can guess: an answer recorded from an earlier transfer cannot be passed off as this one's.
  Object.assign(job, { rid: randomId(), source: source.id, begin: null, imageMeta: null, imageData: null, dtype: null, theirs: null, parts: new PartAssembler(), got: new Set(), want: 0, received: 0, flow: false });
  job.tried.add(source.id);
  patchRoom({ note: null });
  r.client.sendFrame(
    FrameKind.SyncRequest,
    // `flow`: this device reports what has arrived, so the sender can wait for a slow connection.
    // `skip`: image slabs an earlier, interrupted transfer already brought.
    { rid: job.rid, image: !image, fp: image ? fingerprint(image) : null, flow: 1, ...(!image && r.partial ? { skip: [...r.partial.got] } : {}) },
    undefined,
    { to: source.id },
  );
  // Someone who does not answer is skipped.
  job.timer = setTimeout(() => r.sync === job && askForSync(r), 5000);
}

/** Sends the room's mask, and the image when asked, to a member who is joining or coming back. */
async function serveSync(r: RoomCtx, to: number, meta: Meta): Promise<void> {
  const rid = meta.rid;
  if (meta.t === 'ack') {
    // The receiver says how much has arrived.
    const s = r.serving.get(to);
    if (s && s.rid === rid && typeof meta.n === 'number' && meta.n > s.acked) {
      s.acked = Math.min(meta.n, s.sent);
      s.ackedAt = performance.now();
    }
    return;
  }
  const reply = (kind: FrameKind, m: Meta, body?: Uint8Array) => r.client.sendFrame(kind, { rid, ...m }, body, { to });
  if (r.kind !== 'shared' || !image || !mask || !r.ready || !r.synced) return void reply(FrameKind.SyncSlab, { t: 'no' });
  if (typeof meta.fp === 'string' && meta.fp !== fingerprint(image)) return void reply(FrameKind.SyncSlab, { t: 'different' });
  // One transfer for each person, and few at a time: asking again replaces the earlier request instead of adding to it.
  const earlier = r.serving.get(to);
  if (earlier) earlier.cancelled = true;
  r.serving.delete(to);
  if (r.serving.size >= MAX_TRANSFERS) return void reply(FrameKind.SyncSlab, { t: 'no' });
  const me: Serving = { rid, sent: 0, acked: 0, ackedAt: performance.now(), cancelled: false };
  r.serving.set(to, me);
  try {
    await sendSync(r, me, meta, reply);
  } finally {
    if (r.serving.get(to) === me) r.serving.delete(to);
  }
}

async function sendSync(r: RoomCtx, me: Serving, meta: Meta, reply: (kind: FrameKind, m: Meta, body?: Uint8Array) => boolean): Promise<void> {
  if (!image || !r.synced) return;
  flushEdits();
  const vol = image;
  const depth = vol.dims[2];
  const withImage = meta.image === true;
  const flow = meta.flow === 1;
  const skip = new Set<unknown>(withImage && Array.isArray(meta.skip) ? meta.skip.slice(0, 4096) : []);
  const ranges = slabRanges(depth);
  reply(FrameKind.SyncSlab, {
    t: 'begin',
    head: r.log.head,
    segments: get().segments.map(sharedSegment),
    dims: vol.dims,
    slabs: ranges.length * (withImage ? 2 : 1) - skip.size,
    // No name, path or tags: the grid and the voxels are all a copy needs.
    image: withImage ? { dims: vol.dims, spacing: vol.spacing, origin: vol.origin, direction: Array.from(vol.direction), dtype: vol.data.constructor.name } : null,
    ...(flow ? { flow: 1 } : {}),
    // Which edits the mask already holds, so the receiver can tell a repeat from a new one.
    seen: r.guard.dump(),
  });
  const gone = () => me.cancelled || room !== r || !r.client.open;
  const send = async (kind: FrameKind, source: Uint8Array, m: Meta): Promise<boolean> => {
    const parts = splitParts(await gz(source));
    for (let i = 0; i < parts.length; i++) {
      let blocked = 0;
      for (;;) {
        if (gone()) return false;
        const now = performance.now();
        // The connection's own pace keeps under the relay's limits; here only wait for what is still queued,
        // and for the receiver, so a slow connection on their side is not flooded.
        const waitingForReceiver = flow && me.sent - me.acked > TRANSFER_WINDOW;
        if (!waitingForReceiver && r.client.backlog <= 2 << 20) break;
        if (waitingForReceiver) {
          blocked ||= now;
          if (now - Math.max(blocked, me.ackedAt) > TRANSFER_STALL_MS) return false;
        }
        await sleep(15);
      }
      me.sent += parts[i].length;
      reply(kind, { ...m, part: i, parts: parts.length }, parts[i]);
    }
    return true;
  };
  const sliceBytes = (vol.data.byteLength / depth) | 0;
  const sliceVoxels = vol.dims[0] * vol.dims[1];
  if (withImage) {
    const all = bytesOf(vol.data);
    for (const [z0, z1] of ranges) {
      if (skip.has(z0)) continue;
      if (!(await send(FrameKind.ImageSlab, all.subarray(z0 * sliceBytes, z1 * sliceBytes), { z0 }))) return;
    }
  }
  // Read slab by slab from the confirmed mask. An edit that lands meanwhile also reaches the
  // receiver as an ordered edit after `head`, and applying it twice gives the same voxels.
  for (const [z0, z1] of ranges) {
    if (!r.synced || !(await send(FrameKind.SyncSlab, r.synced.slice(z0 * sliceVoxels, z1 * sliceVoxels), { t: 'slab', z0 }))) return;
  }
  if (!gone()) reply(FrameKind.SyncSlab, { t: 'end' });
}

function onSyncFrame(r: RoomCtx, h: FrameHeader, meta: Meta, body: Uint8Array): void {
  const job = r.sync;
  if (!job || meta.rid !== job.rid || h.from !== job.source) return;
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => r.sync === job && askForSync(r), 5000);
  const rid = job.rid;
  // One after another: unpacking a slab takes a moment, and `end` must come last.
  job.work = job.work
    .then(() => (r.sync === job && job.rid === rid && room === r ? handleSync(r, job, h.kind, meta, body) : undefined))
    .catch((err) => {
      if (r.sync !== job) return;
      teardown(r, { keep: true });
      set({ busy: null, progress: null });
      unexpected(err, 'the room data');
    });
}

const isDims = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n > 0 && n < 65536);
const isNumbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

async function handleSync(r: RoomCtx, job: SyncJob, kind: number, meta: Meta, body: Uint8Array): Promise<void> {
  const refuse = (text: string) => {
    teardown(r, { keep: true });
    set({ busy: null, progress: null });
    toast('error', text);
  };
  // What this member sent cannot be right: ask the next one instead of taking it.
  const elsewhere = () => askForSync(r);
  if (kind === FrameKind.ImageSlab || meta.t === 'slab') {
    const forImage = kind === FrameKind.ImageSlab;
    const target = forImage ? job.imageData && bytesOf(job.imageData) : job.theirs;
    const z0 = Number(meta.z0);
    if (!job.begin || !target) return;
    const depth = job.begin.dims[2];
    if (!Number.isInteger(z0) || z0 < 0 || z0 >= depth || z0 % SLAB_SLICES !== 0) return elsewhere();
    const sliceBytes = target.length / depth;
    const raw = Math.min(SLAB_SLICES, depth - z0) * sliceBytes;
    const key = `${forImage ? 'i' : 'm'}${z0}`;
    job.received += body.length;
    // Tell the sender what has arrived, so it sends no faster than this connection takes.
    if (job.flow) r.client.sendFrame(FrameKind.SyncRequest, { rid: job.rid, t: 'ack', n: job.received }, undefined, { to: job.source });
    // A packed slab cannot be much larger than the slab; anything more is not one.
    const whole = job.parts.push(key, Number(meta.part), Number(meta.parts), body, maxPacked(raw));
    if (!whole) return;
    const slab = gunzipExactly(whole, raw);
    if (!slab) return elsewhere();
    target.set(slab, z0 * sliceBytes);
    job.got.add(key);
    if (job.merge === 'new') set({ progress: Math.min(1, job.got.size / job.want) });
    // Unpacking is done here, a slab at a time; let the screen draw in between.
    await sleep(0);
    return;
  }
  if (meta.t === 'no') {
    // Not ready to share yet. Try the next person, but not in a tight loop.
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => r.sync === job && askForSync(r), 1000);
    return;
  }
  if (meta.t === 'different') return refuse('This room uses a different image. Close yours to join.');
  if (meta.t === 'begin') {
    // One `begin` for each request: a second would set aside what has arrived.
    if (job.begin) return;
    if (!isDims(meta.dims)) return elsewhere();
    const dims = meta.dims;
    const voxels = dims[0] * dims[1] * dims[2];
    if (image && !dims.every((n, i) => n === image!.dims[i])) return refuse('This room uses a different image. Close yours to join.');
    // The mask on its way cannot be newer than the newest edit the relay has shown this device.
    const head = Number(meta.head) || 0;
    if (!Number.isSafeInteger(head) || head < 0 || head > r.topSeq) return elsewhere();
    const slabCount = slabRanges(dims[2]).length;
    const im = meta.image as Record<string, unknown> | null;
    if (!image) {
      const Ctor = im && typeof im.dtype === 'string' ? DTYPES[im.dtype] : undefined;
      if (!im || !Ctor || !isNumbers(im.spacing, 3) || !isNumbers(im.origin, 3) || !isNumbers(im.direction, 9)) return elsewhere();
      if (voxels * Ctor.prototype.BYTES_PER_ELEMENT > ROOM_IMAGE_LIMIT) return refuse('This image is too large to share in a room (limit 2 GB).');
      job.imageMeta = { dims, spacing: im.spacing as [number, number, number], origin: im.origin as [number, number, number], direction: im.direction };
      job.dtype = im.dtype as string;
      // What an interrupted transfer of the same image already brought is kept.
      const partial = r.partial && r.partial.dtype === job.dtype && JSON.stringify(r.partial.meta) === JSON.stringify(job.imageMeta) ? r.partial : null;
      job.imageData = partial?.data ?? new Ctor(voxels);
      for (const z0 of partial?.got ?? []) job.got.add(`i${z0}`);
    } else if (voxels > ROOM_IMAGE_LIMIT) return elsewhere();
    r.partial = null;
    job.theirs = new Uint8Array(voxels);
    job.want = slabCount * (image ? 1 : 2);
    job.flow = meta.flow === 1;
    const segments = (Array.isArray(meta.segments) ? meta.segments : [])
      .slice(0, 255)
      .map((seg) => parseSegOp({ op: 'set', seg }))
      .flatMap((op) => (op?.op === 'set' ? [{ ...op.seg, visible: true }] : []));
    job.begin = { head, segments, dims, seen: meta.seen };
    if (job.merge === 'new') set({ progress: Math.min(1, job.got.size / job.want) });
    return;
  }
  if (meta.t !== 'end' || !job.begin || !job.theirs) return;
  // Every slab must be here. A transfer with holes in it would open as an image with blank slices.
  if (job.got.size < job.want) return elsewhere();
  if (job.timer) clearTimeout(job.timer);
  r.sync = null;
  const begin = job.begin;
  if (job.imageData && job.imageMeta) {
    // Named neutrally: file names can carry patient identifiers and are never sent.
    await loadImage({ name: 'Room image', ...job.imageMeta, data: job.imageData });
  }
  if (!image || !mask || !shadow || mask.data.length !== job.theirs.length) throw new Error('No image for the room mask');
  r.log.reset(begin.head);
  r.guard.load(begin.seen);
  if (job.merge !== 'new') {
    finishCatchUp(r, job.merge === 'three' ? r.synced : null, job.theirs, begin.segments);
    return;
  }
  const data = mask.data as Uint8Array;
  data.set(job.theirs);
  shadow.set(data);
  engine.refreshMask();
  history.clear();
  syncHistoryFlags();
  // A neutral name: the host's file name never leaves their computer.
  set({ segments: begin.segments, activeSegment: begin.segments[0]?.index ?? 0, maskName: 'Room mask', dirty: false, busy: null, progress: null });
  pushSegments();
  ensureSegments(data);
  scheduleStats();
  r.synced = job.theirs;
  r.ready = true;
  drainQueue(r);
  emit('opened');
}

/* ── view through the host's computer ── */

const sliceKey = (axis: number, index: number) => `${axis}:${index}`;
const AXES: Axis[] = [0, 1, 2];

/** Host: answers a guest with the room's shape, or with one plane windowed down to 8 bits and its labels. */
function serveSlice(r: RoomCtx, to: number, meta: Meta): void {
  if (r.kind !== 'host-view' || r.role !== 'host' || !image || !mask || !r.ready) return;
  // The guest's own number comes back with the answer, so an old answer cannot stand in for a new one.
  const q = typeof meta.q === 'number' ? { q: meta.q } : {};
  if (meta.t === 'describe') {
    flushEdits();
    r.client.sendFrame(
      FrameKind.Slice,
      { t: 'room', dims: image.dims, spacing: image.spacing, origin: image.origin, direction: Array.from(image.direction), segments: get().segments.map(sharedSegment), head: r.log.head, seen: r.guard.dump(), ...hostWindow(), ...q },
      undefined,
      { to },
    );
    return;
  }
  const axis = meta.axis as Axis;
  const index = Number(meta.index);
  if (!AXES.includes(axis) || !Number.isInteger(index) || index < 0 || index >= image.dims[axis]) return;
  // 30 at once and 600 a minute for each guest, as the relay counts them too.
  let bucket = r.buckets.get(to);
  if (!bucket) r.buckets.set(to, (bucket = new TokenBucket(30, 10, performance.now())));
  if (!bucket.take(1, performance.now())) return;
  flushEdits();
  const voi = get().voi ?? { lower: 0, upper: 1 };
  const picture = windowTo8(readPlane(image.data, image.dims, axis, index), voi.lower, voi.upper);
  const labels = readPlane(mask.data as Uint8Array, image.dims, axis, index);
  if (!r.client.sendFrame(FrameKind.Slice, { t: 'slice', axis, index, ...q }, encodeSlice(picture, labels), { to })) return;
  let seen = r.seen.get(to);
  if (!seen) r.seen.set(to, (seen = new Set()));
  if (!seen.has(sliceKey(axis, index))) {
    seen.add(sliceKey(axis, index));
    syncPeople(r);
  }
}

/** The host's window as guests are told it: how the host looks at the image, never anything from the image. */
function hostWindow(): { voi?: [number, number] } {
  const voi = get().voi;
  return voi ? { voi: [voi.lower, voi.upper] } : {};
}

/** Host: a guest's edit arrives for the host alone; the host applies it and passes it on as its own, in order. */
function hostTakesGuestEdit(r: RoomCtx, h: FrameHeader, meta: Meta | null, body: Uint8Array): void {
  if (!r.ready || !mask) return;
  const op = decodeOp(h.kind, meta, body, h.from);
  if (op.k === 'none' || (op.k === 'seg' && op.op.op === 'window')) return;
  // The same edit sent again by the room server, or one that reaches outside the mask.
  if (op.sig && !r.guard.fresh(...op.sig)) return;
  if (op.k === 'patch' && !patchFits(op.patch, mask.data.length)) return;
  if (op.k === 'patch') applyRemotePatch(op.patch);
  else {
    applyRemoteSeg(r, op.op, true);
    emit('edit');
  }
  sendOp(r, op, { o: [h.from, h.seq] });
}

/** Guest: ask the host what the room looks like. Until the answer comes there is nothing to show. */
function guestEnter(r: RoomCtx, away: boolean): void {
  r.ready = false;
  r.have.clear();
  r.asked.clear();
  r.queued = [];
  r.queuedBytes = 0;
  patchRoom({ veil: away ? waitingText(r) : null });
  if (!image) set({ busy: 'Joining the room…' });
  r.describeQ = randomId();
  const ask = () => r.client.sendFrame(FrameKind.SliceRequest, { t: 'describe', q: r.describeQ });
  ask();
  if (r.pump) clearInterval(r.pump);
  r.pump = setInterval(() => (r.ready ? wantSlices(r) : ask()), 400);
}

function onSlice(r: RoomCtx, from: number, meta: Meta, body: Uint8Array): void {
  if (!isGuestView() || from !== hostOf(r)?.id) return;
  if (meta.t === 'room') {
    if (r.ready || (meta.q !== undefined && meta.q !== r.describeQ)) return;
    r.work = r.work.then(() => (room === r && !r.ready ? guestOpen(r, meta) : undefined)).catch((err) => unexpected(err, 'the room'));
    return;
  }
  const axis = meta.axis as Axis;
  const index = Number(meta.index);
  if (meta.t !== 'slice' || !r.ready || !image || !mask || !shadow || !AXES.includes(axis) || !Number.isInteger(index) || index < 0 || index >= image.dims[axis]) return;
  // An answer to a question this device did not ask, or asked before the window changed: not the plane as it is now.
  if (meta.q !== undefined && r.asked.get(sliceKey(axis, index))?.q !== meta.q) return;
  const got = decodeSlice(body, planeLength(image.dims, axis));
  if (!got) return;
  writePlane(image.data, image.dims, axis, index, got.image);
  writePlane(mask.data, image.dims, axis, index, got.labels);
  writePlane(shadow, image.dims, axis, index, got.labels);
  // My strokes the host has not passed on yet stay on top.
  r.log.reapplyAll();
  ensureSegments(got.labels);
  const slices = planeSlices(image.dims, axis, index);
  engine.refreshImage(slices);
  engine.refreshMask(slices);
  r.have.add(sliceKey(axis, index));
  r.asked.delete(sliceKey(axis, index));
}

async function guestOpen(r: RoomCtx, meta: Meta): Promise<void> {
  if (!isDims(meta.dims) || !isNumbers(meta.spacing, 3) || !isNumbers(meta.origin, 3) || !isNumbers(meta.direction, 9)) return;
  const dims = meta.dims;
  const same = image && image.name === GUEST_IMAGE && dims.every((n, i) => n === image!.dims[i]);
  if (!same) {
    // An empty 8-bit volume on the host's grid. Planes are filled in as the host sends them.
    await loadImage({
      name: GUEST_IMAGE,
      dims,
      spacing: meta.spacing as [number, number, number],
      origin: meta.origin as [number, number, number],
      direction: meta.direction,
      data: new Uint8Array(dims[0] * dims[1] * dims[2]),
    });
    setVoi(0, 255);
    const shown = get().image;
    // What a guest holds are grey levels from 0 to 255 in the host's window. Everything that reads the
    // image's values (presets, the threshold brush, the value under the cursor) is told so.
    const grey = { lower: 0, upper: 255 };
    if (shown) set({ image: { ...shown, range: [0, 255], ct: false, grey: true, auto: grey, mr: { soft: grey, fluid: grey, dark: grey } }, windowSet: null, threshold: [128, 255] });
  }
  if (room !== r || !image) return;
  const segments = (Array.isArray(meta.segments) ? meta.segments : [])
    .slice(0, 255)
    .map((seg) => parseSegOp({ op: 'set', seg }))
    .flatMap((op) => (op?.op === 'set' ? [{ ...op.seg, visible: true }] : []));
  // A neutral name, as in a shared-copy room: the host's file name never leaves their computer.
  set({ segments, activeSegment: segments.some((x) => x.index === get().activeSegment) ? get().activeSegment : (segments[0]?.index ?? 0), maskName: 'Room mask', dirty: false, busy: null });
  pushSegments();
  const hostVoi = parseSegOp({ op: 'window', voi: meta.voi });
  patchRoom({ hostVoi: hostVoi?.op === 'window' && hostVoi.voi ? { lower: hostVoi.voi[0], upper: hostVoi.voi[1] } : null });
  r.log.reset(Number(meta.head) || 0);
  r.guard.load(meta.seen);
  r.ready = true;
  drainQueue(r);
  wantSlices(r);
}

const GUEST_IMAGE = 'Room image';

/** Guest: ask for the planes on screen that are not here yet, as fast as the allowance lets. */
function wantSlices(r: RoomCtx): void {
  if (!r.ready || !image || !r.client.open) return;
  const now = performance.now();
  for (const view of engine.ORTHO_IDS) {
    const plane = engine.viewPlane(view);
    if (!plane) continue;
    const axis = sliceAxisFor(image.direction, view);
    for (const index of withNeighbours(indicesForPlane(image, axis, plane.point, plane.normal), image.dims[axis])) {
      const key = sliceKey(axis, index);
      // Asked and not answered within three seconds: ask again.
      if (r.have.has(key) || now - (r.asked.get(key)?.at ?? -Infinity) < 3000) continue;
      if (!r.askBucket.take(1, now)) return;
      // Asking again keeps the number: a slow answer to the first asking is still the answer.
      const q = r.asked.get(key)?.q ?? randomId();
      r.asked.set(key, { at: now, q });
      r.client.sendFrame(FrameKind.SliceRequest, { axis, index, q });
    }
  }
}

// A guest asks for a plane as soon as a view moves to it; the host tells guests when its window changes.
let windowTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((now, before) => {
  const r = room;
  if (!r) return;
  if (now.slices !== before.slices && isGuestView()) wantSlices(r);
  if (now.voi !== before.voi && r.kind === 'host-view' && r.role === 'host') {
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = setTimeout(() => room === r && sendOp(r, { k: 'seg', op: { op: 'window', ...hostWindow() } }), 250);
  }
});
