# Feature landscape: manual segmentation annotators

Researched 2026-11-19. Scope: manual (non-AI) segmentation, viewing and review features of RedBrick AI, MD.ai, OHIF Viewer (v3.10-3.12 segmentation mode), 3D Slicer Segment Editor, ITK-SNAP 3/4, V7 Darwin (medical), Encord (DICOM/NIfTI editor) and Cornerstone3D (the engine W Annotator builds on). AI tools (SAM/FAST, Labelmap Assist, Auto-Annotate, MD.ai Auto Segmentation, etc.) are deliberately left out.

Legend: **Y** = yes, **P** = partial / limited, **-** = no, **?** = not confirmed from docs during this research (treat as unknown). The Cornerstone3D column means "available as a library building block", not a finished UI.

## 1. Feature matrix

### File formats

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| DICOM | Y | Y | Y | Y | Y | Y | Y | Y (dicom-image-loader) |
| NIfTI (.nii/.nii.gz) | Y | ? | P (experimental) | Y (NIfTI-1 only) | Y | Y | Y | Y (nifti-volume-loader) |
| NRRD | Y | - | - | Y (native format) | Y | - | - | - (needs itk-wasm or own loader) |
| MHA / MHD | Y | - | - | Y | Y | - | - | - (needs itk-wasm or own loader) |
| Mask import | NIfTI, RTSTRUCT, MHD | JSON (SDK) | DICOM SEG, RTSTRUCT | .seg.nrrd, NRRD, NIfTI, DICOM SEG | NIfTI, NRRD, MHA and more | NIfTI (semantic only) | JSON / SDK | DICOM SEG, RTSS via adapters |

### Mask editing tools

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| Brush (2D circle) | Y | Y | Y | Y | Y (round/square) | Y | Y | Y `BrushTool` FILL_INSIDE_CIRCLE |
| Eraser | Y (right-drag) | Y | Y | Y | Y (right-drag) | Y | Y | Y ERASE_INSIDE_CIRCLE/SPHERE |
| Sphere / 3D brush | Y | - | Y | Y (sphere mode) | Y (3D toggle) | Y (sphere, cube) | P (cylinder, N slices) | Y FILL_INSIDE_SPHERE |
| Threshold brush (paint only in intensity range) | Y ("Masking": restrict by intensity) | Y (HU range + preview) | Y (range or dynamic) | Y (editable intensity range) | P (adaptive brush) | Y (3D threshold brush) | Y (threshold + eyedropper) | Y THRESHOLD_INSIDE_CIRCLE/SPHERE, dynamic |
| Scissors (rect/circle/freeform cut or fill) | Y (3D scissors in 3D view) | - | Y (rect, circle, sphere shapes) | Y (2D + 3D, slice-cut depth) | P (3D scalpel) | - | P (rectangle, new editor) | Y Rectangle/Circle/SphereScissors |
| Lasso / freehand / polygon to mask | Y (Pen, Contour) | Y (freeform, polygon) | Y (labelmap edit with contour, 3.12) | Y (Draw) | Y (Polygon tool) | Y (polygon to mask) | Y (bitmask polygon mode) | Y (contour tools, LabelMapEditWithContour) |
| Flood fill / paint bucket | Y | - | ? | P (Islands: add selected island) | - | - | - | Y `PaintFillTool` |
| Fill holes | Y (2D/3D hole filling) | - | P (contours only) | P (Smoothing: closing) | - | - | - | P (utilities) |
| Interpolation between slices | Y (contour based) | Y (anchor frames) | Y (labelmap, morphological, any axis) | Y (Fill between slices) | Y (Interpolate Labels) | P (polygons; not masks) | Y | Y `@cornerstonejs/labelmap-interpolation` (itk-wasm, web worker) |
| Grow / shrink (margin) | - | - | - | Y (Margin, Hollow) | - | - | - | - (implement ourselves) |
| Islands (remove / keep largest / split) | Y (click to remove, keep selected) | - | P (contours: remove small islands) | Y (6 modes) | - | - | - | Y (`IslandRemoval` utility) |
| Smoothing | P | P (freeform only) | P (contours only) | Y (median, open, close, gaussian, joint) | ? | - | - | P (contour smoothing only) |
| Logical ops (copy, add, subtract, intersect) | Y (copy, add, subtract, merge) | - | P (contours: join/intersect/subtract, 3.12) | Y | - | P (merge mask instances) | - | P (contour logical ops) |
| Overlap policy (overwrite / allow overlap / protect) | Y | - | P | Y (overwrite all / visible / allow overlap) | Y (draw-over label modes) | - (one identity per pixel) | Y (panoptic none/exclude/overwrite) | Y (segment locking, overlap layers) |
| Preview then accept/reject | - | - | Y (Enter / Esc) | Y (Threshold, Grow from seeds) | - | - | Y (Enter applies bitmask) | Y (brush preview) |

