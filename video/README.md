# Launch video and README slideshow

The source of the 30-second tour at [`docs/assets/launch.mp4`](../docs/assets/launch.mp4), of its looping preview `docs/assets/launch.webp`, and of the slideshow `docs/assets/features.webp`.

The video is real footage of the app, recorded by a script and composed with [Remotion](https://www.remotion.dev/). The slideshow is made of screenshots of the app taken by a second script. This folder has its own `package.json`; nothing here is a dependency of the app.

## How the video is made

1. `scripts/record.cjs` drives the app with Playwright through one scripted session on a chest CT: open an image and a mask, paint a correction, paint a new segment on three slices and fill between them, grow it, start a room that a second browser joins, paint from both sides, and save. It forces the dark theme and marks the welcome tour as seen (`?tour=0` and the saved setting). It does not capture in real time. It takes one screenshot per video frame wherever the picture changes and writes a manifest that says, for every frame, which screenshot is showing, where each cursor is, whether the button is down, which scene it belongs to and where the view should be zoomed. A slow machine therefore gives the same result as a fast one.
2. `scripts/build-footage.cjs` turns the screenshots into `public/footage-a.mp4` (the host's window) and `public/footage-b.mp4` (the second person's window), and writes `src/track.json` with the cursor path, the scene ranges and the eased camera path.
3. `src/Launch.tsx` is the composition: a title card, the footage in a window, a cursor drawn from the recorded path, one caption per scene in the band under the window, and an end card.

The window is drawn as a title bar with the footage in a separate box below it, so the bar never covers the app. At rest the whole app is visible, scaled to fit. A zoom enlarges the footage inside that box and is anchored to a corner of the app, so the app's own top bar keeps its place under the title bar. The background is a slow gradient with a little grain.

The cursor, the zoom towards the action and the window on a background follow the approach of screen recorders such as [Recordly](https://github.com/webadderall/Recordly). Recordly itself is not used: it is a desktop app that records a real screen and has its own editor, not something a script can drive on a machine without a display. No code from it is included.

## Render

```
cd video
npm install
npm run render      # renders out/launch-full.mp4, then ffmpeg writes ../docs/assets/launch.mp4 (1920x1080, 30 fps, H.264, no audio)
npm run preview     # writes ../docs/assets/launch.webp from that file (needs ffmpeg and Python with Pillow)
npm run studio      # opens the Remotion editor
```

Remotion downloads a headless Chrome the first time. To use one that is already installed, run the `remotion render` command from `package.json` with `--browser-executable=/path/to/chrome-headless-shell` added. The second step re-encodes with ffmpeg because x264's slow preset gives a smaller file than Remotion's own encode at the same quality.

## Record again

Record against a build, not the dev server, so that an edit to the source cannot reload the page in the middle. From the repository root, build the app (`pnpm vite build`), serve `dist` on a port (`pnpm vite preview --port 4173`), start the relay (`cargo run -p w-relay -- --port 8787`) and put `chest_ct.mha` and `lungs.nii.gz` in a folder. Then:

```
APP=http://localhost:4173/ DATA=/path/to/folder node video/scripts/record.cjs
node video/scripts/build-footage.cjs video/out/rec
```

`record.cjs` uses the Playwright that the app's own tests install. The screenshots go to `video/out/rec`, which is not committed.

## Slideshow

```
APP=http://localhost:4173/ DATA=/path/to/folder node video/scripts/slides-shoot.cjs
node video/scripts/slides-build.cjs      # writes ../docs/assets/features.webp (needs ffmpeg)
```

`slides-shoot.cjs` takes the screenshots on the same scan: two people in a room, a segment before and after *Fill between slices*, the amount form of a refine operation, and the four views in the dark and the light theme. `slides-build.cjs` lays each one out at 960 x 600 with the caption in a bar under the picture, and joins them with a short fade through the background. Nothing is drawn on top of the screenshots except the two small labels on the before-and-after slide.

## Font

All text in the video and the slideshow is [Inter](https://rsms.me/inter/) by Rasmus Andersson, licensed under the [SIL Open Font License 1.1](https://openfontlicense.org). It comes from the npm package `@fontsource-variable/inter`, so the render needs no network. The composition waits for the font before it draws a frame, and both scripts stop if it does not load.

## Data

The scan is one chest CT from [LUNA16](https://luna16.grand-challenge.org), a subset of [LIDC-IDRI](https://www.cancerimagingarchive.net/collection/lidc-idri/), with the LUNA16 lung mask (labels 3, 4 and 5: left lung, right lung, airways). Both are licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The image was converted from `.mhd` + `.raw` to `.mha` and the mask to `.nii.gz`; [docs/reviews/real-data.md](../docs/reviews/real-data.md) says how the files were fetched and converted.

## Licences

Remotion is not under an open-source licence. It is free for individuals, non-profits and companies of up to three people; larger companies need a company licence. Read the [Remotion licence](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) before you render this in a company. The rest of this folder is under the repository's licence, PolyForm Noncommercial 1.0.0.
