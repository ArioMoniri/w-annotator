import {
  RenderingEngine,
  Enums,
  cache,
  eventTarget,
  init as csInit,
  metaData,
  setVolumesForViewports,
  utilities as csUtils,
  volumeLoader,
  type Types,
} from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import type { VolumeData } from '../io/types';
import type { SegmentInfo } from '../collab/protocol';
import type { ToolId, ViewId } from '../state/store';
import { cutsWithOutline, type ScissorsAction, type ScissorsDepth, type ScissorsShape, type ViewFrame } from '../mask/scissors';
import { PREVIEW_DARK, PREVIEW_LIGHT } from '../mask/preview';
import { hexToRgb } from './geometry';
import { zoomAbout } from './gestures';
import { paneGrowth } from './layout';
import { LINE_CENTRE_GAP, LinkedLinesTool } from './linkedLines';

const {
  ToolGroupManager,
  segmentation,
  Enums: ToolEnums,
  BrushTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  TrackballRotateTool,
  RectangleScissorsTool,
  CircleScissorsTool,
  SphereScissorsTool,
  PaintFillTool,
  LengthTool,
} = csTools;

export const ORTHO_IDS = ['axial', 'sagittal', 'coronal'] as const;
export const VOLUME3D_ID = 'volume3d';
const ALL_IDS = [...ORTHO_IDS, VOLUME3D_ID];
const ENGINE_ID = 'w-engine';
const IMAGE_VOLUME_ID = 'w-image';
const MASK_VOLUME_ID = 'w-mask';
const SEGMENTATION_ID = 'mask';
const ORTHO_GROUP = 'ortho';
const VOLUME3D_GROUP = 'vol3d';
const FRAME = 'w-annotator-frame';
const LABELMAP = ToolEnums.SegmentationRepresentations.Labelmap;
const { MouseBindings, KeyboardBindings } = ToolEnums;

export const VIEW_COLORS: Record<string, string> = {
  axial: '#E5B454',
  sagittal: '#6FD3A3',
  coronal: '#7AB0FF',
};

const BRUSH = {
  circle: 'Brush',
  sphere: 'SphereBrush',
  eraseCircle: 'Eraser',
  eraseSphere: 'SphereEraser',
  threshold: 'ThresholdBrush',
  thresholdSphere: 'ThresholdSphereBrush',
} as const;

let ready: Promise<void> | null = null;
let engine: RenderingEngine | null = null;
let imageLoaded = false;
let maskLoaded = false;

/** The canvas size, in CSS pixels, each view was last drawn at. A view that has never been on screen has none. */
const drawnSize = new Map<string, { w: number; h: number }>();
/** The views on screen now. */
const onScreen = new Set<string>();
/** How many times the image of a maximised view was enlarged, so that leaving maximise puts it back. */
const enlarged = new Map<string, number>();

/** When the lines marking the other two planes are drawn. */
export type LinesSetting = 'always' | 'hover' | 'crosshair';
const lines: { setting: LinesSetting; hovering: boolean; tool: ToolId; mode: 'Active' | 'Passive' | 'Enabled' | 'Disabled' } = {
  setting: 'hover',
  hovering: false,
  tool: 'crosshair',
  mode: 'Disabled',
};

/** Geometry of the local volumes, so each slice reports its own position. */
const geometry = new Map<string, VolumeData>();

function planeProvider(type: string, imageId: string) {
  if (type !== 'imagePlaneModule' || typeof imageId !== 'string') return undefined;
  const cut = imageId.lastIndexOf('_slice_');
  if (cut < 0) return undefined;
  const vol = geometry.get(imageId.slice(0, cut));
  if (!vol) return undefined;
  const k = Number(imageId.slice(cut + 7));
  const d = vol.direction;
  return {
    frameOfReferenceUID: FRAME,
    rows: vol.dims[1],
    columns: vol.dims[0],
    imageOrientationPatient: d.slice(0, 6),
    rowCosines: d.slice(0, 3),
    columnCosines: d.slice(3, 6),
    imagePositionPatient: [
      vol.origin[0] + d[6] * vol.spacing[2] * k,
      vol.origin[1] + d[7] * vol.spacing[2] * k,
      vol.origin[2] + d[8] * vol.spacing[2] * k,
    ],
    pixelSpacing: [vol.spacing[1], vol.spacing[0]],
    rowPixelSpacing: vol.spacing[1],
    columnPixelSpacing: vol.spacing[0],
    sliceThickness: vol.spacing[2],
    sliceLocation: k * vol.spacing[2],
  };
}

export function initEngine(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      csInit();
      csTools.init();
      metaData.addProvider(planeProvider, 10000);
      for (const tool of [
        BrushTool,
        PanTool,
        ZoomTool,
        WindowLevelTool,
        LinkedLinesTool,
        TrackballRotateTool,
        RectangleScissorsTool,
        CircleScissorsTool,
        SphereScissorsTool,
        PaintFillTool,
        LengthTool,
      ]) {
        csTools.addTool(tool);
      }
    })();
  }
  return ready;
}

function eng(): RenderingEngine {
  if (!engine) throw new Error('Viewer is not mounted');
  return engine;
}

function orthoViewport(id: string): Types.IVolumeViewport {
  return eng().getViewport(id) as Types.IVolumeViewport;
}

export type ViewportElements = Record<ViewId, HTMLDivElement>;

let mounted: ViewportElements | null = null;

export function mountViewports(els: ViewportElements): void {
  unmountViewports();
  mounted = els;
  drawnSize.clear();
  onScreen.clear();
  enlarged.clear();
  lines.mode = 'Disabled';
  engine = new RenderingEngine(ENGINE_ID);
  const { ViewportType, OrientationAxis } = Enums;
  const background: Types.Point3 = [0, 0, 0];
  engine.setViewports([
    {
      viewportId: 'axial',
      type: ViewportType.ORTHOGRAPHIC,
      element: els.axial,
      defaultOptions: { orientation: OrientationAxis.AXIAL, background },
    },
    {
      viewportId: 'sagittal',
      type: ViewportType.ORTHOGRAPHIC,
      element: els.sagittal,
      defaultOptions: { orientation: OrientationAxis.SAGITTAL, background },
    },
    {
      viewportId: 'coronal',
      type: ViewportType.ORTHOGRAPHIC,
      element: els.coronal,
      defaultOptions: { orientation: OrientationAxis.CORONAL, background },
    },
    {
      viewportId: VOLUME3D_ID,
      type: ViewportType.VOLUME_3D,
      element: els.volume3d,
      defaultOptions: { orientation: OrientationAxis.CORONAL, background },
    },
  ]);
  setupToolGroups();
}

