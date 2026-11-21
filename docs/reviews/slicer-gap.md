# 3D Slicer gap review

Council of two: a practising radiologist (role in `.claude/agents/radiologist.md`) and a product analyst who knows 3D Slicer. Date: 2026-11-19. Scope: Slicer's non-AI segmentation and viewing workflow, plus ITK-SNAP where it is better for manual work, compared with W Annotator as it is in the source today.

Slicer pages read today: [Segment Editor][SE], [Segmentations][SG], [Segment Statistics][ST], [Markups][MK], [Volumes][VO], [User interface: slice view controls, shortcuts, window/level][UI], [Volume Rendering][VR], [Crop Volume][CV], [Sequences][SQ], [Data][DA], [DICOM][DC], [Data loading and saving][IO], [Screen Capture][SC], [Transforms][TR]. ITK-SNAP: [RSNA manual-segmentation handout][IS1], [Kitware feature note][IS2].

Not confirmed from the pages (prior knowledge of the Slicer application, not its docs): Paint "pixel mode", "brush size relative to view", "colour smudge" and "edit in 3D views"; thick-slab reconstruction in slice views; the fact that Slicer has no autosave. Treat those cells as likely, not verified.

[SE]: https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html
[SG]: https://slicer.readthedocs.io/en/latest/user_guide/modules/segmentations.html
[ST]: https://slicer.readthedocs.io/en/latest/user_guide/modules/segmentstatistics.html
[MK]: https://slicer.readthedocs.io/en/latest/user_guide/modules/markups.html
[VO]: https://slicer.readthedocs.io/en/latest/user_guide/modules/volumes.html
[UI]: https://slicer.readthedocs.io/en/latest/user_guide/user_interface.html
[VR]: https://slicer.readthedocs.io/en/latest/user_guide/modules/volumerendering.html
[CV]: https://slicer.readthedocs.io/en/latest/user_guide/modules/cropvolume.html
[SQ]: https://slicer.readthedocs.io/en/latest/user_guide/modules/sequences.html
[DA]: https://slicer.readthedocs.io/en/latest/user_guide/modules/data.html
[DC]: https://slicer.readthedocs.io/en/latest/user_guide/modules/dicom.html
[IO]: https://slicer.readthedocs.io/en/latest/user_guide/data_loading_and_saving.html
[SC]: https://slicer.readthedocs.io/en/latest/user_guide/modules/screencapture.html
[TR]: https://slicer.readthedocs.io/en/latest/user_guide/modules/transforms.html
[IS1]: https://www.itksnap.org/pmwiki/uploads/Train/RSNA2016-Handout-Exercises.pdf
[IS2]: https://www.kitware.com/new-itk-snap-features-improve-segmentation/

## 1. Have and Coming

