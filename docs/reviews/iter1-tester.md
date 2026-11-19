# Iteration 1 — exploratory test report (first-time user + bulk annotator)

```
TESTER REPORT
Build: http://localhost:4173 (frozen build; repo HEAD 3320dd4), relay ws://localhost:8787
Driver: Playwright, headless Chromium (swiftshader), 1440x900 and 1024x640. Scripts: /tmp/wtest/s*.js. Screenshots: /tmp/wtest/shots/
Fixtures used: synthetic 48^3 CT-like phantom + 2-label mask (same generator as e2e/helpers.ts) written as
  .nii, .nii.gz, .mha, .nrrd; a 64x48x30 pair; a 32^3 mask; notes.txt, photo.png, truncated.nii, garbage.nii,
  empty.nii, bad.nii.gz (all in /tmp/wtest/fx/)
Covered: empty state; open by file dialog, by drop, by Ctrl+O / Ctrl+Shift+O; NIfTI / NIfTI-gz / MHA / NRRD;
  bad files; mismatched masks; every rail tool in axial, sagittal, coronal; brush size (slider, field, [ ]); sphere;
  segments (add, select, rename, colour, hide, lock, show only, clear, delete, 26 and 255 segments); undo/redo by
  keys, buttons, toast; opacity, outline, X; maximise; panel toggle; ? sheet; arrows; save + reopen; replace image
  and Close with unsaved changes; reload; rooms with 2-4 contexts; rapid input; resize; Tab pass.
Not covered: DICOM (no fixture); .mhd/.nhdr with separate data file; real OS file dialog and "mask next to the
  scan" detection (Tauri only); 512x512x300 performance; oblique / non-1 mm spacing; 16-bit masks; crash recovery;
  auto-update. Interpolation, W/L presets and a layout switch could not be tested because no control for them exists.
```

Severity: Blocker / Major / Minor / Polish. Type: bug / confusing / missing.
Every item was reproduced at least twice from a fresh load unless marked "seen once".

## Blockers

**B1 [Blocker, bug] Two people painting over the same area end with different masks, and both screens say "Synced"**
Steps: 1. Context A: open image + mask, Share > Start a room (name Ana). 2. Context B: open the same pair, Share > Join a room (name Ben, paste link). 3. A selects Brush with segment 1, B selects Brush with segment 2. 4. Both drag at the same time along the same row of the axial view towards each other so the strokes overlap. 5. Wait 6 s.
Expected: both clients hold the same mask.
Actual: masks differ permanently (A `{1:1085, 2:596}`, B `{1:1100, 2:581}`); 3 of 3 repeats diverged, plus once in an earlier run. A further stroke does not reconcile. Status bar on both: "Synced · unsaved". Whoever saves decides the result.
Evidence: /tmp/wtest/shots/33-A-diverged.png, /tmp/wtest/shots/33-B-diverged.png, script /tmp/wtest/s33.js

**B2 [Blocker against GOAL AC-11 / out of scope, bug or undocumented decision] The room sends the scan and the file names to anyone who joins**
Steps: 1. A opens phantom_ct.nii + phantom_seg.nii and starts a room. 2. B loads the empty app, clicks "Join a room", enters a name and the link. B never opens a file.
Expected (GOAL): "Each participant opens their own copy"; room traffic has no image data or file names.
Actual: B immediately shows the full scan, titled "phantom_ct.nii · phantom_seg.nii". B's socket received a text frame `{"from":1,"image":{"bytes":12470,"dims":[48,48,48],...,"name":"phantom_ct.nii"...},"mask":{...` followed by a 12 475-byte binary frame. A fourth person joining after the starter closed their tab also received the scan.
Evidence: /tmp/wtest/shots/31-B-joined-no-image.png, /tmp/wtest/shots/35-B-got-image.png, script /tmp/wtest/s35.js
Note: as a user this is convenient; it contradicts the written goal, so it needs a decision, not a silent ship.

## Major

**M1 [Major, bug] Threshold brush ignores the image: it paints everything if the range contains 0 and nothing otherwise**
Steps: 1. Open the phantom (inside 140..300, outside -1000). 2. N (new segment), T. 3. Default range -350..300: click fully outside the phantom. 4. Set Lower to 200 (range 200..300), click on the centre (values 231..300).
Expected: step 3 paints 0 voxels; step 4 paints the whole dab.
Actual: step 3 paints the full dab on -1000 voxels; a stroke across the edge painted 119 voxels outside. Step 4 paints nothing. Table measured: ranges [-350,300] [-300,300] [0,300] [-1000,0] [-1000,250] paint everything everywhere; [1,300] [50,300] [150,300] [-1000,-500] paint nothing anywhere.
Evidence: /tmp/wtest/shots/10-threshold-stroke.png, /tmp/wtest/shots/11-thr-edge-drag.png, scripts /tmp/wtest/s11.js, s13.js