export function unmountViewports(): void {
  if (!engine) return;
  ToolGroupManager.destroyToolGroup(ORTHO_GROUP);
  ToolGroupManager.destroyToolGroup(VOLUME3D_GROUP);
  segmentation.removeAllSegmentations();
  forgetComparisons();
  forgetPreview();
  forgetReview();
  removeVolume(MASK_VOLUME_ID);
  removeVolume(IMAGE_VOLUME_ID);
  engine.destroy();
  engine = null;
  imageLoaded = false;
  maskLoaded = false;
}

function setupToolGroups(): void {
  ToolGroupManager.destroyToolGroup(ORTHO_GROUP);
  ToolGroupManager.destroyToolGroup(VOLUME3D_GROUP);

  const ortho = ToolGroupManager.createToolGroup(ORTHO_GROUP)!;
  ortho.addTool(PanTool.toolName);
  ortho.addTool(ZoomTool.toolName);
  ortho.addTool(WindowLevelTool.toolName);
  ortho.addTool(LengthTool.toolName);
  ortho.addTool(RectangleScissorsTool.toolName);
  ortho.addTool(CircleScissorsTool.toolName);
  ortho.addTool(SphereScissorsTool.toolName);
  ortho.addTool(PaintFillTool.toolName);
  ortho.addTool(LinkedLinesTool.toolName, {
    // A plane that is not on screen has no line: there is nothing to see move when it is dragged.
    getReferenceLineColor: (viewportId: string) => (onScreen.has(viewportId) ? (VIEW_COLORS[viewportId] ?? '#ffffff') : 'transparent'),
    getReferenceLineControllable: (viewportId: string) => onScreen.has(viewportId),
    // Draggable, so a line scrolls its plane and leaves a gap at the centre. LinkedLinesTool removes the rotation.
    getReferenceLineDraggableRotatable: () => true,
    getReferenceLineSlabThicknessControlsOn: () => false,
    referenceLinesCenterGapRadius: LINE_CENTRE_GAP,
    handleRadius: 0,
  });
  const brush = (name: string, activeStrategy: string) =>
    ortho.addToolInstance(name, BrushTool.toolName, { activeStrategy, preview: { enabled: false } });
  brush(BRUSH.circle, 'FILL_INSIDE_CIRCLE');
  brush(BRUSH.sphere, 'FILL_INSIDE_SPHERE');
  brush(BRUSH.eraseCircle, 'ERASE_INSIDE_CIRCLE');
  brush(BRUSH.eraseSphere, 'ERASE_INSIDE_SPHERE');
  brush(BRUSH.threshold, 'THRESHOLD_INSIDE_CIRCLE');
  brush(BRUSH.thresholdSphere, 'THRESHOLD_INSIDE_SPHERE');
  for (const id of ORTHO_IDS) ortho.addViewport(id, ENGINE_ID);

  const vol = ToolGroupManager.createToolGroup(VOLUME3D_GROUP)!;
  vol.addTool(TrackballRotateTool.toolName);
  vol.addTool(ZoomTool.toolName);
  vol.addTool(PanTool.toolName);
  vol.addViewport(VOLUME3D_ID, ENGINE_ID);
  vol.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  // Wheel, trackpad and pinch are handled in src/ui/gestureInput.ts, not by Cornerstone's wheel tools.
  vol.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  vol.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
}

export interface ToolOptions {
  brushShape: 'circle' | 'sphere';
  scissorsShape: ScissorsShape;
  scissorsAction: ScissorsAction;
  scissorsDepth: ScissorsDepth;
  fillAction: 'fill' | 'remove' | 'keep';
}

/** No viewer tool: the press is handled by the app (src/ui/maskPointer.ts). */
const APP_TOOL = '';

function toolNameFor(tool: ToolId, o: ToolOptions): string {
  switch (tool) {
    case 'crosshair':
      return LinkedLinesTool.toolName;
    case 'pan':
      return PanTool.toolName;
    case 'zoom':
      return ZoomTool.toolName;
    case 'window':
      return WindowLevelTool.toolName;
    case 'measure':
      return LengthTool.toolName;
    case 'brush':
      return o.brushShape === 'sphere' ? BRUSH.sphere : BRUSH.circle;
    case 'eraser':
      return o.brushShape === 'sphere' ? BRUSH.eraseSphere : BRUSH.eraseCircle;
    case 'threshold':
      return o.brushShape === 'sphere' ? BRUSH.thresholdSphere : BRUSH.threshold;
    case 'scissors':
      if (cutsWithOutline(o.scissorsShape, o.scissorsAction, o.scissorsDepth)) return APP_TOOL;
      return o.scissorsShape === 'circle'
        ? CircleScissorsTool.toolName
        : o.scissorsShape === 'sphere'
          ? SphereScissorsTool.toolName
          : RectangleScissorsTool.toolName;
    case 'fill':
      return o.fillAction === 'fill' ? PaintFillTool.toolName : APP_TOOL;
  }
}

const PRIMARY_TOOLS = [
  LengthTool.toolName,
  RectangleScissorsTool.toolName,
  CircleScissorsTool.toolName,
  SphereScissorsTool.toolName,
  PaintFillTool.toolName,
  ...Object.values(BRUSH),
];

/**
 * Makes one tool the left-button tool. Pan and window stay on their own buttons.
 * Nothing is bound to the wheel: src/ui/gestureInput.ts handles wheel, trackpad and pinch.
 */
export function setTool(tool: ToolId, o: ToolOptions): void {
  const group = ToolGroupManager.getToolGroup(ORTHO_GROUP);
  if (!group || !imageLoaded) return;
  const name = toolNameFor(tool, o);
  const primary = { mouseButton: MouseBindings.Primary };

  for (const t of PRIMARY_TOOLS) {
    if (t === name) continue;
    // Measurements stay visible after the ruler is put down.
    if (t === LengthTool.toolName) group.setToolPassive(t);
    else group.setToolDisabled(t);
  }
  lines.tool = tool;
  applyLines();

  // Bindings add up across calls, so clear the navigation tools before binding them again.
  for (const t of [PanTool.toolName, ZoomTool.toolName, WindowLevelTool.toolName]) {
    group.setToolPassive(t, { removeAllBindings: true });
  }
  for (const t of [BRUSH.eraseCircle, BRUSH.eraseSphere]) {
    if (t !== name) group.setToolPassive(t, { removeAllBindings: true });
    if (t !== name) group.setToolDisabled(t);
  }
  group.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }, ...(name === PanTool.toolName ? [primary] : [])],
  });
  if (name === ZoomTool.toolName) group.setToolActive(ZoomTool.toolName, { bindings: [primary] });
  group.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }, ...(name === WindowLevelTool.toolName ? [primary] : [])],
  });

  if (PRIMARY_TOOLS.includes(name)) {
    if (tool === 'scissors') {
      group.setToolConfiguration(name, { activeStrategy: o.scissorsAction === 'fill' ? 'FILL_INSIDE' : 'ERASE_INSIDE' });
    }
    group.setToolActive(name, { bindings: [primary] });
  }
  // Holding Shift turns the brush into an eraser of the same size and shape.
  if (tool === 'brush' || tool === 'threshold') {
    group.setToolActive(o.brushShape === 'sphere' ? BRUSH.eraseSphere : BRUSH.eraseCircle, {
      bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Shift }],
    });
  }
  eng().render();
}