| Slicer capability | Status | Note |
|---|---|---|
| Paint, Erase; circle and sphere brush; size in mm ([SE]) | Have | Diameter in mm, `[` `]`, Shift-drag erases. |
| Editable intensity range while painting ([SE]) | Have (brush only) | The threshold brush. Other tools ignore the range; see 2.1. |
| Scissors: rectangle, circle, free-form; erase or fill inside or outside; this slice or all slices ([SE]) | Have | Plus a sphere. Depth in ± mm is not built; see 2.1. |
| Islands "add selected island" (click a hole) ([SE]) | Have | The Fill tool, one slice. |
| Islands: remove clicked, keep clicked, split to segments ([SE]) | Have | Fill tool actions "Remove island" and "Keep island"; "Split into separate segments" in the row menu. |
| Fill between slices, with preview ([SE]) | Have | Striped preview, then Apply (Enter) or Cancel (Esc). Nothing reaches the mask, undo or a room before Apply. |
| Editable area: inside one segment ([SE] masking) | Have | "Paint over: Only <segment>" for the brush, threshold brush, scissors fill, Fill and Fill between slices. |
| Pick the segment under the cursor | Have | Alt-click on a slice view, with any tool. |
| Interpolation toggle ([UI], [VO]) | Have | "Smooth pixels" in the menu on a view's name. |
| Brush down to one voxel | Have | The size control starts at the smallest diameter that paints a voxel of the open image. |
| Undo and redo ([SE]: last 10 states) | Have, better | 100 steps, and safe against other people's edits in a room. |
| Segment table: add, rename, colour, show, hide, clear, delete ([SE]) | Have | Plus "Show only this" and a lock per segment, which Slicer lacks. |
| Segmentation opacity, outline display ([SG]) | Have | One opacity slider, `O` outline only, `X` hide. |
| 3D view of segments; image volume rendering ([SE], [VR]) | Have (basic) | Flat silhouette is an open iter1 issue; see 2.2. |
| Four-up layout, double-click to maximise ([UI]) | Have | |
| Crosshair, pan, zoom, reset field of view ([UI]) | Have | Fit button; scroll, Ctrl+scroll, middle-drag, right-drag W/L with any tool. |
| Window/level drag, presets, auto reset ([UI], [VO]) | Have | 8 CT presets, W and L numbers, Reset. |
| Line measurement ([MK]) | Have | Ruler, in mm. |
| Orientation letters, value and position read-out ([UI]) | Have | Also the segment under the cursor in the status bar. |
| Space toggles the last two effects; next/previous segment keys ([SE]) | Have | `Space`, `,` `.`, and every key can be rebound. |
| Labelmap in NIfTI, NRRD, MHA; `.seg.nrrd` names ([IO]) | Have | Names also kept in NIfTI and MHA, which Slicer does not do. |
| Mask on another grid resampled to the image ([SE] geometry) | Have | With a plain warning. |
| Unsaved-changes guard ([IO]) | Have | Autosave is missing; see 2.3. |
| Margin (grow/shrink) ([SE]) | Coming | |
| Smoothing ([SE]) | Coming | Median and closing are enough. See 2.1 for Gaussian and joint. |
| Islands: keep largest, remove small ([SE]) | Coming | Click-to-remove and split are missing; see 2.1. |
| Fill holes (Smoothing: closing in Slicer) | Coming | |
| Logical operators: copy, add, subtract, intersect ([SE]) | Coming | |
| Segment Statistics: volume, mean, min, max, SD, CSV ([ST]) | Coming | Shape statistics (Feret, roundness, moments) are not needed. |
| "Modify other segments" / paint over empty only ([SE]) | Coming | "Inside one segment" is missing; see 2.1. |
| Jump to segment ([SE] table) | Coming | |
| Compressed DICOM, DICOM SEG read and write ([DC]) | Coming | |
| Themes, problem reporting | Coming | Slicer has themes; no in-app report. |

## 2. Missing

Effort: S = under 2 days, M = up to a week, L = more. "Where" is the one-sentence placement in this app.

### 2.1 Editing