**M2 [Major, bug] Crosshair tool does nothing**
Steps: 1. Open image. Crosshair is selected; the bar says "Click to move all views to a point." 2. Click, slow-click, or drag in axial, sagittal or coronal.
Expected: the other two views jump to that point and the lines move.
Actual: lines stay centred, slice numbers do not change (23/23/24 before and after).
Evidence: /tmp/wtest/shots/08-crosshair-click.png, /tmp/wtest/shots/08-crosshair-3.png

**M3 [Major, bug] After the Pan tool has been used once, the Zoom tool and the Window/Level tool pan instead**
Steps: 1. Open image. 2. H, drag in axial. 3. Z, drag up/down in axial. (Or W, drag.)
Expected: zoom changes / window changes.
Actual: zoom stays 100 %, W/L unchanged, the image slides. Stays broken after switching to other tools and back; in a fresh load both tools work. Right-drag W/L and Ctrl+scroll zoom still work. 4 repros.
Evidence: /tmp/wtest/shots/08-wl-after-pan-zoomtool.png, /tmp/wtest/shots/08-wl-after-fit2.png, /tmp/wtest/shots/14-coronal-nav.png

**M4 [Major, bug] Opacity slider, "Outline only" (and O), and X (hide mask) do not change the picture**
Steps: 1. Open image + mask. 2. Tick "Outline only"; or drag Opacity to 95 % or 10 %; or press X. 3. Wait; move the mouse over the view; scroll a slice and back.
Expected: the overlay changes at once.
Actual: nine consecutive screenshots are identical. The pending setting only appears after an unrelated mask event (hiding a segment, a brush stroke), so the checkbox and the image regularly disagree (box unticked, outlines shown).
Evidence: /tmp/wtest/shots/20-montage.png, /tmp/wtest/shots/21-montage.png

**M5 [Major, bug] "Open image" with the scan and the mask both selected opens only the first file**
Steps: 1. Empty app, click "Open image" (the dialog allows multiple files). 2. Select phantom_ct.nii and phantom_seg.nii.
Expected: scan with mask, as drag-and-drop does.
Actual: only the scan; "No segments yet"; no message. If the mask sorts first, the mask is opened as the scan (black views, W 1 L 1). Drop of the same two files works.
Evidence: /tmp/wtest/shots/03-opened.png, /tmp/wtest/shots/04-chooser-both-rev.png

**M6 [Major, bug] Undo of "Delete segment" brings it back as "Segment N" with the default colour and unlocked**
Steps: 1. Rename segment 1 to "Liver", set colour #EE3377, lock it. 2. More > Delete. 3. Ctrl+Z.
Expected: "Liver", pink, locked.
Actual: "Segment 1", #E69F00, unlocked. Voxels are restored. Also: Redo of the delete then clears the voxels but leaves the empty row.
Evidence: /tmp/wtest/shots/19-undo-delete-name.png

**M7 [Major, bug] You can paint into a hidden segment, or with the whole mask hidden, and see nothing**
Steps: 1. Hide segment 1 (eye). 2. Select it, B, drag. Or: press X, then drag with the brush.
Expected: refuse with a short message, or show the segment again.
Actual: 280 voxels written invisibly; only the "Unsaved changes" text changes.
Evidence: /tmp/wtest/shots/18-paint-hidden.png, /tmp/wtest/shots/19-x-hidden.png

**M8 [Major, bug] Joining or re-joining a room throws away local unsaved edits without asking, and the state reads "Synced"**
Steps: 1. A and B in a room. 2. B: Leave room. 3. B paints (status "Unsaved changes"). 4. B: Join the same room again.
Expected: a question ("Your changes since leaving will be replaced").
Actual: B's mask is replaced by the room's mask with no dialog; B's strokes are gone, undo is empty, status "Synced".
Evidence: /tmp/wtest/shots/34-B-rejoin.png, script /tmp/wtest/s34.js