### Segment management

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| Add / delete segment | Y | Y | Y | Y | Y | Y | Y | Y |
| Rename | P (fixed by project taxonomy) | P (project labels) | Y | Y | Y | P (classes) | P (ontology) | Y (label) |
| Colour | Y | Y | Y | Y (+ standard terminology) | Y | Y | Y | Y (colour LUT) |
| Lock | Y (`U`, `Shift+U` all; read-only labels) | - | Y | P (via masking rules) | P (draw-over modes) | ? | Y ("cannot be drawn over") | Y `segmentLocking` |
| Visibility per segment / all | Y (`H`, `Shift+H`) | Y | Y | Y | Y (`S` toggles all) | Y | Y | Y |
| Opacity | Y | Y | Y (fill, outline, inactive) | Y | Y (`A` / `D`) | Y | Y | Y (fillAlpha) |
| Outline / fill display modes | Y (label outlines) | ? | Y (fill+outline, outline, fill) | Y | P | ? | ? | Y (renderFill, renderOutline, outlineWidth) |
| Jump to segment | Y | Y (next/prev annotated image) | Y | Y | - | Y | Y | Y (centre utilities) |
| Segment status flag | - | - | - | Y (not started / in progress / completed / flagged) | - | - | - | - |
| Per-segment statistics (volume etc.) | Y | P | Y (auto-updated, web worker) | Y (Segment Statistics) | Y (Volumes & Statistics) | P | P | Y (labelmap statistics) |

### Viewing

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| MPR (axial/sagittal/coronal) | Y | ? | Y | Y | Y (always on) | Y | Y | Y (volume viewports) |
| Oblique MPR | Y | - | Y (crosshair rotate) | Y | - | Y | Y | Y |
| 3D render of segments | Y | - | Y | Y (surface, Show 3D) | Y (mesh) | Y | Y | Y (surface repr. via polySeg; VolumeViewport3D) |
| MIP / slab | Y | ? | Y | Y | - | ? | ? | Y (slab thickness, blend modes) |
| W/L drag + presets | Y (custom presets + hotkeys) | Y (`Alt+1..9` CT presets) | Y (`1..9`) | Y | P (auto-contrast, curve editor) | Y (custom presets + hotkeys) | Y (custom W/L) | Y |
| Crosshairs linking views | Y | P (point to same location) | Y | Y (`Shift` + move) | Y (core interaction) | Y (`R`, rotatable) | Y (rotatable) | Y `CrosshairsTool` |
| Viewport sync (scroll/zoom/VOI) | Y | P | Y | Y (linked views) | Y (also across app windows) | P | P | Y (synchronizers) |

### Measurements, history, shortcuts

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| Length / angle / ROI measurements | Y | Y | Y (full set) | Y (Markups) | P (ruler annotation) | P (label measurements) | P (length) | Y (Length, Angle, Bidirectional, ROI tools) |
| Undo / redo for mask edits | Y | Y (per active annotation) | Y (3.10+) | Y (default last 10 states) | Y | Y | Y | Y (`HistoryMemo`) |
| Keyboard shortcuts | Y, user remappable | Y (`?` sheet) | Y, remappable (session) | Y | Y | Y | Y (`Ctrl+Shift+K` sheet) | n/a (app concern) |
| Command palette | Y (`Ctrl/Cmd+K`) | - | - | P (module finder) | - | - | - | n/a |