| Item | In Slicer | Who needs it, how often | Where here | Effort and risk | Verdict |
|---|---|---|---|---|---|
| Free-form outline: Draw, and Scissors free-form | [SE] Draw fills a clicked or dragged contour; Scissors has a free-form shape. ITK-SNAP's polygon tool is the same idea ([IS1]). | Every case. Trimming a model's liver mask off the heart or kidney is one lasso stroke and twenty brush strokes. The radiologist's most used Slicer tool after Paint. | A third shape, "Freehand", in the Scissors strip. | M. Polygon rasterising must follow the voxel-centre rule on anisotropic and oblique grids. | **Have** (was Must). |
| Scissors: erase outside, and cut depth | [SE] Scissors: erase/fill inside or outside; slice cut "unlimited", "symmetric" (± mm), positive, negative. | Weekly. Removing a mask that leaks into the table or the opposite lung through the whole stack; cropping to the organ. | Action gains "Erase outside"; a "Depth" choice (This slice, All slices, ± mm) in the same strip. | S on top of free-form. One slip destroys many slices, so one undo step and an Undo toast. | **Have** (was Must): Erase outside, and This slice / All slices. The ± mm depth is not built. |
| Editable area: inside one segment | [SE] Masking, "Editable area". ITK-SNAP "paint over" one label ([IS1]). | Often in oncology and lobar work: paint tumour only inside liver, split a lung mask into lobes, without crossing the organ border. | Extends the coming overwrite choice: "Paint over: Everything, Empty only, Only <segment>". | S to M. A silent restriction confuses, so the active mode must show in the strip. | **Have** (was Should). |
| Intensity range for every tool; "use for masking" | [SE] "Editable intensity range", set from Threshold; key `i`. | Occasional. Mostly bone and lung on CT. | A "Range" toggle on Scissors and Fill that reuses the threshold brush limits. | S. | **Nice.** The threshold brush covers most of it. |
| Threshold a whole segment, with preview and histogram | [SE] Threshold; histogram in [VO]. | Rare in correction; it is how masks are started. A visible preview of the range is the useful part. | Flash in-range voxels in the view while the range slider moves. | M. | **Nice.** Preview yes, histogram no. |
| Pick the segment under the cursor | Paint "colour smudge" (not in the doc page). | Constantly on masks with 20 to 100 labels (whole-body organ sets): nobody finds "rib 7 left" in a list. | Alt-click on the image with any edit tool; no new control. | S. The status bar already knows the segment. | **Have** (was Must). |
| Islands: remove clicked, keep clicked | [SE] Islands "remove selected island", "keep selected island". | Daily on model output: three stray blobs, click each. Safer than "remove small", which can delete a real small lesion. | Two more actions in the Fill tool strip: Fill area, Remove island, Keep island. | S to M, reusing the coming islands code. 3D flood fill on 512³ needs a worker. | **Have** (was Should). Runs on the main thread behind the busy indicator, like the other island operations; no worker yet. |
| Islands: split to segments | [SE] Islands "split islands to segments". | Monthly. Turning one "metastases" mask into one segment per lesion for per-lesion volumes. | Segment row menu, "Split into separate segments". | S to M. Can create hundreds of segments; cap and confirm. | **Have** (was Should, later). At most 20 new segments at a time; asks first above 5. |
| Fill between slices: preview, then apply | [SE] Initialize, Update, Apply, Cancel. | Every use. The radiologist wants to look at the middle slices before they become data; the result is often wrong where the shape branches. | Preview in the strip of the brush: "Apply (Enter) / Cancel (Esc)". | M. Preview must not reach the room until applied. | **Have** (was Must). |
| Grow from seeds | [SE] GrowCut with preview. | Creation, not correction. | None. | L, heavy and hard to predict. | **Skip.** Outside the product; close to the no-AI line. |
| Level tracing | [SE] Outline follows equal intensity. | Rare; the threshold brush and Fill do the job. | None. | M. | **Skip.** |
| Smoothing: Gaussian, joint, smoothing brush | [SE] Five methods; drag to smooth locally. | Gaussian shrinks the segment, which changes volumes. Joint matters only for touching multi-label atlases. | Joint as an option of the coming Smoothing, later. | M. | **Skip** Gaussian. **Nice**: joint. |
| Hollow | [SE] Shell of a set thickness. | 3D printing and vessel walls; not mask correction. | None. | S. | **Skip.** |
| Pixel mode; brush size relative to view | Paint options (not in the doc page). | Pixel mode: thin structures on thick-slice CT. Relative size: nobody in measurement work; mm is honest. | Let the mm size go down to one voxel; no new mode. | S. | **Have** for one voxel (was Nice). **Skip** relative size. |
| Brush size on Shift + wheel | [SE] Paint. | Constant in Slicer hands. | No control; a mouse binding. | S. Shift is also the erase modifier; only the wheel is new. | **Nice.** |
| Allow overlap, overwrite visible only | [SE] "Modify other segments"; layers. | Rare (vessel inside tumour). | None. | L. Breaks the one-label-per-voxel model, NIfTI export and room sync. | **Skip.** Lock covers the protect case. |
| Paint and cut in the 3D view | [SE] Scissors work in 3D. | Occasional: cut the rib cage away in one stroke. | Scissors could work in the 3D view. | L. Easy to cut what you cannot see. | **Skip** for now. |
| Mask volume, specify geometry, finer mask grid | [SE]. | Preprocessing. | None. | M. | **Skip.** |

### 2.2 Viewing and review

