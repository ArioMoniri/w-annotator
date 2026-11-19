# Real-data test: MetaImage images with NIfTI masks

Date: 2026-11-19. Build under test: the frozen web build at `http://localhost:4173`, relay at `ws://localhost:8787`.
Driver: Playwright, headless Chromium with SwiftShader, viewport 1440 × 900. Independent checks: Python 3.13 with SimpleITK 2.5.8 and nibabel 5.5.0.

All downloads, screenshots, saved masks and driver scripts are in `/tmp/realdata`. Nothing from the datasets is in the repository.

## Summary

- Four real cases from three public datasets were fetched one case at a time, without downloading the 5 to 49 GB archives, using HTTP range requests on the Zenodo zips.
- Loading is correct for every case: image voxels are byte-identical to SimpleITK, masks are voxel-identical to the files, and the overlay sits on the anatomy in all three planes with correct laterality. This includes oblique MR `.mha` (PI-CAI), a NIfTI mask with only a qform, a float64 label file, RAS-oriented NIfTI, and `.mhd` + `.raw` / `.zraw` pairs.
- Brush, eraser, undo, redo, save and reopen all verify. Saved masks keep the original geometry to within 0.000005 mm and differ from the original only inside the edited box.
- Rooms work on full-size volumes: a guest with nothing open received the image and mask byte-equal in 3.5 to 6.1 s, edits from both sides converged in under 0.25 s, and the guest's saved file verified.
- Two tools did not work in the frozen build: the **threshold brush ignores image intensity** (still broken in the current source), and the **crosshair did not move the other views** (already fixed in the current source).

## 1. Network reach

Tested with `curl -sSI` through the session proxy.

| Host | Result | Used for |
|---|---|---|
| `zenodo.org` | 200, range requests honoured (206) | PI-CAI, PANORAMA, LUNA16 images |
| `raw.githubusercontent.com` | 200 | PI-CAI and PANORAMA label files, one by one |
| `huggingface.co` | 200 | Dataset search and listings |
| `msd-for-monai.s3-us-west-2.amazonaws.com` | 200 | Medical Segmentation Decathlon tars (not downloaded) |
| `grand-challenge.org`, `luna16.grand-challenge.org`, `www.cancerimagingarchive.net`, `data.kitware.com`, `osf.io`, `openneuro.org`, `physionet.org`, `academictorrents.com` | 200 | Not needed |
| `github.com`, `codeload.github.com`, `api.github.com` | 403 from the proxy | Repo archives and releases are blocked; only raw files work |
| `cdn-lfs.huggingface.co` | no response | Large HF files were not needed |

`pip install SimpleITK nibabel remotezip` worked.

## 2. Datasets