**M9 [Major, confusing] When someone else deletes the segment I am painting, nothing tells me and my next stroke goes into another label**
Steps: 1. A paints with segment 1 "Liver". 2. B deletes segment 1. 3. A drags again.
Expected: a message on A ("Ben deleted Liver") and no active segment until A picks one.
Actual: no toast on A; A's active segment silently becomes "Tumour"; A's stroke adds 242 voxels to Tumour. A cannot undo B's delete.
Evidence: /tmp/wtest/shots/32-A-after-B-delete.png

**M10 [Major, bug] "Fit" also jumps to the middle slice**
Steps: 1. Scroll axial to slice 30. 2. Z, drag to zoom. 3. Click "Fit".
Expected: zoom and position reset, same slice.
Actual: slice goes back to 24 (2 of 2).
Evidence: /tmp/wtest/shots/07-fit.png

**M11 [Major, confusing] Double-click with a paint tool maximises the view and the two dabs paint nothing**
Steps: 1. B. 2. Double-click (two quick dabs) on the image.
Expected: two dabs; layout unchanged while a paint tool is active.
Actual: view maximises, 0 voxels painted (3 of 3). On case forty this will happen by accident all day.
Evidence: /tmp/wtest/shots/26-after-dblclick.png

**M12 [Major, missing vs GOAL] No interpolation between slices, no CT window presets, no layout switch**
The rail and the ? sheet have no interpolation tool (AC-5). Window/Level has W, L and Reset only: no brain / soft tissue / lung / bone (AC-9). The layout is always 2x2; the only change is maximise (AC-8 "switching layout").
Evidence: /tmp/wtest/shots/02-empty-help.png, /tmp/wtest/shots/06-bar-Window_Level.png

**M13 [Major, confusing] Brush "Size … mm" is the radius, and there is no one-voxel brush**
Size 1 paints 2x2 voxels, size 8 paints 16 across, size 10 sphere spans 21 slices. With 1 mm voxels the smallest dab is 4 voxels; at size 1 some clicks painted 0 voxels (seen once: two clicks at one spot, nothing). The slider stops at 60 but the field accepts 100. No size change on the scroll wheel (Shift/Alt+scroll just change slice).
Evidence: /tmp/wtest/shots/09-brush-hover.png, script /tmp/wtest/s10.js output

**M14 [Major, bug] Uncaught exceptions when a second image is opened in the same session**
Steps: 1. Drop a scan (+mask). 2. Drop another scan (+mask), same or different size.
Expected: no errors.
Actual: 22 page errors each time (4 of 4 sequences): 20x `Cannot read properties of undefined (reading '0')`, 2x `t.extent is not iterable`. The new case renders and painting works afterwards. Drops were synthetic DataTransfer events; Ctrl+O replacement in another run logged none.
Evidence: script /tmp/wtest/s42.js, /tmp/wtest/shots/42-phantom-then-aniso.png

**M15 [Major, bug] Escape during a scissors drag does not cancel it**
Steps: 1. S, Sphere, Fill inside. 2. Press and drag. 3. Press Escape, release.
Expected: nothing applied.
Actual: 316 voxels are written and the tool has changed to Crosshair. In general Escape always switches the tool to Crosshair, so a habitual Escape loses the brush.
Evidence: script /tmp/wtest/s10.js ("scissors Escape mid-drag then release")

**M16 [Major, measured in headless] A click on one side reaches the other side after about 730 ms**
Three single brush clicks on A, B polled every 20 ms: 735, 720, 735 ms. Target in GOAL is 300 ms. Software rendering in one process; re-measure on real hardware.

## Minor