/** Tools that only move the view. With one of them a reference line can be dragged; with the others it is display only. */
const NAVIGATION_TOOLS: ToolId[] = ['pan', 'zoom', 'window'];

/**
 * Shows or hides the reference lines. With the crosshair tool they are always on and a click
 * moves them. With a navigation tool they can be dragged. With an edit tool or the ruler they
 * are drawn but never take a press, so a stroke that starts on a line is still a stroke.
 */
function applyLines(): void {
  const group = ToolGroupManager.getToolGroup(ORTHO_GROUP);
  if (!group || !imageLoaded) return;
  const shown = lines.setting === 'always' || (lines.setting === 'hover' && lines.hovering);
  const mode =
    lines.tool === 'crosshair' ? 'Active' : !shown ? 'Disabled' : NAVIGATION_TOOLS.includes(lines.tool) ? 'Passive' : 'Enabled';
  if (mode === lines.mode) return;
  lines.mode = mode;
  const name = LinkedLinesTool.toolName;
  if (mode === 'Active') group.setToolActive(name, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  else if (mode === 'Passive') group.setToolPassive(name, { removeAllBindings: true });
  else if (mode === 'Enabled') {
    group.setToolPassive(name, { removeAllBindings: true });
    group.setToolEnabled(name);
  } else group.setToolDisabled(name);
  csTools.utilities.triggerAnnotationRenderForViewportIds([...ORTHO_IDS]);
}

export function setReferenceLines(setting: LinesSetting): void {
  lines.setting = setting;
  applyLines();
}

/** Whether the pointer is over the views; reference lines set to "on hover" follow it. */
export function setLinesHover(hovering: boolean): void {
  lines.hovering = hovering;
  applyLines();
}

export function setBrushSize(mm: number): void {
  if (!ToolGroupManager.getToolGroup(ORTHO_GROUP)) return;
  for (const name of Object.values(BRUSH)) {
    csTools.utilities.segmentation.setBrushSizeForToolGroup(ORTHO_GROUP, mm, name);
  }
}

/**
 * Takes the brush ring off the views. Cornerstone draws the ring where the pointer last moved
 * over a view and is not told when the pointer leaves, so without this the ring stays behind.
 * The next move over a view draws it again.
 */
export function hideBrushRing(): void {
  const group = ToolGroupManager.getToolGroup(ORTHO_GROUP);
  if (!group) return;
  let hidden = false;
  for (const name of Object.values(BRUSH)) {
    // The tool keeps the ring it draws in this field, and draws nothing without it.
    const tool = group.getToolInstance(name) as unknown as { _hoverData?: unknown } | undefined;
    if (!tool?._hoverData) continue;
    tool._hoverData = undefined;
    hidden = true;
  }
  if (hidden) csTools.utilities.triggerAnnotationRenderForViewportIds([...ORTHO_IDS]);
}

export function setThreshold(range: [number, number]): void {
  const group = ToolGroupManager.getToolGroup(ORTHO_GROUP);
  if (!group) return;
  for (const name of [BRUSH.threshold, BRUSH.thresholdSphere]) {
    group.setToolConfiguration(name, { threshold: { range, isDynamic: false } });
  }
}

function metadataFor(vol: VolumeData) {
  const bits = vol.data.BYTES_PER_ELEMENT * 8;
  const signed = vol.data instanceof Int8Array || vol.data instanceof Int16Array || vol.data instanceof Float32Array;
  return {
    BitsAllocated: bits,
    BitsStored: bits,
    SamplesPerPixel: 1,
    HighBit: bits - 1,
    PhotometricInterpretation: 'MONOCHROME2',
    PixelRepresentation: signed ? 1 : 0,
    Modality: 'OT',
    ImageOrientationPatient: vol.direction.slice(0, 6),
    PixelSpacing: [vol.spacing[1], vol.spacing[0]],
    FrameOfReferenceUID: FRAME,
    Columns: vol.dims[0],
    Rows: vol.dims[1],
    voiLut: [],
    VOILUTFunction: 'LINEAR',
  };
}

function removeVolume(id: string): void {
  const v = cache.getVolume(id);
  geometry.delete(id);
  if (!v) return;
  for (const imageId of v.imageIds ?? []) {
    try {
      cache.removeImageLoadObject(imageId, { force: true });
    } catch {
      /* already gone */
    }
  }
  try {
    cache.removeVolumeLoadObject(id);
  } catch {
    /* already gone */
  }
}

function localVolume(vol: VolumeData) {
  return {
    metadata: metadataFor(vol),
    dimensions: vol.dims,
    spacing: vol.spacing,
    origin: vol.origin,
    direction: vol.direction as Types.Mat3,
    scalarData: vol.data as Types.PixelDataTypedArray,
  };
}

export async function showImage(vol: VolumeData, voi: { lower: number; upper: number }): Promise<void> {
  // Replacing an image: start from fresh viewports so nothing points at the old volume.
  if (imageLoaded && mounted) mountViewports(mounted);
  const e = eng();
  segmentation.removeAllSegmentations();
  forgetComparisons();
  forgetPreview();
  forgetReview();
  removeVolume(MASK_VOLUME_ID);
  removeVolume(IMAGE_VOLUME_ID);
  maskLoaded = false;

  geometry.set(IMAGE_VOLUME_ID, vol);
  volumeLoader.createLocalVolume(IMAGE_VOLUME_ID, localVolume(vol));

  await setVolumesForViewports(e, [{ volumeId: IMAGE_VOLUME_ID }], [...ORTHO_IDS]);
  await setVolumesForViewports(e, [{ volumeId: IMAGE_VOLUME_ID }], [VOLUME3D_ID]);
  (e.getViewport(VOLUME3D_ID) as Types.IVolumeViewport).setProperties({ preset: 'CT-Bone' });
  imageLoaded = true;
  enlarged.clear();
  for (const id of ALL_IDS) {
    const vp = e.getViewport(id) as Types.IVolumeViewport;
    if (id !== VOLUME3D_ID) vp.resetCamera();
    // Fitted to the canvas as it is now. A view that is not on screen is fitted when it first appears.
    const size = canvasSize(vp);
    if (size) drawnSize.set(id, size);
    else drawnSize.delete(id);
  }
  setVoi(voi.lower, voi.upper);
  if (!smoothPixels) setSmoothPixels(false);
  e.render();
}

/** The mask buffer stays owned by the caller; edits made by tools land in it directly. */
export function showMask(vol: VolumeData): void {
  segmentation.removeAllSegmentations();
  forgetComparisons();
  forgetPreview();
  forgetReview();
  removeVolume(MASK_VOLUME_ID);
  // Opening or swapping a mask is not a reason to leave the slice, zoom and place on screen.
  keepSlicesWhileAdding();
  geometry.set(MASK_VOLUME_ID, vol);
  // Tie the mask to the image so the threshold brush reads image values, not mask values.
  const imageIds = cache.getVolume(IMAGE_VOLUME_ID)?.imageIds;
  volumeLoader.createLocalLabelmapVolume(
    { ...localVolume(vol), referencedVolumeId: IMAGE_VOLUME_ID, referencedImageIds: imageIds },
    MASK_VOLUME_ID,
  );
  segmentation.addSegmentations([
    {
      segmentationId: SEGMENTATION_ID,
      representation: { type: LABELMAP, data: { volumeId: MASK_VOLUME_ID } },
    },
  ]);
  const map: Record<string, { segmentationId: string }[]> = {};
  for (const id of ALL_IDS) map[id] = [{ segmentationId: SEGMENTATION_ID }];
  segmentation.addLabelmapRepresentationToViewportMap(map);
  maskLoaded = true;
}

/* ───────────────────────── comparison masks ───────────────────────── */

/** A mask shown read-only next to the one being edited. */
export interface Comparison {
  id: string;
  vol: VolumeData;
  /** One outline colour for the whole mask, so it cannot be mistaken for the segments being edited. */
  color: string;
}

const compared = new Set<string>();
const compareSegmentation = (id: string) => `compare-${id}`;
const compareVolume = (id: string) => `w-compare-${id}`;

/** Outline only, a little heavier than the active mask's, never filled. */
const COMPARE_STYLE = {
  renderFill: false,
  renderFillInactive: false,
  renderOutline: true,
  renderOutlineInactive: true,
  outlineWidth: 2,
  outlineWidthInactive: 2,
  outlineOpacity: 1,
  outlineOpacityInactive: 1,
  activeSegmentOutlineWidthDelta: 0,
};

function forgetComparisons(): void {
  for (const id of compared) removeVolume(compareVolume(id));
  compared.clear();
}

/**
 * Shows these masks, and only these, as outlines over the slice views. They are
 * separate segmentations: the tools never write to them, and the 3D view leaves
 * them out. Call it after `showMask`, which clears them.
 */
export function showComparisons(list: Comparison[]): void {
  if (!maskLoaded || !engine) return;
  for (const id of compared) {
    try {
      segmentation.removeSegmentation(compareSegmentation(id));
    } catch {
      /* already gone */
    }
  }
  forgetComparisons();
  const imageIds = cache.getVolume(IMAGE_VOLUME_ID)?.imageIds;
  if (list.length > 0) keepSlicesWhileAdding(list.length);
  for (const item of list) {
    const volumeId = compareVolume(item.id);
    const segmentationId = compareSegmentation(item.id);
    geometry.set(volumeId, item.vol);
    volumeLoader.createLocalLabelmapVolume(
      { ...localVolume(item.vol), referencedVolumeId: IMAGE_VOLUME_ID, referencedImageIds: imageIds },
      volumeId,
    );
    segmentation.addSegmentations([{ segmentationId, representation: { type: LABELMAP, data: { volumeId } } }]);
    const [r, g, b] = hexToRgb(item.color);
    const lut = Array.from({ length: 256 }, (_, i) => (i === 0 ? [0, 0, 0, 0] : [r, g, b, 255])) as Types.ColorLUT;
    const map: Record<string, { segmentationId: string; config: { colorLUTOrIndex: Types.ColorLUT } }[]> = {};
    for (const id of ORTHO_IDS) map[id] = [{ segmentationId, config: { colorLUTOrIndex: lut } }];
    segmentation.addLabelmapRepresentationToViewportMap(map);
    segmentation.segmentationStyle.setStyle({ type: LABELMAP, segmentationId }, COMPARE_STYLE);
    compared.add(item.id);
  }
  // The tools paint on the active segmentation of a view; that is always the mask being edited.
  for (const id of ALL_IDS) {
    try {
      segmentation.activeSegmentation.setActiveSegmentation(id, SEGMENTATION_ID);
    } catch {
      /* representation not ready on this viewport yet */
    }
  }
  repaintMask();
}

/* ───────────────────────── fill preview ───────────────────────── */

const PREVIEW_VOLUME_ID = 'w-preview';
const PREVIEW_SEGMENTATION_ID = 'preview';
let previewShown = false;

/** Stripes of one colour at two strengths, with no outline, so a preview never looks like part of the mask. */
const PREVIEW_STYLE = {
  renderFill: true,
  renderFillInactive: true,
  fillAlpha: 0.8,
  fillAlphaInactive: 0.8,
  renderOutline: false,
  renderOutlineInactive: false,
};

/**
 * Shows a proposal over the slice views, from a buffer that is not the mask: values
 * PREVIEW_DARK and PREVIEW_LIGHT are drawn in `color`. The tools never write to it.
 */
export function showPreview(vol: VolumeData, color: string): void {
  if (!maskLoaded || !engine) return;
  hidePreview();
  keepSlicesWhileAdding();
  geometry.set(PREVIEW_VOLUME_ID, vol);
  volumeLoader.createLocalLabelmapVolume(
    { ...localVolume(vol), referencedVolumeId: IMAGE_VOLUME_ID, referencedImageIds: cache.getVolume(IMAGE_VOLUME_ID)?.imageIds },
    PREVIEW_VOLUME_ID,
  );
  segmentation.addSegmentations([
    { segmentationId: PREVIEW_SEGMENTATION_ID, representation: { type: LABELMAP, data: { volumeId: PREVIEW_VOLUME_ID } } },
  ]);
  const [r, g, b] = hexToRgb(color);
  const lut = Array.from({ length: 256 }, () => [0, 0, 0, 0]) as Types.ColorLUT;
  lut[PREVIEW_DARK] = [r, g, b, 255];
  lut[PREVIEW_LIGHT] = [r, g, b, 96];
  const map: Record<string, { segmentationId: string; config: { colorLUTOrIndex: Types.ColorLUT } }[]> = {};
  for (const id of ORTHO_IDS) map[id] = [{ segmentationId: PREVIEW_SEGMENTATION_ID, config: { colorLUTOrIndex: lut } }];
  segmentation.addLabelmapRepresentationToViewportMap(map);
  segmentation.segmentationStyle.setStyle({ type: LABELMAP, segmentationId: PREVIEW_SEGMENTATION_ID }, PREVIEW_STYLE);
  previewShown = true;
  // The tools keep painting on the mask being edited.
  for (const id of ALL_IDS) {
    try {
      segmentation.activeSegmentation.setActiveSegmentation(id, SEGMENTATION_ID);
    } catch {
      /* representation not ready on this viewport yet */
    }
  }
  for (const id of ORTHO_IDS) {
    segmentation.triggerSegmentationEvents.triggerSegmentationRepresentationModified(id, PREVIEW_SEGMENTATION_ID, LABELMAP);
  }
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(PREVIEW_SEGMENTATION_ID);
  repaintMask();
}

/* ───────────────────────── my version, kept aside after a merge ───────────────────────── */

const REVIEW_VOLUME_ID = 'w-review';
const REVIEW_SEGMENTATION_ID = 'review';
/** What is outlined now, so showing the same thing again only repaints. */
let reviewVol: VolumeData | null = null;

/** One white line, never filled: it cannot be taken for a segment, and the room's version shows through. */
const REVIEW_COLOR: [number, number, number, number] = [255, 255, 255, 255];
const REVIEW_STYLE = {
  renderFill: false,
  renderFillInactive: false,
  renderOutline: true,
  renderOutlineInactive: true,
  outlineWidth: 2,
  outlineWidthInactive: 2,
  outlineOpacity: 1,
  outlineOpacityInactive: 1,
  activeSegmentOutlineWidthDelta: 0,
};

/**
 * Outlines `vol` over the slice views: my version of the slices a merge left to decide, from a
 * buffer that is not the mask. The tools never write to it and the 3D view leaves it out.
 * Called again with the same volume after its voxels changed, it repaints.
 */
export function showReview(vol: VolumeData): void {
  if (!maskLoaded || !engine) return;
  if (reviewVol !== vol) {
    hideReview();
    keepSlicesWhileAdding();
    geometry.set(REVIEW_VOLUME_ID, vol);
    volumeLoader.createLocalLabelmapVolume(
      { ...localVolume(vol), referencedVolumeId: IMAGE_VOLUME_ID, referencedImageIds: cache.getVolume(IMAGE_VOLUME_ID)?.imageIds },
      REVIEW_VOLUME_ID,
    );
    segmentation.addSegmentations([
      { segmentationId: REVIEW_SEGMENTATION_ID, representation: { type: LABELMAP, data: { volumeId: REVIEW_VOLUME_ID } } },
    ]);
    const lut = Array.from({ length: 256 }, (_, i) => (i === 0 ? [0, 0, 0, 0] : REVIEW_COLOR)) as Types.ColorLUT;
    const map: Record<string, { segmentationId: string; config: { colorLUTOrIndex: Types.ColorLUT } }[]> = {};
    for (const id of ORTHO_IDS) map[id] = [{ segmentationId: REVIEW_SEGMENTATION_ID, config: { colorLUTOrIndex: lut } }];
    segmentation.addLabelmapRepresentationToViewportMap(map);
    segmentation.segmentationStyle.setStyle({ type: LABELMAP, segmentationId: REVIEW_SEGMENTATION_ID }, REVIEW_STYLE);
    reviewVol = vol;
    // The tools keep painting on the mask being edited.
    for (const id of ALL_IDS) {
      try {
        segmentation.activeSegmentation.setActiveSegmentation(id, SEGMENTATION_ID);
      } catch {
        /* representation not ready on this viewport yet */
      }
    }
  }
  try {
    for (const id of ORTHO_IDS) {
      segmentation.triggerSegmentationEvents.triggerSegmentationRepresentationModified(id, REVIEW_SEGMENTATION_ID, LABELMAP);
    }
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(REVIEW_SEGMENTATION_ID);
  } catch {
    /* nothing to repaint yet */
  }
  repaintMask();
}

/** After every segmentation was removed at once: the outline went with them. */
function forgetReview(): void {
  if (reviewVol) removeVolume(REVIEW_VOLUME_ID);
  reviewVol = null;
}

export function hideReview(): void {
  if (!reviewVol) return;
  reviewVol = null;
  try {
    segmentation.removeSegmentation(REVIEW_SEGMENTATION_ID);
  } catch {
    /* already gone */
  }
  removeVolume(REVIEW_VOLUME_ID);
  repaintMask();
}

/**
 * The number a slice view's counter would show for the slice through world point `w`,
 * without going there. Slices are counted along the view's normal, `spacing` apart.
 */
export function sliceNumberAt(id: string, w: [number, number, number], spacing: number): number | null {
  const plane = viewPlane(id);
  const now = getSlice(id);
  if (!plane || !now || !(spacing > 0)) return null;
  const d = (w[0] - plane.point[0]) * plane.normal[0] + (w[1] - plane.point[1]) * plane.normal[1] + (w[2] - plane.point[2]) * plane.normal[2];
  return Math.max(0, Math.min(now.count - 1, Math.round(now.index + d / spacing))) + 1;
}

/** Camera resets still to come in each slice view from labelmaps that were just added. */
const resetsToCome = new Map<string, number>();
let stopKeeping: (() => void) | null = null;

/**
 * Adding a labelmap makes the viewer reset each slice view's camera and put it straight
 * back. The reference lines answer a reset by sending every view to its middle slice at
 * its fitted zoom, which would lose the user's place, so they sit out the resets that
 * adding `count` labelmaps causes: one for each labelmap in each slice view.
 */
function keepSlicesWhileAdding(count = 1): void {
  if (!engine || count <= 0) return;
  for (const id of ORTHO_IDS) resetsToCome.set(id, (resetsToCome.get(id) ?? 0) + count);
  LinkedLinesTool.followResets = false;
  // One watch for every addition that is still on its way.
  const offs: (() => void)[] = [];
  stopKeeping?.();
  const done = () => {
    stop();
    resetsToCome.clear();
    LinkedLinesTool.followResets = true;
  };
  // Long enough for the largest labelmap to reach the views; the resets normally end it sooner.
  const timer = setTimeout(done, 5000);
  const stop = () => {
    clearTimeout(timer);
    offs.forEach((off) => off());
    stopKeeping = null;
  };
  stopKeeping = stop;
  for (const id of ORTHO_IDS) {
    const el = orthoViewport(id).element;
    const onReset = () => {
      const left = (resetsToCome.get(id) ?? 1) - 1;
      if (left > 0) resetsToCome.set(id, left);
      else resetsToCome.delete(id);
      // After the lines have had their turn with this event, unless more was added meanwhile.
      if (resetsToCome.size === 0) setTimeout(() => resetsToCome.size === 0 && stopKeeping === stop && done(), 0);
    };
    el.addEventListener(Enums.Events.CAMERA_RESET, onReset);
    offs.push(() => el.removeEventListener(Enums.Events.CAMERA_RESET, onReset));
  }
}

/** After every segmentation was removed at once: the preview went with them. */
function forgetPreview(): void {
  if (previewShown) removeVolume(PREVIEW_VOLUME_ID);
  previewShown = false;
}

export function hidePreview(): void {
  if (!previewShown) return;
  previewShown = false;
  try {
    segmentation.removeSegmentation(PREVIEW_SEGMENTATION_ID);
  } catch {
    /* already gone */
  }
  removeVolume(PREVIEW_VOLUME_ID);
  repaintMask();
}

/* ───────────────────────── how the image is drawn ───────────────────────── */

let smoothPixels = true;

/**
 * Smooth: the slice views blend between voxels. Off: every voxel is drawn as a flat
 * block, so its edge is where the data's edge is. Drawing only; no value changes.
 */
export function setSmoothPixels(smooth: boolean): void {
  smoothPixels = smooth;
  if (!engine || !imageLoaded) return;
  const type = smooth ? Enums.InterpolationType.LINEAR : Enums.InterpolationType.NEAREST;
  for (const id of ORTHO_IDS) {
    const vp = orthoViewport(id);
    vp.setProperties({ interpolationType: type }, IMAGE_VOLUME_ID);
    vp.render();
  }
}

/** Whether a slice view is blending between voxels now. */
export function getSmoothPixels(id: string = 'axial'): boolean | null {
  if (!engine || !imageLoaded) return null;
  return orthoViewport(id).getProperties(IMAGE_VOLUME_ID)?.interpolationType !== Enums.InterpolationType.NEAREST;
}

/** A slice view as it is on screen, for mapping what is drawn on it onto voxels. */
export function viewFrame(id: string): ViewFrame | null {
  if (!engine || !imageLoaded) return null;
  const vp = orthoViewport(id);
  const cam = vp.getCamera();
  const origin = vp.canvasToWorld([0, 0]);
  const x = vp.canvasToWorld([1, 0]);
  const y = vp.canvasToWorld([0, 1]);
  if (!cam.viewPlaneNormal || !cam.focalPoint) return null;
  return {
    origin: [origin[0], origin[1], origin[2]],
    right: [x[0] - origin[0], x[1] - origin[1], x[2] - origin[2]],
    down: [y[0] - origin[0], y[1] - origin[1], y[2] - origin[2]],
    normal: [...cam.viewPlaneNormal],
    focal: [...cam.focalPoint],
  };
}

/** How bright the image is drawn when dimmed. The voxel values and the window are untouched. */
const DIMMED = 0.35;

/** Draws the image darker so masks stand out, or back at full strength. A view setting only. */
export function setImageDimmed(dimmed: boolean): void {
  if (!engine || !imageLoaded) return;
  for (const id of ORTHO_IDS) {
    const vp = orthoViewport(id);
    vp.setProperties({ colormap: { opacity: dimmed ? DIMMED : 1 } }, IMAGE_VOLUME_ID);
    vp.render();
  }
}

export function set3dImageVisible(visible: boolean): void {
  if (!engine || !imageLoaded) return;
  const vp = engine.getViewport(VOLUME3D_ID);
  for (const entry of vp.getActors()) {
    if (entry.referencedId === IMAGE_VOLUME_ID || entry.uid === IMAGE_VOLUME_ID) {
      (entry.actor as { setVisibility(v: boolean): void }).setVisibility(visible);
    }
  }
  vp.render();
}

/**
 * Which segments each viewport draws. Cornerstone keeps this per viewport representation and
 * only lists the segments that existed when the representation was added, or that have been
 * the active segment since. Its own setSegmentIndexVisibility returns without doing anything
 * for a segment that is not listed, so the list is written here in full.
 */
function writeVisibility(list: SegmentInfo[], maskHidden: boolean): void {
  for (const id of ALL_IDS) {
    for (const rep of segmentation.state.getSegmentationRepresentations(id, { segmentationId: SEGMENTATION_ID, type: LABELMAP })) {
      const shown = rep.segments as Record<number, { visible: boolean }>;
      for (const key of Object.keys(shown)) {
        if (!list.some((seg) => seg.index === Number(key))) delete shown[Number(key)];
      }
      for (const seg of list) shown[seg.index] = { ...shown[seg.index], visible: seg.visible && !maskHidden };
      rep.visible = true;
    }
  }
}

/** `maskHidden` turns every segment off, fill and outline, without changing what each one is set to. */
export function applySegments(list: SegmentInfo[], active: number, maskHidden = false): void {
  if (!maskLoaded) return;
  const state = segmentation.state.getSegmentation(SEGMENTATION_ID);
  if (!state) return;
  const known = state.segments as Record<number, unknown>;
  for (const key of Object.keys(known)) {
    if (!list.some((seg) => seg.index === Number(key))) delete known[Number(key)];
  }
  for (const seg of list) {
    const entry = (known[seg.index] ??= {
      segmentIndex: seg.index,
      label: seg.name,
      locked: false,
      cachedStats: {},
      active: false,
    }) as { label: string };
    entry.label = seg.name;
    const [r, g, b] = hexToRgb(seg.color);
    for (const id of ALL_IDS) {
      try {
        segmentation.config.color.setSegmentIndexColor(id, SEGMENTATION_ID, seg.index, [r, g, b, 255]);
      } catch {
        /* representation not ready on this viewport yet */
      }
    }
    segmentation.segmentLocking.setSegmentIndexLocked(SEGMENTATION_ID, seg.index, seg.locked);
  }
  if (active > 0) segmentation.segmentIndex.setActiveSegmentIndex(SEGMENTATION_ID, active);
  // After the active segment is set: that call lists the segment as visible when it is new.
  writeVisibility(list, maskHidden);
  repaintMask();
}

export function setMaskStyle(opacity: number, outlineOnly: boolean): void {
  const style = {
    renderFill: !outlineOnly,
    renderFillInactive: !outlineOnly,
    fillAlpha: opacity,
    fillAlphaInactive: opacity,
    renderOutline: true,
    renderOutlineInactive: true,
    outlineWidth: outlineOnly ? 2 : 1,
    outlineWidthInactive: outlineOnly ? 2 : 1,
    outlineOpacity: 1,
    outlineOpacityInactive: 1,
  };
  segmentation.segmentationStyle.setStyle({ type: LABELMAP }, style);
  // The 3D view shows whole segments. With an outline the mapper draws one cut through the
  // volume instead, so there the outline is off and the fill is solid.
  segmentation.segmentationStyle.setStyle(
    { type: LABELMAP, viewportId: VOLUME3D_ID },
    {
      ...style,
      renderFill: true,
      renderFillInactive: true,
      fillAlpha: 1,
      fillAlphaInactive: 1,
      renderOutline: false,
      renderOutlineInactive: false,
    },
  );
  repaintMask();
}

/** Style and visibility changes only show once the segmentation itself is re-rendered. */
function repaintMask(): void {
  if (!maskLoaded || !engine) return;
  try {
    for (const id of ALL_IDS) {
      segmentation.triggerSegmentationEvents.triggerSegmentationRepresentationModified(id, SEGMENTATION_ID, LABELMAP);
    }
    csTools.utilities.segmentation.triggerSegmentationRenderBySegmentationId(SEGMENTATION_ID);
    for (const item of compared) {
      for (const id of ORTHO_IDS) {
        segmentation.triggerSegmentationEvents.triggerSegmentationRepresentationModified(id, compareSegmentation(item), LABELMAP);
      }
      csTools.utilities.segmentation.triggerSegmentationRenderBySegmentationId(compareSegmentation(item));
    }
  } catch {
    /* nothing to repaint yet */
  }
  engine.render();
}

/** Tell the renderer that mask voxels were changed from outside the tools. */
export function refreshMask(slices?: number[]): void {
  if (!maskLoaded) return;
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(SEGMENTATION_ID, slices);
}

/**
 * Tell the renderer that image voxels were written, for a guest of a view-through-host
 * room whose picture arrives a plane at a time. `slices` are stored (k) slices.
 */
export function refreshImage(slices?: number[]): void {
  if (!engine || !imageLoaded) return;
  const vol = cache.getVolume(IMAGE_VOLUME_ID) as
    | (Types.IImageVolume & { markFrameModified?: (i: number) => void; voxelManager?: { invalidateCache?: () => void } })
    | undefined;
  if (!vol) return;
  const which = slices ?? Array.from({ length: vol.dimensions[2] }, (_, k) => k);
  for (const k of which) vol.markFrameModified?.(k);
  vol.voxelManager?.invalidateCache?.();
  vol.imageData?.modified();
  for (const id of ORTHO_IDS) orthoViewport(id).render();
}

/** A point on the plane a slice view shows, and the plane's normal, in world coordinates. */
export function viewPlane(id: string): { point: number[]; normal: number[] } | null {
  if (!engine || !imageLoaded) return null;
  try {
    const camera = orthoViewport(id).getCamera();
    if (!camera.focalPoint || !camera.viewPlaneNormal) return null;
    return { point: [...camera.focalPoint], normal: [...camera.viewPlaneNormal] };
  } catch {
    return null;
  }
}

export function onMaskEdited(handler: (slices: number[] | undefined) => void): () => void {
  const listener = (evt: Event) => {
    const detail = (evt as CustomEvent).detail as { segmentationId?: string; modifiedSlicesToUse?: number[] };
    if (detail?.segmentationId !== SEGMENTATION_ID) return;
    handler(detail.modifiedSlicesToUse);
  };
  eventTarget.addEventListener(ToolEnums.Events.SEGMENTATION_DATA_MODIFIED, listener);
  return () => eventTarget.removeEventListener(ToolEnums.Events.SEGMENTATION_DATA_MODIFIED, listener);
}

export function setVoi(lower: number, upper: number): void {
  if (!engine || !imageLoaded) return;
  for (const id of ORTHO_IDS) {
    const vp = orthoViewport(id);
    vp.setProperties({ voiRange: { lower, upper } });
    vp.render();
  }
}

export function getVoi(id: string = 'axial'): { lower: number; upper: number } | null {
  if (!engine || !imageLoaded) return null;
  const range = orthoViewport(id).getProperties()?.voiRange;
  return range ? { lower: range.lower, upper: range.upper } : null;
}

export function getSlice(id: string): { index: number; count: number } | null {
  if (!engine || !imageLoaded) return null;
  const vp = orthoViewport(id);
  try {
    return { index: vp.getSliceIndex(), count: vp.getNumberOfSlices() };
  } catch {
    return null;
  }
}

export function getZoom(id: string): number | null {
  if (!engine || !imageLoaded) return null;
  try {
    return orthoViewport(id).getZoom();
  } catch {
    return null;
  }
}

export function canvasToWorld(id: string, x: number, y: number): [number, number, number] | null {
  if (!engine || !imageLoaded) return null;
  const w = orthoViewport(id).canvasToWorld([x, y]);
  return [w[0], w[1], w[2]];
}

export function worldToCanvas(id: string, w: [number, number, number]): [number, number] | null {
  if (!engine || !imageLoaded) return null;
  const c = orthoViewport(id).worldToCanvas(w);
  return [c[0], c[1]];
}

/** Signed distance in mm from the viewport's current slice plane to a point. */
export function distanceToSlice(id: string, w: [number, number, number]): number {
  const cam = orthoViewport(id).getCamera();
  const n = cam.viewPlaneNormal!;
  const f = cam.focalPoint!;
  return (w[0] - f[0]) * n[0] + (w[1] - f[1]) * n[1] + (w[2] - f[2]) * n[2];
}

export function jumpTo(w: [number, number, number], except?: string): void {
  if (!engine || !imageLoaded) return;
  for (const id of ORTHO_IDS) {
    if (id === except) continue;
    const vp = orthoViewport(id);
    const cam = vp.getCamera();
    const n = cam.viewPlaneNormal!;
    const f = cam.focalPoint!;
    const p = cam.position!;
    const d = (w[0] - f[0]) * n[0] + (w[1] - f[1]) * n[1] + (w[2] - f[2]) * n[2];
    vp.setCamera({
      focalPoint: [f[0] + n[0] * d, f[1] + n[1] * d, f[2] + n[2] * d],
      position: [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d],
    });
    vp.render();
  }
}

export function scrollSlices(id: string, delta: number): void {
  if (!engine || !imageLoaded) return;
  csUtils.scroll(orthoViewport(id) as unknown as Parameters<typeof csUtils.scroll>[0], { delta });
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 64;

/**
 * Magnifies a view by `factor`. In a slice view the image point at `at`
 * (canvas pixels) stays where it is; without `at` the centre does.
 */
export function zoomBy(id: string, factor: number, at?: [number, number]): void {
  if (!engine || !imageLoaded || !(factor > 0) || factor === 1) return;
  const vp = engine.getViewport(id) as Types.IVolumeViewport;
  const cam = vp.getCamera();
  const focal = cam.focalPoint as Types.Point3;
  const position = cam.position as Types.Point3;
  if (id === VOLUME3D_ID) {
    if (cam.parallelProjection) vp.setCamera({ parallelScale: cam.parallelScale! / factor });
    // A perspective camera gets closer instead; it still turns about the same point.
    else vp.setCamera({ position: zoomAbout(position, focal, factor) });
    vp.render();
    return;
  }
  const zoom = vp.getZoom();
  const f = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor)) / zoom;
  if (f === 1) return;
  const point = at ? (vp.canvasToWorld(at) as Types.Point3) : focal;
  const next = zoomAbout(focal, point, f);
  const shift = [next[0] - focal[0], next[1] - focal[1], next[2] - focal[2]];
  vp.setCamera({
    parallelScale: cam.parallelScale! / f,
    focalPoint: next,
    position: [position[0] + shift[0], position[1] + shift[1], position[2] + shift[2]],
  });
  vp.render();
}

