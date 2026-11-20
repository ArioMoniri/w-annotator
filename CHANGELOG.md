# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-20

### Added

- Trackpad support. A two-finger scroll moves through slices in proportion to how far the fingers move, and a pinch zooms about the pointer. Shift+scroll moves five slices at a time, and Alt+scroll changes the brush size while a brush tool is active. Scroll and pinch zoom the 3D view.
- Settings → Mouse and trackpad: scroll direction, trackpad scroll speed, whether a two-finger scroll changes slice or pans, pinch to zoom, mouse wheel zooms, and zoom speed.
- View layouts: 2 × 2, 1 large and 3 stacked, 3 side by side, 2 side by side and single, from the middle of the top bar or with Ctrl/⌘ 1–5. The layout is remembered.
- Any pane can show any view: click a pane's name to pick Axial, Sagittal, Coronal or 3D, or drag the name onto another pane to swap the two.
- Reference lines: each view shows where the other two cut it. Drag a line to scroll that view. Settings → Appearance chooses when they show: always, on hover, or with the crosshair tool only.
- A Files section in the right panel: the open image and every mask on it, with show or hide, save and close for each. The image can be dimmed.
- Several masks open at once (up to four). One is being edited; the others are drawn as outlines for comparison. Each keeps its own undo history and segments.
- "Open with" for NIfTI, MetaImage, NRRD and DICOM files on macOS, Windows and Linux. An image and its mask chosen together open as a pair in one window, and files opened later join the window that is already open.
- The drop overlay says what a drop will do. A second image asks before it replaces the first.

### Fixed

- Dropping files on the desktop app now uses the system's own drag and drop, so files and folders arrive with their real paths on every platform.
- A mask with many segments dropped on an open image could replace the image without asking.
- Files opened with the app while it was running were ignored.

### Added earlier

- Report a problem or suggest an idea from the file menu or the start screen. The app fills in GitHub's new-issue form in your browser; you review and submit it there. Technical details are optional, shown before sending, and never hold file names or paths.
- Refine a segment from its menu: grow, shrink and smooth by a distance in millimetres, fill holes, keep the largest island, remove small islands. Each is one undo step and is shared with the room.
- Combine: add one segment into another.
- Go to segment: move all views to the middle of a segment.
- The volume of each segment next to its name, and a measurements sheet (volume, voxels, mean ± SD, min, max) that can be copied as CSV.
- Brush option "Paint over: Everything / Empty only". With "Empty only", painting never takes voxels from another segment.
- Room server: groundwork for the next version of rooms (member keys, invite links that expire, edits in one order, rooms where guests view through the host). Rooms in the app work as before; see `docs/design/ROOMS-PROTOCOL.md`.
- Autosave and crash recovery. While a mask has unsaved changes, a recovery copy is kept on this device. Opening the same image again offers to restore it. Saving the mask removes the copy, and switching autosave off removes them all.

### Fixed

- Scrolling with a trackpad moved one slice for every event the trackpad sent, and dropped the slow ones, so it could not be controlled. Pinch did nothing in the macOS app. (#18)
- Maximising a view on macOS showed it as a thin strip. A maximised view now fills the whole area.
- Opening or closing the segments panel, resizing the window or maximising a view no longer changes the zoom or moves the image, and the image is never shown stretched while it happens.
- The 3D view showed one slice of each segment, so a segment away from the middle was missing or a sliver. It now shows whole segments and follows every edit.
- The dark edge behind view labels covers the whole label.
- macOS and Linux: enlarging a view no longer collapses it to a thin strip, which left the views black and the mask impossible to edit.
- A key press whose release never reached the app (switching apps, a save dialog) no longer leaves the tools dead until the next key press.
- The brush always paints at least the voxel under the cursor. The size control now starts at the smallest size that paints on the open image, and takes decimals below 5 mm.
- A click on the 3D view with an edit tool says where to paint instead of doing nothing.
- Room and report dialogs: the close button no longer sits on top of the tabs.
- Tooltips of the buttons over a view open below them instead of over the neighbouring button, and their text is no longer outlined.
- Menus and popovers in the segments panel, and the room popover, cover the rows from edge to edge, so no pieces of rows show beside them.
- The segment menu stays above the status bar at small window sizes; every item can be reached.
- A narrow status bar drops whole items instead of cutting the save state mid-word.

## [0.1.0] - 2026-11-19

First release.

### Added

- Open NIfTI (`.nii`, `.nii.gz`), MetaImage (`.mha`, `.mhd`), NRRD and DICOM volumes.
- Overlay a mask on an image. A mask on a different grid is resampled through world coordinates.
- Mask tools: brush, eraser, threshold brush, scissors, fill and fill between slices. Shift-drag erases with the brush. Brush size is the diameter in mm.
- Viewing tools: crosshair, pan, zoom, ruler, and window/level with CT presets, including Liver, Stroke and Subdural.
- Segments with names and colours, which can be locked or hidden.
- Undo and redo.
- Save masks as `.nii.gz`, `.nii`, `.mha` or `.nrrd`. Segment names are kept in every format.
- Rooms for editing one mask together in real time, joined with a display name only. A room can be hosted on the local network or through a relay server.
- Keyboard shortcuts that can be rebound.
- Auto-update through GitHub Releases.
- Signed and notarised macOS builds, with Windows and Linux installers.

### Fixed

- A mask with the same size as the image but another axis order was overlaid mirrored.
- Undo by one person in a room erased another person's voxels.
- Simultaneous strokes in a room could leave clients with different masks.
- File names were sent to the room. A room now sees only "Room image" and "Room mask".
- Opacity, outline and hide controls did not repaint the mask.
- A crosshair click did not move the other views.
- CT data opened on an unusable window. It now opens at W 400 L 40.
- Painting on a locked or hidden segment changed it.
- Segment names were lost when saving NIfTI and MetaImage.
- The threshold brush read mask values instead of image values.
- Opening an image and a mask together failed.
- Pressing a tool key after picking a window preset changed the window.
- Arrow-up moved to the next slice instead of the previous one.
- Undo of a deleted segment did not work correctly.
- Orientation letters were faint, and some control borders and focus rings did not meet contrast rules.
- The threshold strip overflowed in narrow windows, and the segment menu was clipped by the list.
- The close confirmation had no Save button.

[Unreleased]: https://github.com/ArioMoniri/w-annotator/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ArioMoniri/w-annotator/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ArioMoniri/w-annotator/releases/tag/v0.1.0