- **m1 [bug] Error messages do not name the file and stay until dismissed.** "This file is not a supported image…", "This is not a valid NIfTI file." (also for a 0-byte file), "…it should hold 221184 bytes of image data but has 4648". Dropping pair + notes.txt gives an error with no file name. Error toasts stack over the image and never time out. /tmp/wtest/shots/05-mask-is-ct.png, /tmp/wtest/shots/22-resize-480x360.png
- **m2 [confusing] Opening the next case resets the tool to Crosshair, window/level and active segment** (brush size is kept). Costs B + a W/L drag on every case. Script /tmp/wtest/s41.js
- **m3 [bug] F2 only works while a segment row has keyboard focus.** After renaming with Enter, focus is on the page; F2 does nothing and typing the name fires tool shortcuts ("Liver" left me on Ruler). F2 is in the row menu but not in the ? sheet. Script /tmp/wtest/s17.js
- **m4 [bug] X then X again sets opacity to 50 %** whatever it was before (was 100 %).
- **m5 [confusing] Lock** protects a segment from other segments' brush, eraser and scissors (good) but you can still paint with the locked segment itself. Lock is shared in a room; Hide is not.
- **m6 [note] Adding, renaming and recolouring a segment are not undoable**; Ctrl+Z skips them silently.
- **m7 [bug] Ruler.** A ruler drawn in sagittal/coronal shows up in axial as a stub with a different length ("3.05 mm" for a 24.4 mm line), seen once: /tmp/wtest/shots/07-ruler-3planes.png. A single click leaves a "0 mm" ruler (/tmp/wtest/shots/17-colour.png). No way to remove one ruler; Ctrl+Z and Delete ignore rulers.
- **m8 [a11y bug] Arrow keys always change slice**, also inside the open file menu, the tool radiogroup and the segment listbox, so none of those can be walked with arrows. Space on a focused tool button fires "last tool" instead of pressing it. Opacity slider shows no focus ring. "Hide" / "Lock" buttons have the same label on every row.
- **m9 [confusing] Segment colours repeat after 12** (segment 13 = segment 1, 26 = 2), and selecting a segment that is off-screen in the list does not scroll it into view. /tmp/wtest/shots/22-resize-1024x640.png
- **m10 [confusing] Ctrl+S with no mask and no segments downloads an empty "phantom_ct_mask.nii.gz"** and says "Saved".
- **m11 [confusing] A mask dropped alone on the empty app opens as the scan**; there is no "Open mask" before a scan is open and no hint.
- **m12 [missing] Segment names and colours are not kept.** Rename to "Liver", save, reopen: "Segment 1". Forty times a day.
- **m13 [confusing] "Show only this"** toggles back on second use but keeps the same label.
- **m14 [confusing] Fill** on an open (not enclosed) area or on existing mask does nothing and says nothing.
- **m15 [confusing] Rooms.** The invite "link" is `ws://localhost:8787/r/CODE`, not something a person recognises as a link; two people can both be "Ana" (two identical "A" badges); while one side was offline both still showed "Synced" (seen once, emulated offline); clicking a person's badge does not take you to their slice.
- **m16 [confusing] "Slice 18 / 48" is Z 31** in the status bar; two numbers for one position.
- **m17 [confusing] File menu "Close"** closes the case, not the menu; "Save mask…" has an ellipsis but asks nothing.
- **m18 [wording] "It was resampled to fit" / "position data differs… placed on the image grid"** are not annotator words, and these warnings vanish after a few seconds while the mask they describe stays.
- **m19 [note] Saving an untouched .nii.gz changes 23 header bytes** (offsets 48–311; voxel data identical). Fine for my minimal header, but check "geometry unchanged" against real files.
- **m20 [note] Wheel during a stroke changes slice mid-stroke.**

## Polish

- Window title is always "W Annotator"; no file name or unsaved mark.
- After undoing every edit the status still says "Unsaved changes".
- Three identical "A mask can hold up to 255 segments." toasts stack.
- At 480x360 the segments panel squeezes the four views to 83 px; no minimum size or auto-collapse.
- The 3D view draws segments as flat dark silhouettes; hard to read as 3D.
- "Share" is offered on the empty app with "Start a room" available before any image is open (not tried further).
- Replace/Close confirm offers Cancel / Replace only; no "Save and continue".

## Dead ends

- D1 After M3, a new user who clicks Pan once has no working Zoom or Window/Level tool for the rest of the session and nothing explains why (right-drag and Ctrl+scroll are the way out, if you read the ? sheet).
- D2 Interpolation: looked in the rail, the tool bars, the segment menu and the ? sheet; it is not there.

## Console and network errors

- `Cannot read properties of undefined (reading '0')` x20 and `t.extent is not iterable` x2 — every time a second image was dropped (M14).
- `WebSocket connection to 'ws://localhost:9/r/ABCDEF?name=Cy' failed: net::ERR_UNSAFE_PORT` — my deliberate bad address; the app showed "Can't connect. Check the address and your network, then try again."
- No failed network requests. No errors in any other flow, including bad files, 255 segments, 60 rapid strokes, 100 tool switches.

## Worked without thinking

