# About W Annotator

Text for the repository's About box and for anyone who needs a short description of the project.

## One-line description

Desktop app for viewing medical volumes and correcting segmentation masks, alone or together in a realtime room.

## Suggested topics

`medical-imaging` `segmentation` `annotation` `nifti` `dicom` `nrrd` `cornerstone3d` `tauri` `radiology` `collaboration` `desktop-app` `typescript`

## Description

W Annotator opens a medical volume, overlays a segmentation mask and lets you correct it by hand. It reads NIfTI, MetaImage, NRRD and DICOM, and saves masks as `.nii.gz`, `.nii`, `.mha` or `.nrrd` with their geometry, label values and segment names. Several people can edit the same mask at once in a room, joined with a display name only. It runs on macOS, Windows and Linux, and is built with Tauri and Cornerstone3D.

## Who it is for

- Annotators who correct many masks and need the common tools close to hand.
- Radiologists and other clinicians who review or fix segmentations for research or teaching.
- Researchers who prepare labelled data and want to check or edit masks without a large toolkit.
- Small teams who want to work on the same mask at the same time.

## What it is not

- It has no AI. There is no model inference, auto-segmentation or assistant, and none is planned.
- It is not a medical device. It is not cleared or certified for diagnosis, treatment or any other clinical decision.
- It is not a PACS or an archive. It works on files you open and saves files you choose.
- Rooms are not end-to-end encrypted. See `SECURITY.md`.

## Licence

W Annotator is released under the [PolyForm Noncommercial License 1.0.0](../LICENSE). It is free for personal, research, teaching and other non-commercial use. Commercial use needs written permission from Ariorad Moniri. Third-party components keep their own licences, including Cornerstone3D (MIT) and Tauri (MIT or Apache-2.0). The software is not a medical device and comes without warranty.
