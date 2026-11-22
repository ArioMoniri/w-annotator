# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- "Open the sample" on the start screen, for anyone who skipped the welcome tour.

### Changed

- Messages about a cut, a fill or removed islands give the amount in mL or mm³, like the measurements, where some counted voxels. The fill preview does the same.
- The options strip keeps whole words in a narrow window. Where there is no room, a group of buttons becomes a list with the same choices; "Fill between slices" has that one name at every width.
- The MR window that was called "Soft tissue" is now "Mid range". Soft tissue is a CT window with a fixed meaning; the MR one is worked out from the image. The window itself is the same.
- The Pancreas preset (W 150, L 65) is described as what it is: a narrow window chosen for a contrast-enhanced pancreas, not a standard preset. Its numbers are unchanged.
- The hint under "Remove island" says that a segment in one piece is removed whole.

### Fixed

- Undo on a message could undo a newer step than the one the message was about. The button now goes as soon as another edit, an undo or a redo is made.
- A message no longer disappears while the pointer is on it or while it has keyboard focus.
- Undo or redo during a fill preview left the preview on screen, and Apply then found nothing to fill. Undo and redo now cancel the preview first.
- "Erase outside" on one slice said nothing when it removed parts that were out of view in a zoomed-in view. It now says how much, with Undo.
- "Remove island" on a segment in one piece says that all of it was removed.
- The Window / Level strip could not set a width under 1, which made it useless on images scaled 0 to 1. The smallest width and the arrow-key step now follow the image's range.
- In a narrow window the hint about Ctrl-drag (⌘-drag) for a window from a box disappeared. It is now the tooltip of the W and L fields.
- Low contrast: the W and L numbers beside a preset and the segment number were hard to read on a selected or pointed-at row.
- The view name and the slice counter were hard to read over a bright image. Each now has a small dark backing.
- The README and Settings → Help gave CC BY 4.0 for both sources of the sample. LIDC-IDRI is CC BY 3.0.
- Esc restores a maximised view only when nothing else took it. Holding Esc a moment too long to close a menu, or pressing it in the middle of a brush stroke or a pan, no longer changes the layout or the tool.
- A tooltip is no longer read out as part of a button's name. A screen reader says "Apply", not "Apply Apply Enter".
- In the Grow, Shrink, Smooth, Remove small islands and Combine popovers of a segment, Tab and Shift+Tab reach every control and stay inside, also on a Mac.
- Opening a mask, showing a hidden comparison mask or switching the mask being edited no longer sends the views back to the middle slice and the fitted zoom.
- Undo of "Split into separate segments" also removes the segments the split made, for everyone in a room, and redo brings them back with their names and colours.

## [0.1.2] - 2026-11-21

### Added

- The window in the status bar is now a button. It opens a menu of presets, Auto and Full range, with any tool selected, and shows the name of the preset in use.
- CT presets Pancreas (W 150, L 65) and Abdomen sit with Liver and Soft tissue. Images that are not CT get windows worked out from their own values: Auto, Full range, Soft tissue, Bright fluid and Dark detail. The menu can switch between the CT and MR lists.
- Save current as preset: name the window on screen and it joins the list, up to 12. Saved presets are kept between launches and can be removed from the menu.
- P and Shift+P step through the window presets. Shift with the arrow keys makes the image brighter or darker and changes the contrast.
- With the Window / Level tool, Ctrl-drag (⌘-drag on a Mac) a box to set the window from the values inside it, and a two-finger scroll on a trackpad changes brightness (up and down) and contrast (sideways). Shift+scroll still changes slice.
- The zoom in the status bar is a button too: Zoom in, Zoom out, Fit and Actual size. The keys are =, - and 0.
- Two kinds of room, chosen when a room is started. In a **shared copy** room everyone gets the image and the mask, can keep working offline and is merged when they come back. In a **view through my computer** room guests see and edit through the host's computer: they receive 8-bit pictures of the slices they look at, never the files, cannot save, and are disconnected when the host leaves.
- The host can remove a person, switch off an unused invite link, and end or delete the room.
- After offline work in a shared-copy room, changes to different voxels are both kept. Where both sides changed the same voxels the room's version stays and yours is kept until you choose *Use mine* or *Keep the room's*.
- Rooms you have joined are listed under *Join a room*, so you can come back to a shared-copy room without a new link.
- Freehand scissors: drag a loop around a region and release to erase or fill inside it. Where a loop crosses itself, what it goes around once is inside.
- Scissors "Erase outside", and a depth choice: this slice or all slices of the view. A cut through all slices says how many voxels it changed and offers Undo.
- Alt-click on a slice view selects the segment under the cursor, with any tool.
- Paint over "Only <segment>": painting stays inside one segment. The choice is also in the threshold brush, the scissors (fill) and the Fill tool, and it applies to Fill between slices.
- Fill tool actions "Remove island" and "Keep island": click a piece of the segment to remove it, or to keep it and remove the rest. Islands are followed through the whole volume.
- Fill between slices now shows a preview first. Apply (Enter) writes it as one undo step; Cancel (Esc) leaves the mask as it was. A preview is never sent to a room.
- "Smooth pixels" in the menu on a view's name. Off draws each voxel as a flat block. The image values are not changed.
- "Split into separate segments" in a segment's menu: each island becomes a segment of its own, at most 20 at a time, asking first when there are many.

### Changed

- Invite links work for one person and stop working after 24 hours. Room codes are gone: a room is joined with its link.
- What a room sends is encrypted between the apps. The room server no longer sees names, voxels or segment names.
- Edits in a room follow one order set by the room server, so two people painting over each other always end with the same mask. A lost connection is retried for as long as it takes, with a *Reconnect now* button.
- The room server (`relay/`) serves the old room protocol only when started with `--v1`. An app from before this version is told to update.
- The scissors erase the active segment only. Other segments inside the shape are left as they are.

### Fixed

- Rejoining or reconnecting to a room no longer replaces your mask with the room's without asking.
- Edits made while a room was reconnecting were dropped.
- The brush ring no longer stays in a view after the pointer has left it.
- Maximising a view now enlarges its image to fill the larger pane, and restoring puts it back as it was.
- Tab and Shift+Tab now reach every control in a dialog, including buttons, switches and sliders, on macOS too, and stay inside the dialog.

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
- End-to-end tests of the built desktop app on Linux and Windows (WebDriver), a self-test of the built app on all three systems, the web tests in WebKit on macOS, and a check against one openly licensed chest CT.

### Changed

- When the app hosts a room, the host now connects to it over this computer's own address, so a firewall cannot keep the host out of its own room. The invite link still carries the network address.
- If the computer has no network address, the invite link uses `127.0.0.1` and the dialog says it only works on this computer.
- Joining with a bare code when no room server is set now asks for the invite link.

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

[Unreleased]: https://github.com/ArioMoniri/w-annotator/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/ArioMoniri/w-annotator/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ArioMoniri/w-annotator/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ArioMoniri/w-annotator/releases/tag/v0.1.0