- Empty screen: one sentence, one blue button, drop target highlights ("Drop to open").
- Drag-and-drop of scan + mask in any order; NIfTI, .nii.gz, MHA, NRRD all open with the same voxel counts; L/R/A/P/S/I markers on all three planes and RAS vs LPS fixtures land on the correct sides.
- Bad files: every one gave a readable message, no crash, app still usable.
- Tool bar shows the tool name plus one line of what it does; tooltips carry the key ("Brush  B"); paint tools explain "Add a segment to start editing." when there is none.
- Brush / eraser / scissors (rectangle, circle, sphere; erase, fill) / fill-a-hole all work in axial, sagittal and coronal; a one-step fast stroke leaves no gaps; brush ring shows the real footprint.
- Undo/redo: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, buttons, toast "Undo"; 70 single steps deep, exact restore; undo with nothing to undo is silent and harmless.
- N adds a segment and switches to Brush; 1–9; Space for last tool; [ ]; scroll and arrows change slice with any tool; middle-drag pan and right-drag window with any tool.
- "Unsaved changes" text + dot by the mask name; Replace/Close ask first; reload asks first; save keeps name and format.
- Rooms: name + code or link is all it takes; clear errors for a wrong code, empty field, unreachable server and "The room is working on a different image"; remote cursor with name and "+5" slice offset; per-person undo; non-overlapping simultaneous edits, different slices, renames, adds, colour and lock all arrive; a third person joining mid-stroke converges; the room survives the starter closing the tab; a dropped client catches up.
- Calm: nothing animates on the image, no unsolicited tips.

## Annotator view (persona: .claude/agents/annotator-user.md)

```
ANNOTATOR VERDICT: REJECT (for now)

Got stuck
1. Open image dialog — picked scan and mask together, got only the scan — open both, like drop does.
2. Threshold brush — expected it to stay inside the bright area — it paints everything or nothing.
3. Opacity / Outline only — moved them, nothing happened — I thought the mask was broken.
4. After using the hand tool, zoom and contrast tools just move the picture.
5. Looked for "copy to next slice / interpolate" — not there, so I redraw every slice.

Slows me down every case
1. Next case: tool goes back to Crosshair and contrast resets — 1 key + 1 drag each case — keep my tool and window.
2. Label names: retype "Liver", "Tumour" on every case — should be remembered or loaded.
3. Smallest brush is 2x2; edges need single-voxel fixes — add size 0.5 / one voxel and size on the wheel.
4. Two quick dabs maximise the view — 1 extra key (M) each time it happens.
5. Escape drops me to Crosshair — 1 key to get the brush back.
6. No erase-while-holding-a-key; E and B back and forth (Space helps).

Words I did not understand
- "resampled to fit" — say "The mask is a different size; it was stretched/placed to match the scan."
- "position data differs… placed on the image grid" — say "This mask may not line up with the scan. Check it."
- "bytes of image data" — say "The file is cut short."
- "ws://localhost:8787/r/…" — show just the code; hide the address.
- "Server" (room dialog) — fine collapsed, but the placeholder wss://rooms.example.org means nothing to me.

Liked
- Drop two files and start. Key on every tooltip. Fill closes a hole in one click. Lock stops me painting over
  the neighbour. Undo always works. "Unsaved changes" is always visible. Seeing "Ana +5" tells me where she is.

Time to correct one typical case, as I see it: drop pair (1), B (1), pick label (1), set contrast (1 drag),
fix ~10 slices by hand with no interpolation (10 x (scroll + 2-3 strokes)), Ctrl+S (1), then find the download.
About 3-4 minutes, most of it redrawing slices; under 2 with interpolation and remembered tool/contrast/labels.
```

## The 10 changes that would most speed up bulk mask correction (no AI)

1. Interpolate / copy the active segment between slices (one key), so a shape is drawn every 3–5 slices, not every slice.
2. Keep tool, brush size, window/level, zoom mode and label names/colours from one case to the next; add a "next case" action (open the next pair in the folder, asking to save first).
3. Fix the threshold brush (M1) so an edge can be followed without painting outside it.
4. Brush size on Ctrl/Shift+scroll, a true one-voxel size, and one agreed meaning for "Size" (diameter).
5. Hold a modifier (or right-button) to erase with the brush, so B/E switching disappears.
6. Do not maximise on double-click while a paint tool is active; keep M and the corner button.
7. Make Opacity / Outline / X apply instantly (M4) and block or reveal painting on hidden labels (M7); these are the "check my edge" loop.
8. Open scan + mask together from the dialog (M5) and remember segment names per study (sidecar or a label list file).
9. Window presets on keys and a working Fit that keeps the slice (M10, M12); fix Zoom/W-L after Pan (M3).
10. Save feedback that names where the file went, plus "save and next"; in rooms, make "Synced" true (B1) and warn before a join replaces local work (M8).