| Item | In Slicer | Who needs it, how often | Where here | Effort and risk | Verdict |
|---|---|---|---|---|---|
| Interpolation toggle | [UI] slice controls; [VO] "Interpolate". | Whenever a border is judged at voxel level. Smoothed pixels hide which voxel the mask really covers. | A "Smooth pixels" switch in a small view menu on the viewport label. | S. | **Have** (was Should). |
| Auto window/level from a region | [UI] Ctrl-drag a box; Ctrl-double-click resets. | MR daily: units are arbitrary and one preset never fits. | Ctrl-drag a box while the Window/Level tool is active. | S. | **Nice.** Right-drag W/L already works everywhere. |
| Custom presets, preset keys | [VO] presets. | Sites with their own windows. | "Save current as preset" at the end of the preset list. | S. | **Nice.** Add Mediastinum (W 350, L 50 is close to Abdomen) only if asked. |
| Slab / MIP thickness | Slice view thick slab (not in the doc pages). | Lung nodule against vessel, small vessels, airways with MinIP. Weekly in chest work. | A "Slab" number in the view menu; painting is disabled while a slab is on. | M. Painting on a slab is ambiguous, so view only. | **Should**, later. |
| Second image: switch, then blend | [UI] foreground/background selectors, opacity; keys `[` `]`, `t`. | Brain tumour (T1c with FLAIR), prostate (T2 with ADC), PET/CT. In those fields, every case. | The file name button lists open images; one key cycles them; a blend slider only when two are open. | L. Different grids need resampling for display; rooms must send or name the extra image. | **Should**, later. Switching first, blending second. |
| Shaded 3D surface with smoothing | [SE] Show 3D, smoothing factor 0 to 1. | Each case, at the end: steps between slices, holes and stray pieces show at once in 3D. | The existing 3D view; no control beyond a "Smooth" switch. | M to L. Surface extraction per edit must not stall painting. | **Should**, later. An open iter1 item. |
| Segment status: not started, in progress, completed, flagged | [SE] segment table. | Review of many-label masks and rooms: the reviewer flags, the annotator fixes. | A small status dot on the segment row, set from the row menu; saved with the mask. | M. Needs a place in each file format. | **Should**, later. The cheapest review workflow. |
| Label set from a file | [SG] colour table import; [IO] reads ITK-SNAP label files. ITK-SNAP label descriptions ([IS1]). | Any team project: a NIfTI mask arrives as numbers 1 to 117 with no names. | File menu, "Load segment names…", accepting ITK-SNAP `.txt`, Slicer `.ctbl` and JSON. | S to M. | **Should**, later (first in the later list). |
| Standard terminology | [SE] colour swatch. | Only DICOM SEG needs codes. | None; DICOM SEG writes a generic code and the name. | M. | **Skip** the picker. |
| Per-segment opacity; separate 2D fill, outline and 3D opacity | [SG] display. | Rare. Hide, show-only and outline answer the real question, "what is under the mask". | None. "Fill with outline" could be a third state of `O`. | S. | **Skip** per segment. **Nice**: fill with outline. |
| Angle, curve, plane, ROI markups | [MK]. | Angles: orthopaedics, not mask work. An ROI mean value helps decide tumour against necrosis, but the cursor read-out mostly does. | None now. | M. | **Skip** angle, curve, plane. **Nice**: ellipse ROI mean. |
| Point list as review notes | [MK] point list. | Review: "under-segmented here". | Better as a comment pin in rooms than as a markup. | M. | **Nice**, with rooms. |
| Measurement export | [MK] table export. | Rare. | A "Copy" button next to "Clear all" in the Ruler strip. | S. | **Nice.** |
| Layouts: 3-over-3, single, compare | [UI] layout menu. | Maximise covers single. More layouts matter only with several images. | The Grid / Focus / Single switch already in the design spec. | S. | **Nice.** Only the three in the spec. |
| Link zoom and pan between views | [UI] view link. | Rare with one image. | None. | S. | **Skip** until two images exist. |
| Shift + move crosshair | [UI]. | Slicer habit. | A binding only. | S. Clashes with Shift-drag erase. | **Skip.** Crosshair click works. |
| Flip, rotate, reformat views; rotate to volume plane | [UI] reformat, "rotate to volume plane". | Flip and free rotate: never, they invite left/right errors. Acquisition-plane view matters on oblique MR (knee, heart). | No flip. Later, open oblique volumes on their own planes by default. | L. | **Skip** flip and rotate. **Should**, later: acquisition planes (open iter1 item). |
| Scale ruler in the view, orientation figure | [UI]. | Letters are enough. A scale bar helps choose a brush size. | A 1 cm tick bar in a viewport corner. | S. | **Nice.** |
| Volume rendering presets, shift, crop box | [VR]. | Not for mask work. | None. | M. | **Skip.** |
| Crop and resample volume | [CV]. | Preprocessing. | None. | M. | **Skip.** |
| Transforms and registration display | [TR]. | Registration belongs upstream. | None. | L. | **Skip.** |
| Sequences / 4D | [SQ]. | Cardiac cine and perfusion groups only. | None. | L. | **Skip.** |
| Screen capture | [SC]. | Reports, teaching, bug reports. | View menu, "Copy view as image". | S. | **Nice.** |

### 2.3 Files and application