| Dataset | What it is | Formats | Licence | Size | Download | Single case without the archive? |
|---|---|---|---|---|---|---|
| [PI-CAI public training set](https://zenodo.org/records/6624726) | 1500 prostate bpMRI studies (T2W, ADC, HBV, sag, cor) | Images `.mha` (zlib-compressed, oblique). Labels `.nii.gz` in [picai_labels](https://github.com/DIAGNijmegen/picai_labels) | CC BY-NC 4.0 | 5 zips, 5.2 to 5.6 GB each | `https://zenodo.org/api/records/6624726/files/picai_public_images_fold0.zip/content` (fold0 to fold4). Labels: `https://raw.githubusercontent.com/DIAGNijmegen/picai_labels/main/csPCa_lesion_delineations/human_expert/resampled/<case>.nii.gz` and `.../anatomical_delineations/whole_gland/AI/Bosma22b/<case>.nii.gz` | **Yes.** Range read of the zip directory, then one member (2.5 to 17 MB for a T2W). Labels are plain per-file URLs. **Used.** |
| [PANORAMA batch 1](https://zenodo.org/records/13715870) | Contrast CT for pancreatic cancer, about 550 scans per batch | Images are `.nii.gz`, not `.mha`. Labels `.nii.gz` in [panorama_labels](https://github.com/DIAGNijmegen/panorama_labels) | CC BY-NC 4.0 | 49 GB per batch zip | `https://zenodo.org/api/records/13715870/files/batch_1.zip/content`. Labels: `https://raw.githubusercontent.com/DIAGNijmegen/panorama_labels/main/automatic_labels/<case>.nii.gz` | **Yes**, same range method (10 to 360 MB per scan). **Used.** `manual_labels/` returned 404 for the case tried. |
| [LUNA16](https://zenodo.org/records/3723295) | 888 chest CTs with lung masks | Images `.mhd` + `.raw`. Lung masks `.mhd` + `.zraw` | CC BY 4.0 | 10 subsets, 6.3 to 7.3 GB each; masks 304 MB | `https://zenodo.org/api/records/3723295/files/subset0.zip/content`, `.../seg-lungs-LUNA16.zip/content` | **Yes**, same range method (31 to 155 MB per scan). **Used.** |
| [ULS23](https://zenodo.org/records/10035161) | Universal lesion segmentation, CT crops | `.nii.gz` | CC BY-NC-SA 4.0 | Split zip, 4.3 GB parts | `https://zenodo.org/api/records/10035161/files/ULS23_Part1.zip/content` plus `.z01` to `.z03` | Not tried. A split archive needs offsets mapped across parts. HF mirrors exist: `surajpaib/ULS23_Dataset`, `MedOtter/ULS23`. |
| TotalSegmentator [v2.0.1](https://zenodo.org/records/10047292) | 1228 CTs, 117 structures | `.nii.gz`, one file per structure | CC BY 4.0 | 23.6 GB zip | `https://zenodo.org/api/records/10047292/files/Totalsegmentator_dataset_v201.zip/content` | Should work with the range method; not fetched. HF: `YongchengYAO/TotalSegmentator-CT-Lite`. The small GitHub release samples are blocked (github.com 403). |
| Medical Segmentation Decathlon | Ten tasks, CT and MR | `.nii.gz` | CC BY-SA 4.0 | Spleen tar 1.5 GB | `https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar` | Reachable. A tar has no directory, so one case needs a scan of the stream; not fetched. |
| Hugging Face PI-CAI mirrors | `YongchengYAO/PI-CAI-Lite` (one 3.7 GB zip), `MedOtter/PI-CAI` (parquet), `chehablab/PI-CAI` (2D slices) | zip or parquet, no loose `.mha` | CC BY-NC 4.0 | 3.7 GB | `https://huggingface.co/datasets/YongchengYAO/PI-CAI-Lite/resolve/main/data-part001.zip` | Not needed; Zenodo is the original and allows range reads. |

Only PI-CAI ships true `.mha` images with `.nii.gz` labels. PANORAMA images are NIfTI. To also test that CT anatomy in MHA form, the PANORAMA and LUNA16 images were **converted to `.mha` by me** with SimpleITK (`/tmp/realdata/derived/`); those two files are conversions, not original downloads. The LUNA16 lung mask was likewise converted from `.mhd` + `.zraw` to `.nii.gz`; the original pair was tested too.

How one case is fetched (also in `/tmp/realdata/scripts`):

```python
from remotezip import RemoteZip
with RemoteZip('https://zenodo.org/api/records/6624726/files/picai_public_images_fold0.zip/content') as z:
    z.extract('10964/10964_1000983_t2w.mha', '/tmp/realdata/picai')
```

## 3. Cases

| Case | Image | Mask | Grid | Spacing (mm) | Notes |
|---|---|---|---|---|---|
| PI-CAI 10964 | `picai/10964/10964_1000983_t2w.mha` (2.5 MB, uint16) | `..._lesion.nii.gz` (uint16, label 2, 1593 voxels) | 320 × 320 × 19 | 0.5625 × 0.5625 × 3.0 | Oblique, tilted 13° about the left-right axis. Cancer-positive study. |
| PI-CAI 10000 | `picai/10000/10000_1000000_t2w.mha` (16.6 MB, uint16) | `..._gland.nii.gz` (uint8, label 1, 136 795 voxels, **qform only, sform 0**) | 640 × 640 × 31 | 0.28125 × 0.28125 × 3.3 | Oblique, tilted 23°. |
| PANORAMA 100036 | `panorama/100036_00001_0000.nii.gz` (9.9 MB, float32, RAS) and my `.mha` conversion | `..._automatic_labels.nii.gz` (**float64**, labels 2 to 6) | 512 × 512 × 37 | 0.78125 × 0.78125 × 5.0 | Direction −1, −1, 1. |
| LUNA16 …821260 | `.mhd` + `.raw` (63 MB, int16) and my `.mha` conversion | Lung mask as `.nii.gz` (converted) and as original `.mhd` + `.zraw` (int16, labels 3, 4, 5) | 512 × 512 × 121 | 0.7617 × 0.7617 × 2.5 | Full-size chest CT, values −3024 to 2103. |

PI-CAI `.mha` headers carry anonymised study tags (age, sex, scanner). They stay in `/tmp/realdata`.

## 4. Results per case

### Load and overlay

| Case | Image load | Mask load | Image voxels vs SimpleITK | Mask voxels vs file | Warnings | Segments listed | Overlay and laterality |
|---|---|---|---|---|---|---|---|
| PI-CAI 10964 | 1.1 s | 0.6 s | identical (SHA-256) | identical | none | 2 | Lesion in the right posterolateral peripheral zone in axial, sagittal and coronal; R on screen left. Correct. |
| PI-CAI 10000 | 1.8 s | 0.9 s | identical | identical | none | 1 | Gland mask covers the prostate under the bladder in all three planes. Correct. |
| PANORAMA (nii.gz) | 1.7 s | 1.2 s | identical | identical | none | 2, 3, 4, 5, 6 | Arteries on the aorta in front of the spine, pancreas tail towards the spleen on patient left, liver on screen left. Correct. |
| PANORAMA (my .mha) | 1.7 s | 1.1 s | identical, same hash as the NIfTI | identical | none | 2 to 6 | Same as above. |
| LUNA16 (.mhd + .raw) | 1.9 s | 1.2 s | identical | identical | none | 3, 4, 5 | Label 3 (left lung) on screen right with the cardiac notch, label 4 right lung, label 5 trachea. Correct. |
| LUNA16 (my .mha, zlib) | 3.0 s | – | identical, same hash | – | none | – | – |
| LUNA16 mask as `.mhd` + `.zraw` | – | 1.4 s | – | same hash as the NIfTI conversion | none | 3, 4, 5 | – |

The views are true axial, sagittal and coronal in patient space. For the oblique PI-CAI volumes that means the app reslices: 19 acquired slices show as 33 axial positions (10964), 31 as 54 (10000).

Other load paths:

- **Mask on a different grid.** ADC image (88 × 128 × 21, 2 mm) with the T2W-grid lesion mask: warning "The mask is 320 × 320 × 19 but the image is 88 × 128 × 21. It was resampled to fit." Result: 126 voxels, **0 voxels different** from SimpleITK nearest-neighbour resampling. Same check with the 640 × 640 gland mask on the 116 × 114 ADC: 3503 voxels, 0 different.
- **`.mhd` without its `.raw`.** Error: "The data file "….raw" that this header points to is missing. Select it together with the header." Clear.
- **Image and mask together through drop** (`openFiles` with no role, either order): both open and are told apart correctly, including PI-CAI names with no "seg", "mask" or "label" in them.
- **Image and mask together through the "Open image" dialog**: the second file is dropped without a word (bug 3).

### Editing

One brush stroke (8 mm), undo, redo, one eraser stroke across the mask, one threshold-brush stroke, on the axial view.

| Case | Brush | Undo restores original | Redo restores stroke | Eraser | Threshold brush |
|---|---|---|---|---|---|
| PI-CAI 10964 | +1857 voxels, on acquired slices 8 to 10 | yes (hash) | yes | −395 voxels, slices 7 to 8 | 0 voxels with range 21 to 155 around a value of 88 (bug 1) |
| PI-CAI 10000 | +7367 voxels, slices 9 to 12 | yes | yes | −4878, slices 13 to 15 | 0 voxels, range 170 to 444 at value 307 |
| PANORAMA | +1635 voxels, slice 17 only | yes | yes | −614 | 0 voxels, range 91 to 171 at value 131 |
| LUNA16 | +1319 voxels, slice 55 only | yes | yes | −1017 | 0 voxels, range 987 to 1287 at value 1137 |

On the oblique MR cases one flat stroke in the axial view lands on three or four acquired slices, because the view cuts across them.

### Save, independent check, reopen

Saved through File → Save mask (browser download), then compared in Python with the original mask file.

| Case | File | Spacing / origin / direction vs original mask | Corner voxel offset | Voxels changed | Changed box (i, j, k) | Outside the box | Saved = app mask | Reopen in a fresh tab |
|---|---|---|---|---|---|---|---|---|
| PI-CAI 10964 | uint8 `.nii.gz`, 2.6 KB | 0 / 0 / 2.5e-8 | 4.5e-6 mm | 2252 | 125..250, 130..203, 7..10 | identical | yes | same hash, no warning |
| PI-CAI 10000 | uint8, 20 KB | 0 / 0 / 0 | 0 | 12 245 | 229..521, 210..370, 9..15 | identical | yes | same hash |
| PANORAMA | uint8, 17 KB | 0 / 0 / 0 | 0 | 2249 | 100..284, 280..374, 17 | identical | yes | same hash |
| LUNA16 | uint8, 267 KB | 0 / 0 / 0 | 0 | 2336 | 345..511, 183..286, 55 | identical | yes | same hash |

The changed-voxel count and box found in Python equal what the app's own buffer showed. The NIfTI affine differs from the original by at most 6e-8. Saved files carry both qform and sform (the PI-CAI gland original had qform only) and keep the original axis codes (LPS for PI-CAI and LUNA16, RAS for PANORAMA).

Two things change on save, both harmless to the labels but worth knowing: the data type always becomes uint8 (originals were uint16, float64 and int16), and segment names are not in the file (the frozen build writes none; reopened masks list "Segment 2" and so on).

### Rooms

Host opens the case and starts a room. The guest, with nothing open, joins by the invite link.

| Case | Guest has image + mask after | Image bytes equal | Mask bytes equal | Host stroke reaches guest | Guest eraser reaches host | Both stroke at once | Guest undo reaches host | Guest save |
|---|---|---|---|---|---|---|---|---|
| PI-CAI 10000 (640 × 640 × 31) | 4.2 s | yes | yes | 35 ms | 35 ms | converged, 38 ms | 47 ms | 20 484 voxels changed vs original, equals host buffer, geometry offset 0 |
| PANORAMA (512 × 512 × 37) | 3.5 s | yes | yes | 27 ms | 28 ms | converged, 28 ms | 224 ms | 4869 changed, equals host buffer, offset 0 |
| LUNA16 (512 × 512 × 121) | 6.1 s | yes | yes | 83 ms | 89 ms | converged, 124 ms | 92 ms | 4725 changed, equals host buffer, offset 0 |

Convergence times are the time until both SHA-256 hashes matched, polled every 100 ms after the stroke ended, on one machine over localhost. The guest sees the host's file names and segment list. After the guest saves, the guest reads "Synced" and the host "Synced · unsaved", which is right.

One nit: on PI-CAI 10000 one direction cosine arrived at the guest one unit in the last place off (0.9198214989417032 against 0.9198214989417033). No effect on the saved file.

### Time and memory on full-size volumes

Measured as the resident memory of one Chromium process tree, software rendering.

| Volume | Empty app | Image + mask loaded | Peak while editing |
|---|---|---|---|
| LUNA16 512 × 512 × 121 int16 (63 MB raw) | 485 MB | 1066 MB | 1080 MB |
| PI-CAI 10000 640 × 640 × 31 uint16 (25 MB raw) | 483 MB | 858 MB | 873 MB |

No out-of-memory errors, no console errors, no failed loads. On top of the empty app that is about 9 times the raw image size for the chest CT and 15 times for the MR. PANORAMA's largest scans are 360 MB compressed; those were not tried.

Painting is slow in this environment: a 30-step drag took about 8 s, around 250 ms per pointer move, on both large cases. Rendering here is SwiftShader on CPU, so this is not a measure of the desktop app on a GPU. Not verified on real hardware.

## 5. Bugs

### 1. Threshold brush ignores the image (high; still present in the current source)

The threshold brush paints either the whole brush footprint or nothing. It behaves as if every voxel had intensity 0: it paints everything when 0 lies inside the range and nothing otherwise.

Repro: open `10964_1000983_t2w.mha` with its lesion mask, press T, set the range to 100–400, drag across the pelvis in the axial view. Nothing is painted, although 1535 of the 1650 voxels under the same stroke are in range. Set the range to 0–300 and repeat: all 1650 voxels are painted, 245 of them outside the range (values up to 403).

| Volume | Range | Painted | In range under the stroke |
|---|---|---|---|
| PI-CAI 10964 | 21–155 | 0 | 354 |
| PI-CAI 10964 | 100–400 | 0 | 1535 |
| PI-CAI 10964 | 0–300 | 1650 (245 out of range) | 1405 |
| PANORAMA | 50–1349 | 0 | 1070 |
| PANORAMA | −1024–0 | 1428 (1255 out of range) | 173 |
| Synthetic phantom from `e2e/helpers.ts` | 100–300 | 0 | stroke was inside the sphere |
| Synthetic phantom | −50–50 | 209 (all out of range, values 173–300) | 0 |

So it is not specific to real data. The default range after opening (upper half of the value range) never contains 0, so out of the box the tool does nothing. There is no e2e test for the tool. `e2e/real-data.spec.ts` now has one; it fails on the frozen build and on the dev server at `localhost:1420`.

### 2. Crosshair click and drag do nothing (high in the frozen build; fixed in the current source)

Repro: open any case, keep the Crosshair tool, click a point in the axial view. Sagittal and coronal stay on their slices (`store.slices` unchanged). Dragging the reference lines does nothing either. The options strip says "Click to move all views to a point."

The same test passes against the dev server at `localhost:1420`, so the fix already in the source works on real data. Seen with Playwright mouse events in headless Chromium; brush and eraser respond to the same events.

### 3. "Open image" dialog silently drops a second file (medium)

Repro: empty state → Open image → select `10964_1000983_t2w.mha` and `10964_1000983_lesion.nii.gz` together. The image opens with no mask and no message. The empty state invites "Drop an image and a mask", and dropping both does work, so the dialog is the odd one out. Because the dialog forces the first file to be the image, selecting a mask whose name sorts first would open the mask as the image.

### 4. 3D view does not show a small loaded lesion (medium)

Repro: open PI-CAI 10964 with `..._lesion.nii.gz` (1593 voxels over 5 slices). The 3D pane is empty, also after rotating it. Paint a stroke: the new stroke appears in 3D, the loaded lesion still does not. The larger gland mask (10000), the PANORAMA labels and the lungs do appear. Screenshots: `picai10964-02-anchor.png`, `picai10964-03-brush.png`, `exp6-3d-b.png`. Not rechecked on the current source.

### 5. Default window on CT with padding (low; reported fixed in the current source)

LUNA16 opens at W 3711 L −1168 because the −3024 padding pulls the automatic window down; soft tissue is flat grey. PANORAMA opens at W 1461 L −293. Screenshot: `luna16-01-default.png`. `docs/reviews/iter1.md` says CT now opens at W 400 L 40; not rechecked here.

### 6. View labels are hard to read over bright images (low)

"Sagittal", "Coronal" and "Slice n / N" sit on top of the image when a wide CT fills the pane, in the same light colour. Screenshot: `luna16-02-anchor.png`.

### Observations, not bugs

- **Oblique volumes are edited on resliced planes.** A flat axial stroke on PI-CAI lands on three or four acquired slices. Already listed as an open limitation in `iter1.md`; the real data shows it applies to essentially every PI-CAI study.
- **The mask data type is always uint8 on save.** Labels above 255 are refused on load with a clear message, so nothing is lost, but pipelines that expect the original type will see a change.
- **The suggested save name is the original mask's name.** In the browser that is a new download; in the desktop app the save dialog would point at the original file.
- **Brush overwrites other segments** unless they are locked (visible in `room-luna16-guest-final.png`, where a stroke for the left lung covers part of the right lung).

## 6. Screenshots and artefacts

All under `/tmp/realdata`:

| Path | What |
|---|---|
| `shots/<case>-01-default.png` | Case as opened (`picai10964`, `picai10000`, `panorama`, `panoramaMha`, `luna16`) |
| `shots/<case>-02-anchor.png`, plus `-axial`, `-sagittal`, `-coronal` crops | All three views moved to a mask voxel; used to judge alignment |
| `shots/<case>-03-brush.png`, `-04-edited.png`, `-05-reopened.png` | After the brush stroke, after all edits, saved mask reopened |
| `shots/room-<case>-guest-joined.png`, `-host-final.png`, `-guest-final.png` | Room runs |
| `shots/extra-C-adc-resampled.png`, `extra-I-adc-gland.png` | Mask resampled onto the ADC grid |
| `shots/exp5-*.png`, `exp6-*.png`, `extra-H-3d-*.png` | Crosshair and 3D probes |
| `results/<case>-result.json`, `<case>.log`, `room-<case>-result.json`, `extras.json` | Raw numbers |
| `results/<case>-saved.nii.gz`, `room-<case>-saved.nii.gz` | Masks saved by the app |
| `scripts/` | Playwright drivers (`runcase.cjs`, `room.cjs`, `extras.cjs`, `mem.cjs`) and `verify.py` |
| `cases.json` | Manifest for the reusable spec |

## 7. Reusable spec

`e2e/real-data.spec.ts` runs five checks per case in `$W_REALDATA_DIR/cases.json`: load and grid, edit + save + independent NIfTI check + reopen, threshold brush, crosshair, room. It parses the saved NIfTI itself in Node rather than with the app's reader, and writes its temporary file to the system temp folder, not the repository.

```
W_REALDATA_DIR=/tmp/realdata pnpm e2e e2e/real-data.spec.ts
W_REALDATA_DIR=/tmp/realdata W_REALDATA_URL=http://localhost:4173 pnpm e2e e2e/real-data.spec.ts
```

Without `W_REALDATA_DIR` it reports one skipped test. That skip was asked for and is at odds with rule 4 in `CLAUDE.md` ("never skip tests"); the alternative is to keep the file out of the default run.

Results on the frozen build: load, edit/save/reopen and room pass on all four cases (12 tests); threshold brush and crosshair fail on all four (8 tests). The last full run predates a tightening of the threshold test and a change of the temporary folder; after those, the threshold test was rerun on all four cases and the whole file on PI-CAI 10964. On the dev server, two cases were run: 8 pass, 2 fail (threshold only).

Not verified: the desktop (Tauri) build, any GPU, macOS and Windows, ULS23, TotalSegmentator, the Decathlon, and scans above 63 MB raw.
