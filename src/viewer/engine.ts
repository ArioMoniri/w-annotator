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
import { hexToRgb } from './geometry';

const {
  ToolGroupManager,
  segmentation,
  Enums: ToolEnums,
  BrushTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  StackScrollTool,
  CrosshairsTool,
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
        StackScrollTool,
        CrosshairsTool,
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
  ortho.addTool(StackScrollTool.toolName);
  ortho.addTool(LengthTool.toolName);
  ortho.addTool(RectangleScissorsTool.toolName);
  ortho.addTool(CircleScissorsTool.toolName);
  ortho.addTool(SphereScissorsTool.toolName);
  ortho.addTool(PaintFillTool.toolName);
  ortho.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor: (viewportId: string) => VIEW_COLORS[viewportId] ?? '#ffffff',
    getReferenceLineControllable: () => true,
    getReferenceLineDraggableRotatable: () => false,
    getReferenceLineSlabThicknessControlsOn: () => false,
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
  vol.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }],
  });
  vol.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
}

export interface ToolOptions {
  brushShape: 'circle' | 'sphere';
  scissorsShape: 'rectangle' | 'circle' | 'sphere';
  scissorsAction: 'erase' | 'fill';
}

function toolNameFor(tool: ToolId, o: ToolOptions): string {
  switch (tool) {
    case 'crosshair':
      return CrosshairsTool.toolName;
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
      return o.scissorsShape === 'circle'
        ? CircleScissorsTool.toolName
        : o.scissorsShape === 'sphere'
          ? SphereScissorsTool.toolName
          : RectangleScissorsTool.toolName;
    case 'fill':
      return PaintFillTool.toolName;
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

/** Makes one tool the left-button tool. Scroll, pan, zoom and window stay on their own buttons. */
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
  if (name === CrosshairsTool.toolName) group.setToolActive(name, { bindings: [primary] });
  else group.setToolDisabled(CrosshairsTool.toolName);

  // Bindings add up across calls, so clear the navigation tools before binding them again.
  for (const t of [StackScrollTool.toolName, PanTool.toolName, ZoomTool.toolName, WindowLevelTool.toolName]) {
    group.setToolPassive(t, { removeAllBindings: true });
  }
  for (const t of [BRUSH.eraseCircle, BRUSH.eraseSphere]) {
    if (t !== name) group.setToolPassive(t, { removeAllBindings: true });
    if (t !== name) group.setToolDisabled(t);
  }
  group.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  group.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }, ...(name === PanTool.toolName ? [primary] : [])],
  });
  group.setToolActive(ZoomTool.toolName, {
    bindings: [
      { mouseButton: MouseBindings.Wheel, modifierKey: KeyboardBindings.Ctrl },
      ...(name === ZoomTool.toolName ? [primary] : []),
    ],
  });
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

export function setBrushSize(mm: number): void {
  if (!ToolGroupManager.getToolGroup(ORTHO_GROUP)) return;
  for (const name of Object.values(BRUSH)) {
    csTools.utilities.segmentation.setBrushSizeForToolGroup(ORTHO_GROUP, mm, name);
  }
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
  removeVolume(MASK_VOLUME_ID);
  removeVolume(IMAGE_VOLUME_ID);
  maskLoaded = false;

  geometry.set(IMAGE_VOLUME_ID, vol);
  volumeLoader.createLocalVolume(IMAGE_VOLUME_ID, localVolume(vol));

  await setVolumesForViewports(e, [{ volumeId: IMAGE_VOLUME_ID }], [...ORTHO_IDS]);
  await setVolumesForViewports(e, [{ volumeId: IMAGE_VOLUME_ID }], [VOLUME3D_ID]);
  (e.getViewport(VOLUME3D_ID) as Types.IVolumeViewport).setProperties({ preset: 'CT-Bone' });
  imageLoaded = true;
  for (const id of ORTHO_IDS) orthoViewport(id).resetCamera();
  setVoi(voi.lower, voi.upper);
  e.render();
}

/** The mask buffer stays owned by the caller; edits made by tools land in it directly. */
export function showMask(vol: VolumeData): void {
  segmentation.removeAllSegmentations();
  removeVolume(MASK_VOLUME_ID);
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

export function fitAll(): void {
  if (!engine || !imageLoaded) return;
  for (const id of ALL_IDS) {
    const vp = engine.getViewport(id) as Types.IVolumeViewport;
    vp.resetCamera();
    vp.render();
  }
}

export function resizeViewports(): void {
  if (!engine) return;
  engine.resize(true, true);
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