| Item | In Slicer | Who needs it, how often | Where here | Effort and risk | Verdict |
|---|---|---|---|---|---|
| Autosave and crash recovery | None (not in [IO]); a well-known Slicer complaint. | Everyone, on the worst day. Losing an hour of contouring ends trust in a tool. | Silent; a "Restore unsaved work?" bar on the next start. | M. Recovery files hold patient data and must stay local. | **Must.** Listed as missing in iter1. |
| Scene save and restore (`.mrb`) | [IO], [DA]. | Not needed with one image and one mask. | None. Remember window, slice and zoom per file at most. | M. | **Skip.** |
| DICOM database and browser, networking | [DC]. | PACS users have a PACS. | A plain series list only when a folder holds several series. | S for the list. | **Skip** the database. **Nice**: series list. |
| RTSTRUCT import | SlicerRT extension ([IO]). | Radiotherapy groups only, but for them it is the only source of masks. | "Open mask" accepts it and converts to a labelmap. | M to L. Contour-to-voxel conversion changes volumes slightly; say so. | **Nice.** |
| Surface export: STL, OBJ | [SG] export to files. | 3D printing and simulation, not mask correction. | Save dialog format list. | M. | **Skip** for now. |
| Colour table export with labelmap | [SG]. | Covered by names stored in the file. | None. | S. | **Skip.** |
| Python console, extensions | Slicer core. | Developers. | None. | L. | **Skip.** |

## 3. Build list: top 12 Missing items

### Next iteration

**1. Freehand scissors with erase outside and depth**
- Story: as an annotator I draw one loop around a wrong region and it is erased or filled, on this slice or through the stack.
- UI: Scissors strip. Shape: Rectangle, Circle, Freehand, Sphere. Action: Erase inside, Erase outside, Fill inside. Depth: This slice, All slices, ± mm (a number field shown only for ± mm). Depth is hidden for Sphere.
- Acceptance: the loop closes on release; the active segment only is changed; locked and hidden segments are never touched; depth in mm is correct on anisotropic spacing and in all three planes; one stroke is one undo step; a stroke that changes more than one slice shows a toast with the voxel count and Undo; Esc while dragging cancels.
- Edge cases: fewer than three points (no change); self-crossing loop (even-odd rule); release outside the viewport; oblique volume; "Erase outside" with "All slices" on a large mask (must finish under about 0.5 s on 512³ or show progress); room peers get one patch.
- Tests: unit tests for the rasteriser (concave, self-crossing, voxel-centre rule) and for depth extents with 0.7 × 0.7 × 5 mm spacing; e2e that draws a loop and checks pixels, undo and a second room member.