### Collaboration and review

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| Realtime co-editing of the same mask | - | ? | - | - | - | - | - | - |
| Review stages (accept / reject back to labeler) | Y | P (roles) | - | - | - | Y | Y | - |
| Comments pinned to the image | Y (comment pins, exportable) | P (notes per annotation) | - | - | - | Y | Y (issues) | - |
| Multi-reader / consensus | Y (blind readers, agreement score, best-annotator or manual merge) | Y | - | - | - | Y | Y | - |
| Read-only reference labels | Y | ? | - | - | - | ? | ? | Y (locking) |

None of the cloud platforms documents true simultaneous editing of one mask; they are stage-based (label, then review). Realtime rooms are a real differentiator for W Annotator.

### Export formats

| | RedBrick | MD.ai | OHIF | 3D Slicer | ITK-SNAP | V7 | Encord | Cornerstone3D |
|---|---|---|---|---|---|---|---|---|
| NIfTI labelmap | Y (default) | ? | - | Y | Y | Y (semantic; instances merged) | ? | - (write ourselves) |
| NRRD / .seg.nrrd | - | - | - | Y (keeps names, colours, overlap) | Y | - | - | - |
| MHA / MHD | Y (MHD) | - | - | Y | Y | - | - | - |
| DICOM SEG | - | ? | Y (incl. Labelmap SEG IOD, 3.11) | Y (extension) | - | - | ? | Y (adapters) |
| DICOM RTSTRUCT | Y | - | Y (RTSS, 3.12) | Y (SlicerRT) | - | - | - | Y (adapters) |
| JSON | Y (tasks.json) | Y | - | - | - | Y (Darwin JSON, RLE) | Y | - |
| Surface mesh (STL/OBJ) | - | - | - | Y | Y (STL, VTK) | - | - | P (polySeg surface data) |
| PNG slices | Y | - | - | - | - | - | - | - |

## 2. What high-end platforms do that users love

