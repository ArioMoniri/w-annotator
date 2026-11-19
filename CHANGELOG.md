# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Refine a segment from its menu: grow, shrink and smooth by a distance in millimetres, fill holes, keep the largest island, remove small islands. Each is one undo step and is shared with the room.
- Combine: add one segment into another.
- Go to segment: move all views to the middle of a segment.
- The volume of each segment next to its name, and a measurements sheet (volume, voxels, mean ± SD, min, max) that can be copied as CSV.
- Brush option "Paint over: Everything / Empty only". With "Empty only", painting never takes voxels from another segment.

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

[Unreleased]: https://github.com/ArioMoniri/w-annotator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ArioMoniri/w-annotator/releases/tag/v0.1.0