/** Moves the image in a slice view by a number of canvas pixels. */
export function panBy(id: string, dx: number, dy: number): void {
  if (!engine || !imageLoaded || id === VOLUME3D_ID || (dx === 0 && dy === 0)) return;
  const vp = orthoViewport(id);
  const from = vp.canvasToWorld([dx, dy]);
  const to = vp.canvasToWorld([0, 0]);
  const cam = vp.getCamera();
  const f = cam.focalPoint!;
  const p = cam.position!;
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  vp.setCamera({ focalPoint: [f[0] + d[0], f[1] + d[1], f[2] + d[2]], position: [p[0] + d[0], p[1] + d[1], p[2] + d[2]] });
  vp.render();
}

export function fitAll(): void {
  if (!engine || !imageLoaded) return;
  for (const id of ALL_IDS) {
    const vp = engine.getViewport(id) as Types.IVolumeViewport;
    vp.resetCamera();
    // A view that is not on screen cannot be fitted yet; it is when it comes back.
    if (!canvasSize(vp)) drawnSize.delete(id);
    vp.render();
  }
}

function canvasSize(vp: { canvas: HTMLCanvasElement }): { w: number; h: number } | null {
  const { clientWidth: w, clientHeight: h } = vp.canvas;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** A slice view's size on screen, in the pixels `viewFrame` counts in. Null while it is not shown. */
export function viewSize(id: string): [number, number] | null {
  if (!engine || !imageLoaded) return null;
  const size = canvasSize(orthoViewport(id));
  return size ? [size.w, size.h] : null;
}

/** Draws now whatever is waiting for the next frame. */
function renderNow(): void {
  if (!engine) return;
  // Cornerstone only renders on an animation frame. These two are its own frame callback and handle.
  type Frames = { _renderFlaggedViewports?: () => void; _animationFrameHandle?: number | null };
  const e = (engine as unknown as { _implementation?: Frames })._implementation;
  if (typeof e?._renderFlaggedViewports !== 'function') return;
  if (e._animationFrameHandle != null) cancelAnimationFrame(e._animationFrameHandle);
  e._renderFlaggedViewports();
}

/**
 * Call after the views have been moved or sized. Each canvas that changed gets its new
 * backing size and is drawn before this returns, so it is never shown stretched.
 *
 * The image does not move or change size on screen: every view keeps its millimetres per
 * pixel and the point at its centre. Cornerstone alone keeps the camera's parallel scale,
 * which is half the view's height in millimetres, so a taller view would magnify the image.
 * A view that is not on screen is skipped and costs nothing; it is picked up here when it returns.
 *
 * The one exception is `maximised`, the view the user asked to see alone: its image grows
 * with its pane, and shrinks back by as much when the view is no longer the maximised one.
 */
export function resizeViewports(maximised: string | null = null): void {
  if (!engine) return;
  // A frame that is still waiting makes Cornerstone skip the resize, so draw it first.
  renderNow();
  const changed: { vp: Types.IVolumeViewport; id: string; size: { w: number; h: number }; mmPerPx: number | null }[] = [];
  let visibility = false;
  for (const id of ALL_IDS) {
    const vp = engine.getViewport(id) as Types.IVolumeViewport;
    const size = canvasSize(vp);
    if (!!size !== onScreen.has(id)) {
      visibility = true;
      if (size) onScreen.add(id);
      else onScreen.delete(id);
    }
    if (!size) continue;
    const last = drawnSize.get(id);
    const grown = enlarged.get(id);
    if (id !== maximised) enlarged.delete(id);
    if (last && last.w === size.w && last.h === size.h) continue;
    const scale = imageLoaded ? vp.getCamera().parallelScale : undefined;
    let mmPerPx = last && scale ? (2 * scale) / last.h : null;
    if (mmPerPx !== null && last) {
      if (id !== maximised && grown) mmPerPx *= grown;
      if (id === maximised && !grown) {
        const growth = paneGrowth(last, size, imageExtent(vp));
        enlarged.set(id, growth);
        mmPerPx /= growth;
      }
    }
    changed.push({ vp, id, size, mmPerPx });
  }
  if (changed.length) {
    engine.resize(false, true);
    for (const { vp, id, size, mmPerPx } of changed) {
      if (!imageLoaded) continue;
      if (mmPerPx !== null) vp.setCamera({ parallelScale: (mmPerPx * size.h) / 2 });
      else fitKeepingSlice(vp, id);
      drawnSize.set(id, size);
      vp.render();
    }
  }
  if (visibility && imageLoaded) csTools.utilities.triggerAnnotationRenderForViewportIds([...ORTHO_IDS]);
  renderNow();
}

/** Width and height, in millimetres, of what a view holds, as its camera sees it. */
function imageExtent(vp: Types.IVolumeViewport): { w: number; h: number } {
  const b = vp.getBounds();
  const { viewUp: up, viewPlaneNormal: n } = vp.getCamera();
  if (!b || !up || !n) return { w: 0, h: 0 };
  const right = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  // The box around the image, measured along the camera's right and up.
  const size = [b[1] - b[0], b[3] - b[2], b[5] - b[4]];
  const along = (axis: ArrayLike<number>) => Math.abs(axis[0]) * size[0] + Math.abs(axis[1]) * size[1] + Math.abs(axis[2]) * size[2];
  return { w: along(right), h: along(up) };
}

/** Fits a view that is on screen for the first time since the image was opened, without losing its slice. */
function fitKeepingSlice(vp: Types.IVolumeViewport, id: string): void {
  const before = vp.getCamera();
  vp.resetCamera();
  if (id === VOLUME3D_ID) return;
  const cam = vp.getCamera();
  const n = cam.viewPlaneNormal!;
  const f = cam.focalPoint!;
  const p = cam.position!;
  const b = before.focalPoint!;
  const d = (b[0] - f[0]) * n[0] + (b[1] - f[1]) * n[1] + (b[2] - f[2]) * n[2];
  vp.setCamera({
    focalPoint: [f[0] + n[0] * d, f[1] + n[1] * d, f[2] + n[2] * d],
    position: [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d],
  });
}

/** Millimetres covered by one screen pixel in a view. */
export function getMmPerPixel(id: string): number | null {
  if (!engine || !imageLoaded) return null;
  const vp = engine.getViewport(id) as Types.IVolumeViewport;
  const size = canvasSize(vp);
  const scale = vp.getCamera().parallelScale;
  return size && scale ? (2 * scale) / size.h : null;
}

/**
 * Cornerstone remembers the last key pressed over a view until its key-up, and while it
 * holds one no mouse tool matches a plain click. The key-up never comes when the window
 * loses focus first (switching apps, a save dialog, a screenshot shortcut), which would
 * leave every tool dead until the next key press. Mouse events carry their own Shift,
 * Ctrl, Alt and Cmd state, so the remembered key is dropped before each press.
 */
export function forgetHeldKey(): void {
  document.dispatchEvent(new KeyboardEvent('keyup'));
}

export function clearMeasurements(): void {
  csTools.annotation.state.removeAllAnnotations();
  engine?.render();
}

export const ViewportEvents = {
  camera: Enums.Events.CAMERA_MODIFIED,
  voi: Enums.Events.VOI_MODIFIED,
  newImage: Enums.Events.VOLUME_NEW_IMAGE,
};