**2. Fill between slices: preview, then apply**
- Story: as a radiologist I see the proposed in-between slices before they change the mask.
- UI: `I` or the button shows the result as a lighter, striped overlay in the segment colour; the strip reads "Preview · Apply (Enter) · Cancel (Esc)". Scrolling, zoom and W/L work during the preview.
- Acceptance: nothing is written to the mask, the undo stack or the room before Apply; Apply is one undo step; choosing an edit tool or another segment cancels with a short toast; the plane used is named in the strip.
- Edge cases: nothing to fill (keep today's hint); a room member edits the same segment during the preview (recompute on Apply); locked or hidden segment; closing or saving during a preview (cancel first).
- Tests: unit test that preview leaves the mask bytes unchanged; e2e for Enter and Esc paths and for a peer seeing nothing until Apply.

**3. Autosave and crash recovery**
- Story: after a crash or power cut I get my unsaved mask back.
- UI: none while working. On next start, or on opening the same image, a bar: "Unsaved work from 14:32 was found. Restore / Discard".
- Acceptance: when the mask is dirty, a recovery copy is written at most every 60 s and never during a stroke; the write is atomic (temporary file, then rename) and off the UI thread; the user's own file is never overwritten; Save and a clean close delete the copy; the copy stays in the app data folder, is never sent to a room, and its file name contains no patient or file name.
- Edge cases: disk full (one quiet warning, keep working); very large masks (compressed); two windows; recovery older than the saved mask (say so and default to Discard); mask received from a room.
- Tests: Rust test for the atomic write and clean-up; unit test for the schedule; e2e that edits, kills the app, reopens and restores an identical mask.

**4. Pick the segment under the cursor**
- Story: on a mask with many labels I Alt-click a structure and it becomes the active segment.
- UI: no new control. Alt-click with any tool; the list scrolls to the row and the row flashes once. Listed in the shortcut sheet.
- Acceptance: works in all three planes; hidden segments are ignored; background does nothing; a locked segment is selected and still shows as locked; no mask change and no undo step.
- Edge cases: Alt-click during a stroke (ignored); outline-only display (uses the voxel, not the drawn line); more than nine segments.
- Tests: unit test for the lookup; e2e that Alt-clicks two segments and checks the active chip.

**5. Paint only inside one segment**
- Story: I paint tumour inside the liver and the stroke cannot leave the liver.
- UI: the coming overwrite choice becomes "Paint over: Everything, Empty only, Only <segment>" in the strip of Brush, Threshold brush, Scissors (fill) and Fill. The strip chip shows the limit, for example "Tumour, inside Liver".
- Acceptance: applies to every tool that adds voxels and to Fill between slices; locked segments are never overwritten in any mode; erasing is not limited; the choice is per person in a room; default is Everything on each launch.
- Edge cases: the chosen segment is deleted or becomes the active one (back to Everything, with a toast); a stroke that changes nothing because of the limit shows a hint once.
- Tests: unit tests for the three modes against each tool's write path; e2e painting across a border and checking no voxel outside changed.

**6. Remove or keep the clicked island**
- Story: I click a stray blob and it is gone; or I click the real organ and everything else of that segment is gone.
- UI: Fill strip gains Action: Fill area, Remove island, Keep island. Islands are connected in 3D through voxel faces, as in Slicer.
- Acceptance: acts on the active segment only; one undo step; a toast gives the removed volume in mL with Undo; clicking background or another segment does nothing.
- Edge cases: an island of millions of voxels (worker, no freeze); locked or hidden segment; "Keep island" when there is only one; room patch size.
- Tests: unit tests for 6-connectivity on a phantom with face-, edge- and corner-touching blobs; e2e for both actions and undo.

### Later, in order

7. Label set from a file (ITK-SNAP `.txt`, Slicer `.ctbl`, JSON) so numbered masks get names and colours.
8. "Smooth pixels" switch (interpolation toggle) in a per-view menu.
9. Segment status (in progress, completed, flagged) saved with the mask; the light review flow for rooms.
10. Second image: cycle between co-registered images with one key, then a blend slider.
11. Shaded, optionally smoothed 3D surface in place of the flat silhouette.
12. Slab / MIP thickness for viewing, with editing off while it is on.

Next after these: split islands to segments, region auto window/level, acquisition-plane views for oblique volumes, RTSTRUCT import.

## 4. Do not copy from Slicer

- **Modules and a 20-effect grid with an Apply button each.** It is why new users are lost. Bulk operations stay in the segment row menu; click tools stay in one strip.
- **Overlapping segments and layers.** One label per voxel keeps NIfTI export, room sync and statistics unambiguous.
- **View flip, free rotation and the reformat widget.** Each is a left/right error waiting to happen. Fixed radiological display with letters is a safety feature.
- **Scene files, the data tree and the DICOM database.** One image and one mask need Open and Save, nothing more.
- **Brush size relative to the view.** A brush in mm means the same at every zoom and on every dataset.
- **Ten undo states and previews that vanish when the effect changes.** Keep 100 steps and explicit Apply / Cancel.
- **Grow from seeds, level tracing, hollow, Gaussian smoothing.** Hard to predict, or they change volumes without saying so.
- **Terminology dialogs, transfer-function editors, transforms, Python console.** Expert surface with no value for correction.
- **Digits select tools.** Here digits select segments, which is the more frequent action.

## 5. Better than Slicer today; protect these

- Realtime rooms with per-person undo that never removes someone else's voxels. Slicer has nothing like it.
- A lock per segment, respected by every tool. Slicer needs masking rules for the same result.
- One strip that shows only the active tool's options; the image keeps the screen.
- PACS mouse habits with any tool: scroll for slices, right-drag for window/level, middle-drag to pan. No tool switch to look around.
- Shift-drag to erase, `1` to `9` for segments, `X` and `O` to see under the mask: the correction loop needs no trip to a panel.
- Open an image and a mask in different formats and on different grids, and be told plainly when the mask was resampled.
- Segment names survive in NIfTI and MHA, not only in `.seg.nrrd`.
- 100 undo steps; every bulk action answers with an Undo toast.
- Time from launch to first brush stroke: seconds, with no module to find.

Every item added from section 3 must keep these intact: no new rail button in the next iteration, and no control visible unless its tool is active.
