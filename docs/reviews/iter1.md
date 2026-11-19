# Review loop, iteration 1

Reviewers ran against a frozen build with Playwright. Each finding lists what was done about it.

## Radiologist — verdict before fixes: reject

| Finding | Status |
|---|---|
| A mask with the same size but another axis order was overlaid mirrored | Fixed. Any grid difference over a tenth of a voxel is resampled through world coordinates. e2e test added. |
| Another person's undo erased my voxels in a room | Fixed. Undo and redo only touch voxels that still hold the value the stroke left. Unit tests added. |
| File names were sent to the room | Fixed. The room only sees "Room image" and "Room mask". |
| Opacity, outline, hide mask and the eye did not repaint | Fixed. e2e pixel test added. |
| Crosshair click did not move the other views | Fixed. e2e test added. |
| CT opened on an unusable window; few presets | Fixed. CT-like data opens at W 400 L 40. Liver, Stroke and Subdural presets added. |
| Brush "size" was a radius | Fixed. The number is the diameter in mm. |
| No erase modifier | Fixed. Shift-drag erases with the brush. |
| Segment names lost in NIfTI and MHA | Fixed. Names are stored in a NIfTI header extension and an MHA header line. |
| A tool key after picking a preset changed the window | Fixed. |
| Arrow-up moved to the next slice | Fixed. |
| Orientation letters faint | Fixed. |
| Oblique volumes are edited on resliced planes | Open. Stated as a limitation. |
| 3D view is a flat silhouette | Open. |
| Slice number and Z read-out count in opposite directions | Open. |
| Errors in the console when opening a second image | Open. |
| Missing: volume per segment, grow/shrink, islands, autosave | Open. |

Confirmed correct: laterality and orientation letters for LPS and RAS input, aspect ratio on anisotropic voxels, ruler distances, value read-out, save and reopen.

## UX and motion — verdict before fixes: reject (one blocker)

| Finding | Status |
|---|---|
| Painting on a locked or hidden active segment edited it | Fixed. e2e test added. |
| Threshold strip overflowed below 1280 px | Fixed. |
| Segment menu clipped by the list | Fixed. |
| No focus ring on sliders and menu items | Fixed. |
| Modal focus order, no Done button | Fixed. |
| Control borders under 3:1 contrast | Fixed. |
| Close confirm had no Save | Fixed. |
| Row actions reserved space and truncated names | Fixed. |
| Copy: marketing heading, missing file name in errors, extra sentences | Fixed. |
| Reduced motion incomplete; rows animated on every load | Fixed. |
| Roving tab order in the rail and list; arrow keys in menus | Open. |
| Layout switcher, freehand scissors, fill scope from the spec | Open. |
