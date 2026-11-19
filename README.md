<div align="center">

<img src="docs/assets/logo.png" width="72" alt="W Annotator logo">

<h1>W Annotator</h1>

A desktop app for macOS, Windows and Linux that opens 3D medical images and lets you edit segmentation masks, alone or with other people in the same mask at once.

<p>
  <a href="https://github.com/ArioMoniri/w-annotator/releases/latest"><img height="50" src="docs/assets/download-macos.svg" alt="Download for macOS"></a>
  <a href="https://github.com/ArioMoniri/w-annotator/releases/latest"><img height="50" src="docs/assets/download-windows.svg" alt="Download for Windows"></a>
  <a href="https://github.com/ArioMoniri/w-annotator/releases/latest"><img height="50" src="docs/assets/download-linux.svg" alt="Download for Linux"></a>
</p>

<sub>macOS builds are signed and notarised. The app updates itself from GitHub Releases.</sub>

<br><br>

<img src="docs/assets/hero.webp" width="560" alt="Animation: one person paints an orange region on a scan slice, a second person paints a blue one, and the two stay in sync">

</div>

<p align="center">
  <img src="docs/assets/screenshot.png" alt="A chest CT in axial, sagittal, coronal and 3D views, with the left lung, right lung and airways as three segments and the brush on the edge of the left lung">
</p>

<p align="center">
  <img src="docs/assets/shot-outline.png" width="49%" alt="The axial view maximised with the mask drawn as outlines only">
  <img src="docs/assets/shot-room.png" width="49%" alt="A room with two people: the other person's cursor and name show on the slice">
</p>

<p align="center"><sub>Left: outline-only view. Right: a room with a second person's cursor.<br>Scan from <a href="https://luna16.grand-challenge.org">LUNA16</a>, a subset of <a href="https://www.cancerimagingarchive.net/collection/lidc-idri/">LIDC-IDRI</a>, with the LUNA16 lung mask. Both are licensed CC BY 4.0.</sub></p>

<h2 align="center">What it does</h2>

<p align="center">
  <img src="docs/assets/paint.webp" width="200" alt="Animation: a brush paints a stroke that becomes a filled region">
  <img src="docs/assets/fill-between.webp" width="200" alt="Animation: three stacked slices, the middle one fills in from the two painted ones">
</p>

- Shows a volume in axial, sagittal and coronal views, with a 3D view of the mask.
- Overlays a mask on an image. The two can be in different formats, such as an MHA image with a `.nii.gz` mask. A mask on another grid is resampled to the image.
- Edits the mask with a brush and an eraser (circle or sphere, size in mm), a threshold brush, scissors and fill. Shift-drag with the brush erases.
- Fill between slices: paint every few slices and the app fills the gaps.
- Has crosshair, pan, zoom, a ruler, and window/level with CT presets.
- Manages segments: add, rename, recolour, hide, lock, clear and delete. Mask opacity and an outline-only view.
- Undo and redo.
- Saves the mask as `.nii.gz`, `.nii`, `.mha` or `.nrrd`.

There are no AI features, by design.

<h2 align="center">File formats</h2>

<p align="center">
  <img src="docs/assets/formats.webp" width="560" alt="Animation: a selector moves across NIfTI, MetaImage, NRRD and DICOM series and shows for each whether it opens as an image, opens as a mask and saves a mask">
</p>

<p align="center"><sub>Opens as image or mask: NIfTI (<code>.nii</code>, <code>.nii.gz</code>), MetaImage (<code>.mha</code>, <code>.mhd</code>), NRRD (<code>.nrrd</code>, <code>.seg.nrrd</code>) and uncompressed DICOM series.<br>Saves masks as <code>.nii.gz</code>, <code>.nii</code>, <code>.mha</code> or <code>.nrrd</code>. Compressed DICOM and DICOM SEG are in progress.</sub></p>

<h2 align="center">Working together</h2>

<p align="center">
  <img src="docs/assets/rooms.webp" width="200" alt="Animation: two cursors meet on one shape and each fills half of it">
</p>

A room lets several people edit one mask at the same time. Nobody needs an account, only a display name.

1. Open an image, press **Share** and start a room.
2. Send the invite link to the others.
3. They paste it under *Join a room* and type a name.
4. Someone who joins with nothing open receives the image and the mask.

With the server field left empty, the desktop app hosts the room itself. That works for people on the same network or VPN. To work over the internet, run the relay in [`relay/`](relay/README.md) (a small Rust server, with a Dockerfile) and enter its address when starting the room. The relay forwards messages and stores nothing.

<h2 align="center">Shortcuts</h2>

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `B` | Brush | `C` | Crosshair |
| `E` | Eraser | `H` | Pan |
| `T` | Threshold brush | `Z` | Zoom |
| `S` | Scissors | `W` | Window / level |
| `F` | Fill | `R` | Ruler |
| `[` `]` | Brush size | `Space` | Last tool |
| `1`–`9` | Select segment | `N` | New segment |
| `O` | Outline only | `X` | Hide or show the mask |
| `↑` `↓` | Next / previous slice | `M` | Maximise or restore a view |
| `Ctrl+Z` | Undo | `Ctrl+Shift+Z` | Redo |
| `Ctrl+O` | Open image | `Ctrl+Shift+O` | Open mask |
| `Ctrl+S` | Save mask | `Ctrl+\` | Show or hide segments |
| `I` | Fill between slices | `Shift`-drag | Erase with the brush |

On macOS use `Cmd` in place of `Ctrl`. With any tool: scroll changes slice, `Ctrl`+scroll zooms, middle-drag pans, right-drag changes window/level, and double-click maximises a view. The full list is in the app, where the shortcuts can also be changed.

<h2 align="center">Build from source</h2>

You need Node with pnpm, Rust, and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

```
pnpm install
pnpm tauri dev           # run the desktop app
pnpm test                # unit tests
pnpm e2e                 # end-to-end tests
cargo test --workspace   # Rust tests, app and relay
```

<h2 align="center">Releasing</h2>

Pushing a `v*` tag builds the installers and a draft release. The steps and the signing secrets are in [docs/RELEASING.md](docs/RELEASING.md).

<h2 align="center">Built on</h2>

- [Cornerstone3D](https://www.cornerstonejs.org/), the rendering engine and tool library of the [OHIF Viewer](https://ohif.org/).
- [Tauri](https://tauri.app/) for the desktop shell and the updater.

The animations are Lottie files. Their sources are the `.json` files in [`docs/assets`](docs/assets), rendered to animated WebP for this page.

W Annotator is not a medical device and must not be used for diagnosis or treatment.