1. **Right-drag erases while the brush is active.** No tool switch for the most common correction. RedBrick ("left click + drag to segment, right click + drag to erase") and ITK-SNAP both do this. [RedBrick segmentation tools](https://app.redbrickai.com/docs/annotation-and-viewer/segmentation/segmentation-tools), [ITK-SNAP GUI tutorial](https://andysbrainbook.readthedocs.io/en/latest/ITK-Snap/ITK-Snap_Short_Course/ITK-Snap_02_GUI.html)
2. **Brush size without leaving the canvas.** Slicer: `Shift` + wheel, `+`/`-` in 20% steps. V7 / Encord: `[` and `]`. MD.ai: plain wheel while a mask is active. RedBrick: `W`/`S`. [Slicer Segment Editor](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html), [V7 radiology guide](https://docs.v7labs.com/docs/guide-to-radiology-labeling-in-v7), [MD.ai shortcuts](https://docs.md.ai/annotator/ui/keyboard-shortcuts/)
3. **Brush radius in millimetres, not pixels.** The brush means the same thing on any dataset and in any plane. Slicer and OHIF (0.5 mm steps) both do this. [OHIF segmentation toolbar source](https://github.com/OHIF/Viewers/blob/master/extensions/cornerstone/src/customizations/segmentationToolbarCustomization.ts)
4. **Number keys pick the label.** RedBrick shows the numeric hotkey next to each label in the sidebar; MD.ai uses `Mod+1..0` and shows the numbers while `Mod` is held. [RedBrick creating annotations](https://app.redbrickai.com/docs/annotation-and-viewer/creating-editing-and-deleting-annotations), [MD.ai shortcuts](https://docs.md.ai/annotator/ui/keyboard-shortcuts/)
5. **Two-handed editing.** Slicer designs shortcuts so one hand stays on the mouse: `Q`/`W` previous/next segment, `Space` toggles between the last two tools, `Esc` drops the tool. [Slicer Segment Editor](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html)
6. **Hover-aware visibility and lock keys.** RedBrick `H` hides the label under the cursor (or the selected one), `Shift+H` all; `U` / `Shift+U` lock. Quick peek under the mask is used constantly. [RedBrick creating annotations](https://app.redbrickai.com/docs/annotation-and-viewer/creating-editing-and-deleting-annotations)
7. **One-key overlay toggle and opacity.** ITK-SNAP `S` toggles the segmentation layer, `A`/`D` change its opacity. [ITK-SNAP 3 shortcuts](http://www.itksnap.org/pmwiki/uploads/Documentation/snap_shortcuts_v3.pdf)
8. **A clear overwrite policy.** Slicer "Modify other segments": overwrite all / overwrite visible / allow overlap, plus "Editable area". RedBrick copied this panel almost word for word; Encord has the same idea as panoptic modes. This prevents the most damaging class of accidental edits. [Slicer masking options](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html), [RedBrick masking](https://app.redbrickai.com/docs/annotation-and-viewer/visualization-and-masking)
9. **Intensity-restricted painting with a live preview.** Paint sloppily and only voxels inside the range are labelled. MD.ai "Threshold Preview", Encord threshold overlay + eyedropper, RedBrick range selector (left click includes, right click excludes), V7 `Ctrl+T` toggles it. [MD.ai annotation tools](https://docs.md.ai/annotator/ui/annotation-tools/), [Encord DICOM editor](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-dicom)
10. **Draw a few slices, interpolate the rest.** Slicer "Fill between slices", OHIF "Interpolate Labelmap" (works in any direction, runs in a worker), ITK-SNAP "Interpolate Labels", MD.ai anchor frames. Biggest non-AI time saver. [OHIF 3.10 release notes](https://ohif.org/release-notes/3p10/), [Cornerstone labelmap-interpolation](https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/labelmap-interpolation/README.md)
11. **Preview, then Enter to accept / Esc to reject** for anything that changes many voxels (interpolation, threshold). [OHIF 3.10 release notes](https://ohif.org/release-notes/3p10/), [Cornerstone interpolation example](https://www.cornerstonejs.org/live-examples/labelmapinterpolation)
12. **Click-to-fix clean-up tools.** RedBrick: click an island to remove it (or keep only the clicked one), click to fill holes, paint bucket for one big hole. Slicer Islands: keep largest, remove small, split to segments. [RedBrick segmentation tools](https://app.redbrickai.com/docs/annotation-and-viewer/segmentation/segmentation-tools)
13. **Snap all views to the cursor.** RedBrick `Z` snaps MPR views to the cursor (added to track the 3D brush), ITK-SNAP `C` centres views on the 3D cursor, V7 `R` crosshair jumps all views to a point. [RedBrick changelog](https://app.redbrickai.com/docs/changelogs/redbrick-changelog), [V7 DICOM/NIfTI guide](https://docs.v7labs.com/docs/annotate-dicom-nifti-files)
14. **Modifier-drag navigation that never needs a tool switch.** RedBrick: `Ctrl`+left-drag W/L, `Shift`+left-drag pan, `Ctrl`+wheel zoom, `Alt`+left-drag fast slice scroll. Slicer: `Ctrl`+wheel zoom, `Shift`+move to sync slices. [RedBrick viewer basics](https://app.redbrickai.com/docs/annotation-and-viewer/viewer-basics/home)
15. **Discoverability instead of clutter.** RedBrick command bar (`Ctrl/Cmd+K`) lists every function and shortcut; MD.ai `?` and Encord `Ctrl+Shift+K` open the shortcut sheet; RedBrick lets users remap every key. Rare functions live in the palette, not the toolbar. [RedBrick viewer basics](https://app.redbrickai.com/docs/annotation-and-viewer/viewer-basics/home), [Encord shortcuts](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-label-editor-settings-shortcuts)
16. **Segment state flags.** Slicer marks each segment not started / in progress / completed / flagged, with auto-transition on first edit. A cheap review workflow without server stages. [Slicer segments table](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html)
17. **Statistics that update as you paint.** OHIF recomputes volume and intensity stats per segment in a web worker. [OHIF 3.10 release notes](https://ohif.org/release-notes/3p10/)

## 3. Recommended scope (no AI features)

### MUST for v0.1

- Open volumes: NIfTI, NRRD, MHA/MHD, DICOM series. Open and save masks as `.nii.gz` with geometry matching the volume. (Cornerstone3D has no NRRD/MHA loader; plan for itk-wasm or a Rust-side reader in Tauri.)
- Layout: 2x2 MPR + 3D by default, double-click to maximise one view. Crosshairs linking the views.
- Navigation with no tool switch: wheel = slice, `Ctrl`+wheel zoom, middle-drag pan, `Ctrl`+left-drag W/L. A handful of CT W/L presets.
- Brush and eraser, circle and sphere, radius in mm, right-drag erases, `[` / `]` and `Shift`+wheel resize. Works in all three planes.
- Threshold-restricted painting (intensity range with preview) as a brush option, not a separate tool.
- Segment list: add, delete, rename, colour, visibility, lock, select by `1`-`9`. Global overlay opacity and fill/outline toggle.
- Overwrite policy: overwrite other segments (default) vs. protect locked segments.
- Undo / redo for every mask edit, including edits arriving in a room (per-user undo stack).
- Realtime rooms: shared mask edits, presence (who is here, cursors, active segment), per-segment lock respected for everyone.
- 3D view of segments (surface), rotate/zoom, updates after stroke end.
- Shortcut sheet (`?`) and autosave / unsaved-changes guard.

### SHOULD (v0.2 - v0.3)

- Interpolate between slices with preview, Enter/Esc (`@cornerstonejs/labelmap-interpolation`).
- Scissors (rectangle, circle, freeform) for cut/fill; lasso/polygon fill.
- Paint bucket / flood fill; fill holes (2D and 3D).
- Islands: remove clicked, keep largest, remove small.
- Per-segment statistics (volume in ml, voxel count, mean intensity).
- Length measurement; jump to segment; snap views to cursor.
- Comment pins anchored to a voxel, and Slicer-style segment status (in progress / done / flagged) as the lightweight review flow.
- Read-only reference mask overlay; follow-a-collaborator mode.
- Export: NRRD / `.seg.nrrd`, MHA, DICOM SEG. Import DICOM SEG.
- Command palette (`Ctrl/Cmd+K`), remappable shortcuts, custom W/L presets.
- MIP / slab thickness; viewport sync for a second volume.

### LATER

- Grow / shrink (margin), smoothing (median, open/close), hollow.
- Logical ops (copy, add, subtract, intersect), split islands to segments.
- Overlapping segments (multi-layer labelmaps).
- Contour workflow (spline, sculpt), RTSTRUCT import/export, STL/OBJ mesh export.
- Oblique MPR, multi-volume fusion, 4D series.
- Formal review stages (accept/reject), consensus / reader comparison, edit history and audit log.
- Segmentation of 2D images, hanging protocols.

### Keeping the UI simple

- One left toolbar with at most 6 tools in v0.1 (Navigate, Brush, Eraser, Crosshair, plus options inline). Tool options appear only for the active tool (ITK-SNAP "active tool inspector", RedBrick context panel).
- Sphere and threshold are toggles on the brush, not extra tools (OHIF and V7 both do this).
- Everything rare goes into the command palette or menus, never the toolbar.

## 4. Recommended default shortcut map

Principles: letters select tools, digits select segments, modifiers plus mouse navigate. `Ctrl` means `Cmd` on macOS. Where platforms disagree, the choice and its origin are noted.

### Mouse

| Action | Binding | Matches |
|---|---|---|
| Use active tool | Left-drag | all |
| Erase while Brush is active | Right-drag | RedBrick, ITK-SNAP |
| Scroll slices | Wheel | all |
| Zoom | `Ctrl` + wheel, or right-drag when no paint tool is active | Slicer, RedBrick / ITK-SNAP, OHIF |
| Pan | Middle-drag, or `Shift` + left-drag | ITK-SNAP, OHIF / RedBrick, Slicer |
| Window / level | `Ctrl` + left-drag | RedBrick |
| Brush size | `Shift` + wheel | Slicer |
| Fast slice scroll | `Alt` + left-drag | RedBrick |
| Maximise / restore viewport | Double-click | OHIF |

### Tools

| Key | Action | Matches |
|---|---|---|
| `Esc` | Navigate (drop tool) / cancel preview | Slicer, OHIF |
| `B` | Brush | MD.ai |
| `E` | Eraser | MD.ai, V7 |
| `Shift+B` | Toggle circle / sphere brush | V7 uses `Ctrl+R`; avoided (reload) |
| `T` | Toggle threshold-restricted painting | V7 `Ctrl+T`, Slicer `I`, Encord `J` |
| `R` | Crosshairs | V7 |
| `C` | Scissors (SHOULD) | new |
| `G` | Paint bucket / fill (SHOULD) | common paint-app convention |
| `M` | Measure length (SHOULD) | V7 `Ctrl+M`, Encord `Alt+M` |
| `Shift+I` | Interpolate between slices (SHOULD) | Encord |
| `Space` | Toggle between last two tools | Slicer |
| `Enter` | Accept preview | OHIF, Encord, Slicer |
| `[` / `]` | Brush smaller / larger | V7, Encord |
| `-` / `=` | Brush smaller / larger (alias) | Slicer, ITK-SNAP |

### Segments

| Key | Action | Matches |
|---|---|---|
| `1` - `9` | Select segment 1-9 | RedBrick (MD.ai `Mod+1..0`) |
| `Q` / `W` | Previous / next segment | Slicer |
| `,` / `.` | Previous / next segment (alias) | ITK-SNAP |
| `N` | New segment | new |
| `H` | Hide / show segment under cursor, else the selected one | RedBrick |
| `Shift+H` | Hide / show all segments | RedBrick (ITK-SNAP `S`) |
| `U` / `Shift+U` | Lock / unlock segment, all segments | RedBrick |
| `A` / `D` | Overlay opacity down / up | ITK-SNAP |
| `O` | Toggle fill / outline display | new |

### View and navigation

| Key | Action | Matches |
|---|---|---|
| `Up` / `Down` | Previous / next slice in hovered view | RedBrick, OHIF |
| `PgUp` / `PgDn` | Previous / next slice (alias) | ITK-SNAP |
| `Shift+Up` / `Shift+Down` | Jump 5 slices | ITK-SNAP |
| `Z` | Snap all views to cursor position | RedBrick (ITK-SNAP `C`) |
| `F` | Fit views to window | ITK-SNAP `Ctrl+F` |
| `Alt+1` - `Alt+9` | W/L presets | MD.ai (OHIF uses bare `1..9`) |
| `Alt+0` | Reset W/L | MD.ai |

### App

| Key | Action | Matches |
|---|---|---|
| `Ctrl+Z` | Undo | all |
| `Ctrl+Shift+Z`, `Ctrl+Y` | Redo | ITK-SNAP, MD.ai / OHIF |
| `Ctrl+O` | Open volume or mask | ITK-SNAP |
| `Ctrl+S` | Save mask | ITK-SNAP |
| `Ctrl+K` | Command palette (SHOULD) | RedBrick |
| `?` | Shortcut sheet | MD.ai |

### Known conflicts resolved

- Digits: Slicer and ITK-SNAP use them for tools, OHIF for W/L presets, RedBrick for labels. Segment selection is the most frequent action when editing multi-label masks, so digits go to segments; tools get letters; presets move to `Alt+digit`.
- `W` / `S`: RedBrick uses them for brush size, ITK-SNAP uses `S` for overlay toggle, Slicer uses `W` for next segment. Brush size goes to `[` `]` (most widespread), `Q`/`W` follow Slicer, `S` is left unbound in v0.1.
- `I`: Slicer uses it for intensity masking. Here `T` (threshold) is the mnemonic and `Shift+I` is interpolate.
- Slicer's bare `Z` / `Y` undo/redo is not adopted; `Z` is snap-to-cursor as in RedBrick.

## Sources and caveats

Primary sources read: [RedBrick segmentation tools](https://app.redbrickai.com/docs/annotation-and-viewer/segmentation/segmentation-tools), [RedBrick visualization and masking](https://app.redbrickai.com/docs/annotation-and-viewer/visualization-and-masking), [RedBrick annotations](https://app.redbrickai.com/docs/annotation-and-viewer/creating-editing-and-deleting-annotations), [RedBrick viewer basics](https://app.redbrickai.com/docs/annotation-and-viewer/viewer-basics/home), [RedBrick formats](https://app.redbrickai.com/docs/importing-data/uploading-data-to-redbrick), [RedBrick consensus](https://app.redbrickai.com/docs/project-pages/multiple-labeling/consensus/home), [MD.ai shortcuts](https://docs.md.ai/annotator/ui/keyboard-shortcuts/), [MD.ai annotation tools](https://docs.md.ai/annotator/ui/annotation-tools/), [MD.ai annotation](https://docs.md.ai/annotator/ui/annotation/), [OHIF 3.10](https://ohif.org/release-notes/3p10/), [OHIF 3.11](https://ohif.org/release-notes/3p11/), [OHIF 3.12](https://ohif.org/release-notes/3p12/), [OHIF segmentation tool groups](https://github.com/OHIF/Viewers/blob/master/modes/segmentation/src/initToolGroups.ts), [Slicer Segment Editor](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html), [Slicer data formats](https://slicer.readthedocs.io/en/latest/user_guide/data_loading_and_saving.html), [ITK-SNAP 3 shortcuts](http://www.itksnap.org/pmwiki/uploads/Documentation/snap_shortcuts_v3.pdf), [V7 multi-planar annotations](https://docs.v7labs.com/docs/multi-planar-annotations-in-v7), [V7 radiology guide](https://docs.v7labs.com/docs/guide-to-radiology-labeling-in-v7), [V7 masks](https://docs.v7labs.com/docs/introducing-masks), [Encord DICOM/NIfTI](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-dicom), [Encord shortcuts](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-label-editor-settings-shortcuts), [Cornerstone3D segmentation tools](https://www.cornerstonejs.org/docs/concepts/cornerstone-tools/segmentation/segmentation-tools/), [Cornerstone3D labelmap interpolation](https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/labelmap-interpolation/README.md), [Cornerstone3D undo/redo commit](https://github.com/cornerstonejs/cornerstone3D/commit/bfa93c5dc8677bd7d79b9b8e8eb5b50ad02cd144).

Caveats:

- Cells marked **?** could not be confirmed from the vendor docs in this pass. This mostly affects MD.ai (MPR, MIP, realtime collaboration, export formats beyond JSON), Encord and V7 export/lock details, and ITK-SNAP smoothing.
- The OHIF default hotkey file and the RedBrick full hotkey page could not be fetched; OHIF `1..9` W/L presets and `Ctrl+Y` redo, and several ITK-SNAP/Slicer capabilities not on the pages above (ITK-SNAP Interpolate Labels, 3D scalpel, mesh export; Slicer DICOM SEG/RTSTRUCT via extensions), are from prior knowledge rather than pages read today.
- Cloud platforms change monthly; re-check before quoting any cell externally.
