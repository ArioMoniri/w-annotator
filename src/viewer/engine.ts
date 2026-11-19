import {
  RenderingEngine,
  Enums,
  cache,
  init as csInit,
  metaData,
  setVolumesForViewports,
  volumeLoader,
  type Types,
} from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import type { VolumeData } from '../io/types';

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
export const ENGINE_ID = 'w-engine';
export const IMAGE_VOLUME_ID = 'w-image';
export const MASK_VOLUME_ID = 'w-mask';
export const SEGMENTATION_ID = 'mask';
export const ORTHO_GROUP = 'ortho';
export const VOLUME3D_GROUP = 'vol3d';

let ready: Promise<void> | null = null;

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
  const position = [
    vol.origin[0] + d[6] * vol.spacing[2] * k,
    vol.origin[1] + d[7] * vol.spacing[2] * k,
    vol.origin[2] + d[8] * vol.spacing[2] * k,
  ];
  return {
    frameOfReferenceUID: 'w-annotator-frame',
    rows: vol.dims[1],
    columns: vol.dims[0],
    imageOrientationPatient: d.slice(0, 6),
    rowCosines: d.slice(0, 3),
    columnCosines: d.slice(3, 6),
    imagePositionPatient: position,
    pixelSpacing: [vol.spacing[1], vol.spacing[0]],
    rowPixelSpacing: vol.spacing[1],
    columnPixelSpacing: vol.spacing[0],
    sliceThickness: vol.spacing[2],
    sliceLocation: k * vol.spacing[2],
  };
}
let engine: RenderingEngine | null = null;

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

export function getEngine(): RenderingEngine {
  if (!engine) throw new Error('Viewer is not mounted');
  return engine;
}

export interface ViewportElements {
  axial: HTMLDivElement;
  sagittal: HTMLDivElement;
  coronal: HTMLDivElement;
  volume3d: HTMLDivElement;
}

export function mountViewports(els: ViewportElements): void {
  engine?.destroy();
  engine = new RenderingEngine(ENGINE_ID);
  const { ViewportType, OrientationAxis } = Enums;
  const bg: Types.Point3 = [0, 0, 0];
  engine.setViewports([
    {
      viewportId: 'axial',
      type: ViewportType.ORTHOGRAPHIC,
      element: els.axial,
      defaultOptions: { orientation: OrientationAxis.AXIAL, background: bg },
    },
    {
      viewportId: 'sagittal',
      type: ViewportType.ORTHOGRAPHIC,
      element: els.sagittal,
      defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: bg },
    },
    {
      viewportId: 'coronal',
      type: ViewportType.ORTHOGRAPHIC,
      element: els.coronal,
      defaultOptions: { orientation: OrientationAxis.CORONAL, background: bg },
    },
    {
      viewportId: VOLUME3D_ID,
      type: ViewportType.VOLUME_3D,
      element: els.volume3d,
      defaultOptions: { orientation: OrientationAxis.CORONAL, background: bg },
    },
  ]);
  setupToolGroups();
}

const MouseBindings = ToolEnums.MouseBindings;

export const BRUSH_INSTANCES = {
  brush: 'Brush',
  eraser: 'Eraser',
  sphereBrush: 'SphereBrush',
  sphereEraser: 'SphereEraser',
  thresholdBrush: 'ThresholdBrush',
} as const;

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
  ortho.addToolInstance(BRUSH_INSTANCES.brush, BrushTool.toolName, {
    activeStrategy: 'FILL_INSIDE_CIRCLE',
  });
  ortho.addToolInstance(BRUSH_INSTANCES.eraser, BrushTool.toolName, {
    activeStrategy: 'ERASE_INSIDE_CIRCLE',
  });
  ortho.addToolInstance(BRUSH_INSTANCES.sphereBrush, BrushTool.toolName, {
    activeStrategy: 'FILL_INSIDE_SPHERE',
  });
  ortho.addToolInstance(BRUSH_INSTANCES.sphereEraser, BrushTool.toolName, {
    activeStrategy: 'ERASE_INSIDE_SPHERE',
  });
  ortho.addToolInstance(BRUSH_INSTANCES.thresholdBrush, BrushTool.toolName, {
    activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
  });
  for (const id of ORTHO_IDS) ortho.addViewport(id, ENGINE_ID);

  ortho.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });
  ortho.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  ortho.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });

  const vol = ToolGroupManager.createToolGroup(VOLUME3D_GROUP)!;
  vol.addTool(TrackballRotateTool.toolName);
  vol.addTool(ZoomTool.toolName);
  vol.addTool(PanTool.toolName);
  vol.addViewport(VOLUME3D_ID, ENGINE_ID);
  vol.setToolActive(TrackballRotateTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  vol.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }],
  });
  vol.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
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
    FrameOfReferenceUID: 'w-annotator-frame',
    Columns: vol.dims[0],
    Rows: vol.dims[1],
    voiLut: [],
    VOILUTFunction: 'LINEAR',
  };
}

function removeVolume(id: string): void {
  const v = cache.getVolume(id);
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

export async function showImage(vol: VolumeData, voi: { lower: number; upper: number }): Promise<void> {
  const eng = getEngine();
  segmentation.removeAllSegmentations();
  removeVolume(MASK_VOLUME_ID);
  removeVolume(IMAGE_VOLUME_ID);

  geometry.set(IMAGE_VOLUME_ID, vol);
  volumeLoader.createLocalVolume(IMAGE_VOLUME_ID, {
    metadata: metadataFor(vol),
    dimensions: vol.dims,
    spacing: vol.spacing,
    origin: vol.origin,
    direction: vol.direction as Types.Mat3,
    scalarData: vol.data as Types.PixelDataTypedArray,
  });

  await setVolumesForViewports(
    eng,
    [
      {
        volumeId: IMAGE_VOLUME_ID,
        callback: ({ volumeActor }) => {
          volumeActor.getProperty().getRGBTransferFunction(0).setMappingRange(voi.lower, voi.upper);
        },
      },
    ],
    [...ORTHO_IDS],
  );
  await setVolumesForViewports(eng, [{ volumeId: IMAGE_VOLUME_ID }], [VOLUME3D_ID]);
  (eng.getViewport(VOLUME3D_ID) as Types.IVolumeViewport).setProperties({ preset: 'CT-Bone' });
  eng.render();
}

export function showMask(vol: VolumeData): void {
  segmentation.removeAllSegmentations();
  removeVolume(MASK_VOLUME_ID);
  geometry.set(MASK_VOLUME_ID, vol);
  volumeLoader.createLocalLabelmapVolume(
    {
      metadata: metadataFor(vol),
      dimensions: vol.dims,
      spacing: vol.spacing,
      origin: vol.origin,
      direction: vol.direction as Types.Mat3,
      scalarData: vol.data as Types.PixelDataTypedArray,
    },
    MASK_VOLUME_ID,
  );
  segmentation.addSegmentations([
    {
      segmentationId: SEGMENTATION_ID,
      representation: {
        type: ToolEnums.SegmentationRepresentations.Labelmap,
        data: { volumeId: MASK_VOLUME_ID },
      },
    },
  ]);
  const map: Record<string, { segmentationId: string }[]> = {};
  for (const id of ORTHO_IDS) map[id] = [{ segmentationId: SEGMENTATION_ID }];
  map[VOLUME3D_ID] = [{ segmentationId: SEGMENTATION_ID }];
  segmentation.addLabelmapRepresentationToViewportMap(map);
  segmentation.segmentIndex.setActiveSegmentIndex(SEGMENTATION_ID, 1);
}
