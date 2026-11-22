# W Annotator — Design Spec

Desktop (Tauri + React), dark-first, built on Cornerstone3D. This document is the source of truth for layout, tokens, components, motion and copy. `Mod` means ⌘ on macOS and Ctrl elsewhere.

Assumptions to confirm with engineering are marked **[assumption]**.

---

## 1. Principles

1. **The image is the interface.** Viewports take every pixel that chrome does not strictly need. Viewport backgrounds are pure black; chrome is quieter than the image.
2. **One thing at a time.** Only the active tool's options are visible. Everything else is one click or one key away, never on screen by default.
3. **Nothing moves unless you moved it.** Tool changes, toasts and presence never reflow or resize a viewport. The image is never animated, faded, or scaled by the UI.
4. **Colour belongs to the data.** Chrome is neutral grey with a single accent. Saturated colour is reserved for segments and collaborators.
5. **Say it plainly.** Short labels, real units (HU, mm, %), no jargon the reader did not bring with them.

---

## 2. Layout

Minimum window 1024 × 640. All sizes in CSS px.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TOP BAR  44                                                              │
├────┬──────────────────────────────────────────────────────┬──────────────┤
│    │ TOOL OPTIONS STRIP  40                               │              │
│ T  ├──────────────────────────┬───────────────────────────┤  RIGHT PANEL │
│ O  │ Axial                    │ Sagittal                  │  264         │
│ O  │                          │                           │  Segments    │
│ L  ├──────────────────────────┼───────────────────────────┤              │
│ 48 │ Coronal                  │ 3D                        │              │
│    │                          │                           │              │
├────┴──────────────────────────┴───────────────────────────┴──────────────┤
│ STATUS BAR  26                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

CSS grid on the app shell:

```css
.app {
  display: grid;
  grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--panel-w);
  grid-template-rows: var(--topbar-h) var(--strip-h) minmax(0, 1fr) var(--status-h);
  grid-template-areas:
    "top   top   top"
    "rail  strip panel"
    "rail  view  panel"
    "stat  stat  stat";
  height: 100vh; background: var(--bg-app);
}
.app[data-panel="closed"] { --panel-w: 0px; }
```

### 2.1 Top bar — 44 high, `--bg-surface`, bottom border

Left to right. The bar is the window drag region (`data-tauri-drag-region`); every control inside opts out. On macOS with overlay title bar, pad left 78 for the traffic lights.

| Slot | Content | Size |
|---|---|---|
| Left | **File name** button: `chest_ct_014.nii.gz` + unsaved dot (6px, `--text-2`). Opens the File menu. Mask name follows in `--text-3` after a `·`. Truncate middle, max 320 wide. | 28 high |
| Centre | **Layout switcher**: 5-option segmented icon control — 2 × 2, 1 large + 3 stacked, 3 side by side, 2 side by side, Single. Each icon is the layout drawn small. Centred on the bar, whatever is to its left and right. `Mod+1` … `Mod+5`, rebindable. | 28 high, 32 per segment |
| Right | **Avatar stack** (only when in a room) → **Room button** → **Panel toggle** (icon). | 28 high, 8 gap |

Room button: outside a room it is a secondary button labelled `Share`. In a room it becomes a tinted pill `● KDR-482` (green 6px dot = connected, amber = reconnecting) that opens the room popover.

File menu items: Open image… (Mod+O), Open mask… (Mod+Shift+O), Save mask (Mod+S), Save mask as… (Mod+Shift+S), Keyboard shortcuts (?), Appearance, Close.

Appearance is a row in the menu, not an item: the label `Appearance` and a three-way segmented control `Light` / `Dark` / `System`. Choosing one applies at once and leaves the menu open. Default is System, which follows the operating system live. See 3.2.

### 2.2 Tool rail — 48 wide, `--bg-surface`, right border

Icon buttons 36 × 36, 6px inset, 2px gap, icons 18px with 1.5px stroke. Three groups separated by a 1px divider with 6px margin. Tooltip opens to the right after 400 ms (immediately if another tooltip was shown within the last 300 ms).

| Group | Tool | Key |
|---|---|---|
| Navigate | Crosshair | C |
| | Pan | H |
| | Zoom | Z |
| | Window / Level | W |
| Edit | Brush | B |
| | Eraser | E |
| | Threshold brush | T |
| | Scissors | S |
| | Fill | F |
| Bottom (pinned) | Undo | Mod+Z |
| | Redo | Mod+Shift+Z |

Edit tools are disabled until a mask exists (opening an image with no mask creates an empty mask on first use of `Add segment`).

### 2.3 Tool options strip — 40 high, `--bg-surface`, bottom border

Always present at a fixed height so switching tools never resizes a viewport. Left: tool name in `--text-2` (13/500), then a 1px divider, then that tool's controls with 16 gap. Tools without options show a one-line hint in `--text-3` instead.

| Tool | Controls (left to right) |
|---|---|
| Crosshair | Hint: `Click to move all views to a point.` |
| Pan | Hint: `Drag to move the image.` |
| Zoom | Hint: `Drag up or down to zoom.` + `Fit` button |
| Window / Level | Preset select (the same list as the window menu in the status bar, 2.6; `Custom` when the window is no preset) · `W` number · `L` number · `Reset` (the Auto window) · hint `Ctrl-drag a box to set the window from it.` (`⌘-drag` on a Mac; the hint is shown whole or not at all: where it has no room it becomes the tooltip of the `W` and `L` fields, shown on hover and while either field has the focus). Ctrl-drag (⌘-drag) on a slice view draws a box, a dashed white line with a dark edge in the layer the scissors outline uses; on release the window becomes the 1st–99th percentile of the values under it on that slice. Esc drops the box. Nothing is written. On a trackpad a two-finger scroll changes the level (up and down) or the width (sideways) instead of the slice; Shift+scroll changes slice. |
| Brush | Size slider 1–100 px + number · Shape segmented `Circle / Sphere` · Paint over segmented `Everything / Empty only / Only…` (default Everything on each launch; with Empty only a stroke never takes voxels from another segment; `Only…` is a list of the other segments set into the control as its third choice, and with one chosen a stroke stays inside that segment). Erasing is never limited. Below 1440 wide the slider and hint give way, then the field labels, then Paint over becomes one list with the same choices, so nothing is cut off. · `Fill between slices` button, with that one name at every width. |
| Fill preview (any tool) | While a fill between slices is shown and not yet done, the strip holds only: `Preview: 1.2 mL between axial slices.` · primary `Apply` · secondary `Cancel`. The proposal is drawn on the slice views as diagonal stripes of the segment colour at two strengths, with no outline, from a buffer that is not the mask. Enter applies, Esc cancels; choosing another tool or segment, painting, undo, redo or saving cancels with a toast. Scrolling, zoom and window work as usual. |
| Eraser | Size slider + number · Shape `Circle / Sphere` · Checkbox `Active segment only` |
| Threshold brush | Range dual slider + two numbers (image units) · Size slider + number · Paint over select (`Everything`, `Empty only`, `Only <segment>` for each other segment) |
| Scissors | Shape `Rectangle / Circle / Freehand / Sphere` · Action `Erase inside / Erase outside / Fill inside` (no Erase outside for Sphere) · Depth `This slice / All slices` (not for Sphere) · Paint over select, only with Fill inside. Freehand: drag a loop, release to close it; where it crosses itself the even-odd rule decides. The outline being drawn is a dashed white line with a dark edge, in a layer over the view. Esc while dragging drops it. Erasing changes the active segment only. A cut that changed something not on screen answers with a toast and Undo: a cut through all slices, and Erase outside on one slice when part of what it erased was beyond the edge of the view. |
| Fill | Action `Fill area / Remove island / Keep island` · Paint over select, only with Fill area · hint for the action. An island is a piece of the active segment joined through voxel faces, in 3D. |

**When the strip is tight.** The strip never scrolls, wraps or cuts a control off, and it never shortens a word: one control has one name at every width. It tightens in steps, each tried before the frame is painted, until its controls fit:

| Step | What gives way |
|---|---|
| 1 | Hints and field labels. A hint that names a gesture (Window / Level) becomes a tooltip instead of going. |
| 2 | Gaps close to 8, units go, and a segmented control with three or more options (Scissors shape and action, Fill action, the brush's Paint over) becomes a list: a `select` with the same accessible name and the same options in full. |
| 3 | Every segmented control becomes a list, sliders go (the number fields stay), and the chip keeps only its swatch. |

A list made this way shows the option in use, is at most 132 wide, and gives the keyboard back to the tool shortcuts after a choice. At 1024 wide the scissors strip reads `Freehand ▾ · Erase outside ▾ · This slice / All slices`. Do not add a control to the brush strip without removing one.

The chip names the paint over limit for tools that add voxels: `Tumour, inside Liver` or `Tumour, empty only`.

Alt-click on a slice view, with any tool, makes the segment under the cursor the active one. Its row scrolls into view and is tinted once (`--accent-soft`, 600 ms, as a new row). Hidden segments are not picked; nothing is painted.

Right edge of the strip, always: active segment chip (swatch + name), so the user always knows what they are painting. Click focuses the segment list.

### 2.4 Viewport grid — fills the rest, `--bg-app`

- 2 × 2, equal cells, 2px gap showing `--bg-app`. Each cell is `#000`.
- Order: Axial (top-left), Sagittal (top-right), Coronal (bottom-left), 3D (bottom-right).
- Active viewport: 1px inset outline `--accent`. Hovered: 1px inset `--border-strong`. Otherwise none.
- Corner overlays, 8px inset, 11px mono, `--text-2` with a 1px black text shadow, `pointer-events: none`. The view name and the slice counter each sit on a chip of `--bg-label`, 20 high, 4px padding left and right, radius 4, so they stay readable over a bright or noisy image: `--text-2` keeps 4.5:1 on it even over a white pixel. The chip is no larger than its text needs, is the same in both themes, and never fades or moves:
  - top-left: orientation name (`Axial`) — coloured dot matches the reference line colour for that plane. It is a button: it opens the view picker (Axial, Sagittal, Coronal, 3D), and dragging it onto another pane swaps the two
  - top-right: maximise button (24 × 24, appears on viewport hover or focus only)
  - bottom-left: `Slice 84 / 212`
  - edge midpoints: orientation letters `A P R L S I`, `--text-3`
- **Double-click** a viewport (or press `M`) to maximise; same again, or `Esc`, restores. With an edit tool active, double-click is still maximise — strokes start on pointer move, not on click.
- Scroll = slice. Mod+scroll = zoom. Middle-drag = pan. Right-drag = window/level. These work regardless of the active tool. With the Window / Level tool only: a two-finger trackpad scroll is the window, and Mod-drag is a box to take the window from.
- Trackpad: two-finger scroll = slice, in proportion to distance (or pan, by a setting); pinch = zoom about the pointer. Shift+scroll = five slices at a time. Alt+scroll = brush size while a brush tool is active. In the 3D view scroll and pinch zoom. A sideways swipe does nothing. The window itself never scrolls or zooms.
- The brush cursor is a 1px ring in the active segment colour with a 1px black halo.
- Focus layout: the first pane takes the left 3/4; the other three stack in the right 1/4.

**Layouts.** Five layouts: 2 × 2 (default), 1 large + 3 stacked, 3 side by side, 2 side by side, single. The view order (default Axial, Sagittal, Coronal, 3D) fills the panes in reading order; a layout with fewer panes leaves the last views off screen. Any pane can show any view: picking a view that is on screen elsewhere swaps the two, so a view is never shown twice. Maximise shows one view alone and restores the layout afterwards; picking a layout also leaves maximise. The layout and the order are kept between launches; maximise is not.

- Panes are rectangles in whole pixels, computed in `src/viewer/layout.ts` and set on each pane by script. No pane is sized by CSS grid or flex: webviews resolve those differently (in WebKit the old maximise, a spanning grid cell beside hidden ones, came out as a strip).
- Changing layout, swapping and resizing never change what a view shows: same slice, same window, same **millimetres per screen pixel**, same point at the centre. A larger pane shows more around the image, not a bigger image. `Fit` is the way to fill a pane.
- Maximise is the exception, because a bigger image is what it is for. The image grows by as much as an image fitted to the pane would: a fitted image stays fitted, a zoomed one stays as far zoomed in. Slice, window and the point at the centre stay. Restoring shrinks it by the same amount, so a view that was not touched while maximised comes back exactly as it was. While a view is maximised, resizing the window or the panel keeps millimetres per pixel as everywhere else.
- A view that is off screen is not drawn. It keeps its slice and zoom and follows jumps made meanwhile.

**Reference lines.** Each plane shows two thin lines, one for each of the other planes on screen, in that plane's colour. They leave a 24 px gap around the point where they would cross and stop 28 px short of the pane's edge, clear of the orientation letters. Dragging a line scrolls the plane it stands for. The planes stay orthogonal: there is no rotation handle and no oblique reslice (rotating a plane makes left and right easy to mistake).

- Setting `Show reference lines`: `Always` / `On hover` (default: while the pointer is over the views) / `With crosshair tool only`. The crosshair tool always shows them.
- With the crosshair, pan, zoom or window tool a line can be dragged. With the ruler or an edit tool the lines are display only, so a stroke that starts on a line is still a stroke.

### 2.5 Right panel — 264 wide, `--bg-surface`, left border, collapsible (Mod+\\)

Above Segments sits **Files**, a section that folds to its 36 px heading: one 28 px row for the image, then one per mask. A mask row starts with a radio mark (filled: the mask being edited), then a type icon, the short name (full name and size in the tooltip, an accent dot when unsaved), and on hover an eye and a `…` menu. Masks that are not being edited are drawn as 2 px outlines in one neutral colour each (white, pale blue, pale pink); the row's icon shows that colour on black.

```
┌ Segments                        [+] ┐  header 40
├─────────────────────────────────────┤
│ ■ 1  Liver                    👁 🔒 │  rows 32
│ ■ 2  Tumour                   👁 🔒 │
│ ■ 3  Segment 3                👁 🔒 │
│  …scrolls                           │
├─────────────────────────────────────┤
│ Opacity            ━━━━━●━━━   60%  │  footer 96, pinned
│ ☐ Outline only                      │
└─────────────────────────────────────┘
```

- Header: title `Segments` (13/600) and an `Add segment` icon button.
- List scrolls; footer is pinned and holds the two mask-wide display settings: Opacity (0–100 %, default 60) and `Outline only`.
- Row context menu (right-click or `⋯` on hover): Rename, Change colour, Show only this, Go to segment · group `Refine`: Grow…, Shrink…, Smooth…, Fill holes, Keep largest island, Remove small islands…, Split into separate segments · Combine…, Measurements · Clear, Delete. Items ending in `…` swap the menu for a small popover with the segment name, one number field (mm, or mm³ for islands; the last value is remembered), `Cancel` and `Apply`. Combine shows a segment picker and `Add`.
- Each row shows the segment's volume at the right in 11px mono `--text-2` (`12.4 mL`; `320 mm³` under 0.5 mL; nothing when empty). It updates shortly after edits stop and gives way to the row actions on hover and focus.
- Measurements sheet (wide modal): table of Segment, Volume, Voxels, Mean ± SD, Min, Max for every segment, a one-line note, `Copy as CSV` and `Done`. Intensities carry no unit.
- Empty: `No segments yet.` + text button `Add segment`.

### 2.6 Status bar — 26 high, `--bg-surface`, top border

11px mono, tabular numerals, `--text-2`, items 16 apart. Values update live under the pointer; show `—` when the pointer is outside a viewport. Each item has a fixed min-width so the bar does not jitter.

Left: `Slice 84 / 212` · `X 212  Y 148  Z 84` · `Value −412 HU` · `Segment Liver`
Right: `W 400  L 40  Soft tissue` · `Zoom 125%` · sync status (`Saved`, `Unsaved changes`, or in a room `Synced` / `Reconnecting…`)

**Window and zoom are buttons.** Each is the read-out itself with a 10 px chevron: 20 high, `--bg-hover` on hover and while open, the bar's inset focus ring. A click, Enter or Space opens a menu (`--bg-raised`, `--shadow-2`, 13px UI font) above the bar with its right edge on the button's; it fades in from 4px below, scrolls inside itself when taller than the room above the bar, and closes on a choice, Esc or a click elsewhere. Focus goes to the item in use; ↑ ↓ Home End move through the items; Esc gives the focus back to the button. Both work with any tool.

- **Window menu.** Row `Presets for` with a segmented `CT / MR` (set from the image's values; the user can overrule it). Then the presets as radio items, each with its `W … L …` at the right in 11px mono `--text-3` (`--text-2` on the item in use, focused or pointed at, where `--text-3` is under 4.5:1), the one in use on `--bg-active`. CT list: Soft tissue, Abdomen, Liver, Pancreas (a narrow window chosen by the project for a contrast-enhanced pancreas, not a standard preset), Lung, Bone, Brain, Stroke, Subdural · saved presets · Auto, Full range. MR list: Auto, Full range · Mid range, Bright fluid, Dark detail (worked out from the image; none shares a name with a CT preset) · saved presets. A saved preset has a 20 px `×` at the end of its row (`Remove preset <name>`); removing keeps the menu open. Last item: `Save current as preset…`.
- **Save dialog.** Small modal `Save window as preset`: the window in mono (`W 1600 L −550`), one `Name` field (24 characters), `Cancel`, primary `Save`. Enter saves. A name in use, an empty name or a full list (12) shows the reason in `--danger` under the field.
- **Zoom menu.** `Zoom in`, `Zoom out` (the menu stays open for these), divider, `Fit`, `Actual size`, each with its key at the right. They act on the active view, about its centre. Actual size is one voxel on one screen pixel and is disabled for the 3D view.
- The read-out shows the name of the preset in use in `--text-1`, and no name when the window is none of them. On a narrow bar the name is the first thing to leave; the window itself never leaves.

### 2.7 Empty state (no image open)

Rail, strip, right panel and status bar are hidden; only the top bar (app name, no switcher) and one centred block remain.

```
            ┌─────────────────────────────────────────────┐
            │                                             │
            │                  [ icon 32 ]                │
            │                                             │
            │         Drop an image and a mask            │   20/600
            │   MHA, NIfTI, NRRD or a DICOM folder.       │   13, --text-2
            │   The mask is optional.                     │
            │                                             │
            │      [ Open image ]   [ Open mask ]         │
            │                                             │
            └─────────────────────────────────────────────┘
               Join a room · Open the sample · Settings      text buttons
                      Recent                                 up to 5 rows, if any
```

- Drop zone: 560 × 320 max (shrinks to 80 % of width), 1px dashed `--border-strong`, radius `--radius-lg`, centred.
- `Open image` is the primary button, `Open mask` secondary and disabled until an image is loaded.
- `Open the sample` opens the scan the welcome tour uses, without the tour, so someone who skipped the tour can still find it.
- Appearance: the same three-way control, icons only (sun, moon, monitor; 28 × 24 each), in the bottom-right corner, 12 from the edges. Tooltips: `Light appearance`, `Dark appearance`, `Match system appearance`.
- The whole window is the real drop target; the box is the affordance. Once an image is open, dragging a file over the app shows a full-window overlay: `Drop to add as mask` or `Drop to replace image`, decided by file type and dimensions.

---

## 3. Design tokens

```css
:root {
  color-scheme: dark;

  /* ── Neutrals (dark) ─────────────────────────── */
  --bg-viewport:   #000000;   /* image background, always */
  --bg-app:        #0A0B0D;   /* gaps, window */
  --bg-surface:    #121417;   /* bars, rail, panel */
  --bg-raised:     #1A1D21;   /* inputs, menus, modals, toasts */
  --bg-hover:      #22262B;
  --bg-active:     #2A2F36;
  --bg-scrim:      rgba(0, 0, 0, 0.56);
  --bg-label:      rgba(0, 0, 0, 0.78);  /* behind text on the image; both themes */

  --border:        #24282E;
  --border-strong: #363C45;

  --text-1:        #E7E9EC;   /* primary */
  --text-2:        #A6ADB7;   /* secondary, icons at rest */
  --text-3:        #808894;   /* hints, placeholders */
  --text-disabled: #555C66;
  --text-on-accent:#0A0B0D;

  /* ── Accent (one) ─────────────────────────────── */
  --accent:        #5B9DFF;
  --accent-hover:  #7AB0FF;
  --accent-press:  #4A86E0;
  --accent-soft:   rgba(91, 157, 255, 0.14);  /* selected fills */
  --accent-ring:   rgba(91, 157, 255, 0.55);

  /* ── Status ───────────────────────────────────── */
  --ok:            #4CC38A;
  --warn:          #E5B454;
  --danger:        #F2716B;
  --danger-soft:   rgba(242, 113, 107, 0.14);

  /* ── Segment palette (see 3.1) ────────────────── */
  --seg-1:  #E69F00;  --seg-2:  #56B4E9;  --seg-3:  #F0E442;
  --seg-4:  #EE3377;  --seg-5:  #009E73;  --seg-6:  #B58CFF;
  --seg-7:  #D55E00;  --seg-8:  #00D5C8;  --seg-9:  #FFAABB;
  --seg-10: #3D85F0;  --seg-11: #BBCC33;  --seg-12: #CC79A7;

  /* ── Presence palette (collaborators) ─────────── */
  --user-1: #7AB0FF;  --user-2: #F29E6B;  --user-3: #6FD3A3;
  --user-4: #E38BD0;  --user-5: #E5C45A;  --user-6: #8FD4E8;
  --user-7: #B9A2FF;  --user-8: #F28B8B;

  /* ── Type ─────────────────────────────────────── */
  --font-ui:   system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Menlo, Consolas, monospace;

  --text-xs:   11px;  --lh-xs:   16px;   /* status bar, viewport overlays, kbd */
  --text-sm:   12px;  --lh-sm:   16px;   /* tooltips, captions, field labels */
  --text-md:   13px;  --lh-md:   20px;   /* default UI text */
  --text-lg:   15px;  --lh-lg:   22px;   /* modal titles */
  --text-xl:   20px;  --lh-xl:   28px;   /* empty-state heading */
  --weight-regular: 400;  --weight-medium: 500;  --weight-semibold: 600;

  /* ── Spacing (4px base) ───────────────────────── */
  --space-1: 2px;   --space-2: 4px;   --space-3: 6px;   --space-4: 8px;
  --space-5: 12px;  --space-6: 16px;  --space-7: 24px;  --space-8: 32px;  --space-9: 48px;

  /* ── Layout ───────────────────────────────────── */
  --topbar-h: 44px;  --strip-h: 40px;  --status-h: 26px;
  --rail-w:   48px;  --panel-w: 264px; --view-gap: 2px;
  --control-h: 28px; --control-h-lg: 36px; --row-h: 32px;

  /* ── Radii ────────────────────────────────────── */
  --radius-xs: 3px;   /* swatches, kbd */
  --radius-sm: 6px;   /* buttons, inputs, rows */
  --radius-md: 8px;   /* menus, toasts, tooltips */
  --radius-lg: 12px;  /* modals, drop zone */
  --radius-full: 999px;

  /* ── Shadows (dark: mostly border + deep drop) ── */
  --shadow-1: 0 1px 2px rgba(0,0,0,.4);
  --shadow-2: 0 0 0 1px var(--border-strong), 0 8px 24px rgba(0,0,0,.5);          /* menus, toasts */
  --shadow-3: 0 0 0 1px var(--border-strong), 0 24px 64px rgba(0,0,0,.6);         /* modals */
  --focus-ring: 0 0 0 2px var(--bg-surface), 0 0 0 4px var(--accent);

  /* ── Z-index ──────────────────────────────────── */
  --z-viewport: 0;   --z-overlay: 10;  /* viewport labels, remote cursors */
  --z-chrome: 20;    --z-drop: 30;     --z-menu: 40;
  --z-modal: 50;     --z-toast: 60;    --z-tooltip: 70;

  /* ── Motion (see section 5) ───────────────────── */
  --dur-instant: 80ms;  --dur-fast: 120ms;  --dur-base: 160ms;  --dur-slow: 220ms;
  --ease-out:    cubic-bezier(0.2, 0, 0, 1);     /* things arriving */
  --ease-in:     cubic-bezier(0.4, 0, 1, 1);     /* things leaving */
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);   /* things moving */
}

/* Light theme. Viewports stay black: see 3.2. */
:root[data-theme="light"] {
  color-scheme: light;
  --bg-app: #E9EBEE;  --bg-surface: #F7F8F9;  --bg-raised: #FFFFFF;
  --bg-hover: #ECEEF1; --bg-active: #E1E4E8;  --bg-scrim: rgba(15,17,20,.32);
  --border: #DDE0E5;   --border-strong: #C4C9D1; --border-control: #7A828E;
  --text-1: #16181C;   --text-2: #4D545E;     --text-3: #5E6570;  --text-disabled: #A9AFB8;
  --text-on-accent: #FFFFFF;
  --accent: #1D58D8;   --accent-hover: #194BBA; --accent-press: #153F9C;
  --accent-soft: rgba(29,88,216,.10);
  --ok: #157A4C; --warn: #8F5B00; --danger: #C2332D; --danger-soft: rgba(194,51,45,.10);
  --shadow-1: 0 1px 2px rgba(16,18,22,.24);
  --shadow-2: 0 0 0 1px var(--border-strong), 0 8px 24px rgba(16,18,22,.14);
  --shadow-3: 0 0 0 1px var(--border-strong), 0 24px 64px rgba(16,18,22,.22);
}

body { font: var(--weight-regular) var(--text-md)/var(--lh-md) var(--font-ui); color: var(--text-1); }
.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
```

Approximate contrast on `--bg-surface` (dark): `--text-1` 15:1, `--text-2` 8:1, `--text-3` 5:1, `--accent` 7:1. `--text-disabled` is intentionally below 4.5:1. Re-measure if any value changes.

### 3.1 Segment palette

Built from the Okabe–Ito and Paul Tol colour-blind-safe sets, with greys, near-whites and near-blacks removed because they vanish against greyscale anatomy. The order alternates hue and lightness so that neighbouring indices (the ones most often used together) differ on both.

| # | Token | Hex | Name | # | Token | Hex | Name |
|---|---|---|---|---|---|---|---|
| 1 | `--seg-1` | `#E69F00` | Orange | 7 | `--seg-7` | `#D55E00` | Vermilion |
| 2 | `--seg-2` | `#56B4E9` | Sky | 8 | `--seg-8` | `#00D5C8` | Aqua |
| 3 | `--seg-3` | `#F0E442` | Yellow | 9 | `--seg-9` | `#FFAABB` | Pink |
| 4 | `--seg-4` | `#EE3377` | Magenta | 10 | `--seg-10` | `#3D85F0` | Blue |
| 5 | `--seg-5` | `#009E73` | Green | 11 | `--seg-11` | `#BBCC33` | Lime |
| 6 | `--seg-6` | `#B58CFF` | Violet | 12 | `--seg-12` | `#CC79A7` | Mauve |

Rules:
- New segments take the lowest unused index; after 12, cycle. Users can pick any colour from the 12 (no free colour picker in v1).
- Render fill at the mask opacity plus a 1px outline at 100 % in the same colour. The outline is what keeps a segment readable on bright bone or dark lung, and it is the cue that does not depend on hue.
- Colour is never the only identifier: every segment shows its index and name in the list, the strip chip and the status bar.
- This palette was chosen from published CVD-safe sets, not simulated against real scans. Run it through a deuteranopia/protanopia simulator on CT and MR samples before release; 12 categories is past the point where any palette is perfectly separable, which is why the outline and labels matter.

### 3.2 Appearance: light, dark, system

- Three modes: Light, Dark, System. System is the default and follows `prefers-color-scheme` live. The mode is kept in localStorage under `w-annotator:theme`; the resolved theme is `data-theme="light"` or `"dark"` on `<html>`, set by an inline script before first paint so the wrong theme never flashes. Logic lives in `src/state/theme.ts`.
- **The image is always on black.** `--bg-viewport` does not change, the 2px gaps between viewports stay dark (`--bg-view-gap`), and each viewport cell takes the dark tokens back, so orientation letters, corner text, the hover buttons and remote cursors keep their dark-image styling in both themes.
- Collaborator colours are light in both themes, so text on them uses the fixed `--text-on-user` (`#0A0B0D`), not `--text-on-accent`.
- In light, borders that mark a control (inputs, secondary buttons, slider tracks, the drop zone) use `--border-control` so they reach 3:1; `--border` and `--border-strong` are for dividers and shadows only. Swatches get a faint inner ring so pale segment colours do not vanish on white.
- Measured contrast in light (WCAG 2.x): `--text-1` 13.9–17.8:1, `--text-2` 6.0–7.7:1 and `--text-3` 4.6–5.9:1 across `--bg-app`, `--bg-surface`, `--bg-raised`, `--bg-hover` and `--bg-active`; `--accent` text 5.0–6.1:1 (including on `--accent-soft`); white on `--accent` 6.1:1; `--ok` 4.6–5.4:1, `--warn` 4.9–5.7:1, `--danger` 4.7–5.5:1; `--border-control` 3.0–3.9:1; focus ring 5.1–6.1:1. Re-measure if any value changes.
- In the desktop app the native window theme follows the mode (`setTheme`), so the title bar matches.

---

## 4. Component specs

Shared: every interactive element gets `:focus-visible { box-shadow: var(--focus-ring); outline: none; }`. Transitions on colour/background use `--dur-instant`.

### 4.1 Tool button (rail)

36 × 36, radius `--radius-sm`, icon 18px.

| State | Background | Icon | Other |
|---|---|---|---|
| Rest | transparent | `--text-2` | |
| Hover | `--bg-hover` | `--text-1` | |
| Pressed | `--bg-active` | `--text-1` | |
| Active tool | `--accent-soft` | `--accent` | 2 × 16 accent bar on the rail's left edge, radius 1 |
| Focus-visible | as current state | | `--focus-ring` |
| Disabled | transparent | `--text-disabled` | `aria-disabled`, tooltip still shows with the reason |

`role="radio"` inside a `role="radiogroup" aria-label="Tools"` (Undo/Redo are plain buttons). Tooltip: `--bg-raised`, `--shadow-2`, radius `--radius-md`, padding 6 × 8, 12px text, with the hotkey in a `kbd` chip (`--bg-active`, radius `--radius-xs`, 11px mono, padding 0 × 4).

Icon buttons elsewhere (top bar, panel header, segment row) are 28 × 28 with a 16px icon and the same states, minus the active bar.

### 4.2 Buttons

Height 28 (36 in modals and empty state), padding 0 × 12, radius `--radius-sm`, 13/500.

- Primary: `--accent` bg, `--text-on-accent`; hover `--accent-hover`; press `--accent-press`.
- Secondary: `--bg-raised` bg, 1px `--border-strong`, `--text-1`; hover `--bg-hover`.
- Text: no bg, `--text-2`; hover `--text-1`, underline.
- Danger (Delete, Leave room confirm): `--danger-soft` bg, `--danger` text.
- Disabled: `--bg-raised`, `--text-disabled`, no hover.

### 4.3 Slider

- Track: 4 high, radius full, `--bg-active`; filled part `--accent`.
- Thumb: 14 × 14 circle, `--text-1` fill, `--shadow-1`. Hover: 4px `--accent-soft` halo. Dragging: halo 6px. Hit area 28 high.
- Width: 120 in the strip, fills the row in the panel.
- Always paired with a number field (48 wide, 28 high, right-aligned mono, unit suffix in `--text-3`). Typing a value and Enter commits; Up/Down ±1, Shift ±10.
- Keyboard on thumb: ←/→ ±1, Shift ±10, Home/End min/max. `[` and `]` change brush size globally.
- Dual (threshold range): two thumbs; the fill sits between them; thumbs cannot cross. Each has its own `aria-label` (`Lower threshold`, `Upper threshold`).
- No value bubble; the number field is the read-out.

### 4.4 Segment row

32 high, padding 0 × 8, radius `--radius-sm`, 8 gap.

`[swatch 12×12, radius xs] [index, 11 mono, --text-3 (--text-2 on a hovered or active row, where --text-3 is under 4.5:1), 16 wide] [name, 13, truncates] ······ [presence dot] [eye 24×24] [lock 24×24]`

| State | Treatment |
|---|---|
| Rest | transparent; eye and lock icons hidden unless set (hidden / locked) |
| Hover | `--bg-hover`; eye, lock and `⋯` appear |
| Active (paint target) | `--accent-soft` bg, name `--text-1` 500, 2px accent bar on the left |
| Hidden | swatch hollow (1px ring), name `--text-3`, eye-off icon always visible |
| Locked | lock icon always visible in `--text-2`; painting on it does nothing and the cursor shows not-allowed |
| Renaming | name becomes an inline input, same metrics; Enter commits, Esc cancels |
| Remote editing | 8px dot in that collaborator's colour before the eye; tooltip `Mina is editing` |

Click selects. Double-click the name or press F2 renames. Click the swatch opens a 4 × 3 popover of the 12 colours. Keys `1`–`9` select segments 1–9. The list is `role="listbox"`; each row is `role="option"` with `aria-selected`; eye and lock are `aria-pressed` toggle buttons.

### 4.5 Toast

- Position: bottom-centre, 12 above the status bar. Newest at the bottom, max 3; older ones collapse out.
- Box: `--bg-raised`, `--shadow-2`, radius `--radius-md`, padding 8 × 12, min 240, max 420 wide, 13px. Layout: `[icon 16] message [action] [×]`.
- Icon colour carries the type: info `--text-2`, success `--ok`, warning `--warn`, error `--danger`. No coloured backgrounds.
- One optional action as a text button in `--accent` (`Undo`, `Retry`).
- Lifetime: 4 s; 6 s with an action; errors stay until dismissed. Timer pauses on hover and focus, and goes on with the time that was left.
- Amounts of mask are written as a volume, in mL, or mm³ under half a millilitre, as in the measurements. Toasts do not count voxels.
- `Undo` on a toast means the step that toast describes. A newer edit, an undo or a redo takes the button off older toasts; the message stays for its time.
- Info/success: `role="status"`. Errors: `role="alert"`.
- Routine feedback that has a home elsewhere (saved, synced) goes to the status bar, not a toast.

### 4.6 Modal — Room

420 wide, `--bg-raised`, `--shadow-3`, radius `--radius-lg`, padding 24. Scrim `--bg-scrim`. Title 15/600; close button top-right; footer buttons right-aligned, 36 high.

One modal, two tabs (segmented control at the top): **Start a room** · **Join a room**. Opened from `Share` it lands on Start; from the empty state's `Join a room` it lands on Join. The close button sits in the row of the tabs (or of the title, on the second step), never on top of content.

```
Start a room                              Join a room
─────────────────────────────             ─────────────────────────────
Your name                                 Your name
[ Mina                         ]          [ Mina                         ]
(•) Shared copy                           Invite link
    Everyone gets the image and           [ Paste the invite link        ]
    the mask and keeps a copy. …
( ) View through my computer              Rooms you have joined on this device
    Others see and edit the mask          Mina's room  last opened …  Rejoin  Forget
    through your computer. …
                  [Cancel] [Start]                          [Cancel] [Join]
```

- Name: max 24 characters, the display name from Settings, prefilled and saved back. It is the only thing a room asks of anyone. Focus starts on the first empty field. Enter submits.
- Kind of room: two radio cards, 1px `--border-control`, radius `--radius-sm`, padding 10 × 12; the chosen one has an `--accent` border on `--bg-surface`. Title 13/500, description 12px `--text-3`. The wording is fixed by `ROOMS.md` B: the second card always shows "This limits what leaves your computer; it can't stop someone photographing or recording their screen." Never "secure", "protected" or "cannot be copied".
- Invite link: the whole link, including the part after `#`. There are no room codes.
- Rooms you have joined: shared-copy rooms this device is a member of, with `Rejoin` and `Forget` as text buttons. Shown only when there are any.
- One 12px line above the footer: not for diagnosis or treatment; de-identify before sharing.
- Validation is inline under the field in `--danger` 12px, shown on submit, cleared on edit.
- Submitting: primary button shows a 14px spinner and `Starting…` / `Joining…`; fields are disabled.
- After Start succeeds, the modal content swaps to: title `Room started`, one line saying that each link works for one person and stops working after 24 hours, the link in 12px mono, then `Done`, `Link for another person` (secondary) and `Copy invite link` (primary).

**Room pill**: status dot, `Room`, and `Connecting…` or `Offline` when not connected.

**Room popover** (from the room pill once connected): 300 wide menu surface, or the width of the segments panel when it is open. The kind of room as its title; when offline, one line and `Reconnect now`; for the host `New invite link` and the unused links (`Link 1 · expires in 24 h`, `Copy`, `Switch off`); the list of people (avatar, name, `You` tag on self, `Host` tag, click a person to jump to their view; for the host a `Remove` text button per person and, in a view-through-host room, how many slices each has seen); at the bottom `Leave room`, and for the host `Delete room` (shared copy) or `End room` (view through host). Remove, Delete and End ask first, in a confirm dialog that says what the other person keeps.

**Room bar** (same place and look as the recovery bar, above the views): for a guest of a view-through-host room, "Viewing through Mina's computer. Nothing is saved on this device." for as long as they are in it; after a merge that left differences, the count of slices and voxels with `Use mine` (primary) and `Keep the room's` (secondary).

**Blank view**: while a guest of a view-through-host room cannot reach the host, an opaque black layer covers the views with one line, "Waiting for Mina…". It is a layer above the views; the image itself is never animated or altered.

### 4.7 Avatar stack

- Avatar: 24 × 24 circle, user colour fill, initials (1–2 letters) in `--text-on-accent` 11/600, 2px ring in `--bg-surface`.
- Stack: overlap 6, newest on the left, max 4 then `+N` chip (same size, `--bg-active`, `--text-2`). Self is not in the stack.
- Hover: tooltip with the full name. Click: jump your viewports to their slice and orientation, once (no continuous follow in v1).
- Idle for 60 s: avatar drops to 50 % opacity.

### 4.8 Remote cursor

- Shown only inside the viewport of the same orientation the collaborator's pointer is in. Positioned in image coordinates so it tracks pan and zoom.
- Glyph: 14px arrow, user colour fill, 1px white stroke, 1px black outer halo — the stroke pair keeps it visible on any tissue and marks it as a person, not a segment.
- Label: name chip offset 12 right / 12 down of the tip; user colour bg, `--text-on-accent`, 11/500, padding 1 × 6, radius `--radius-xs`, max 120 wide.
- Same slice: 100 % opacity. Different slice: 40 % opacity and the label gains the offset, e.g. `Mina  +3`. More than 10 slices away: hidden.
- While they paint: the arrow is replaced by their brush ring in their user colour (dashed 1px), so their stroke is not mistaken for yours.
- Label hides after 3 s without movement, glyph stays; the cursor disappears when their pointer leaves the viewport.
- `pointer-events: none`, `aria-hidden`. Presence is exposed to assistive tech through the avatar stack and room popover.

### 4.9 Update banner

Small card, bottom-left, 12 from the rail and 12 above the status bar; 280 wide, toast surface styling. It never covers a viewport centre and never blocks work.

`Version 1.4.0 is ready.` / `Restart to update. Your work is saved first.` / `[Restart] [Later]`

- Appears only after the update has downloaded, and never while a stroke is in progress or a modal is open.
- `Later` dismisses until the next launch; a 6px accent dot then stays on the File menu button with a `Restart to update` item in the menu.
- While downloading there is no UI at all.

---

## 5. Motion spec

Motion explains where something came from or went. It is short, mostly opacity, and it never touches image pixels.

### 5.1 Tokens

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 80 ms | hover, press, colour changes |
| `--dur-fast` | 120 ms | exits, tooltips, strip swap |
| `--dur-base` | 160 ms | entrances, menus, toasts |
| `--dur-slow` | 220 ms | panel slide, modal — the ceiling |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | entering |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | leaving |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | moving on screen |

Exits are always one step faster than entrances. Travel distances stay at or under 8px except the panel slide. No springs, bounces or overshoot. Only `opacity` and `transform` are animated.

### 5.2 Hard rules for the image

- Never animate, fade, scale, blur or tween a viewport canvas. Slice changes, window/level, zoom and pan apply on the frame they are requested.
- Never resize a canvas continuously. Any layout change resizes each affected canvas exactly once, in the same frame as its pane, so an image is never shown stretched. While a window is dragged larger or smaller that is once per frame the pane changes; the image itself stays the same size on screen.
- The scrim behind a modal is the only thing allowed to dim a viewport, and it is a separate layer above it.
- No loading shimmer over an image. Loading is a 2px determinate bar at the top of the viewport cell plus `Loading… 42%` in the corner label.

### 5.3 Transitions

| Event | What animates | Duration / easing |
|---|---|---|
| **Right panel collapse** | Panel is taken out of grid flow and slides `translateX(0 → 100%)` with opacity 1 → 0. On `transitionend`, set `--panel-w: 0` and resize the canvases once. | `--dur-slow`, `--ease-in` |
| **Right panel expand** | Set `--panel-w` and resize canvases first (one frame), then slide the panel in `translateX(16px → 0)`, opacity 0 → 1. | `--dur-slow`, `--ease-out` |
| **Tool option strip swap** | Outgoing controls fade out; incoming fade in with `translateY(4px → 0)`. Strip height and tool name position do not change. Rapid hotkey presses cancel in-flight swaps and show the latest immediately. | out `--dur-instant` `--ease-in`, then in `--dur-fast` `--ease-out` |
| **Active tool indicator** | The 2px accent bar slides vertically between buttons (`transform`). | `--dur-fast`, `--ease-in-out` |
| **Viewport maximise / restore** | Layout swaps instantly; canvases resize once. Then the active viewport's 1px accent outline fades from 100 % to its resting state and corner labels fade in. No scaling of the cell. | outline `--dur-slow` `--ease-out`; labels `--dur-fast` |
| **Layout switcher** | Same as maximise. The switcher's selected-pill slides between options. | pill `--dur-fast`, `--ease-in-out` |
| **Toast in** | opacity 0 → 1, `translateY(8px → 0)`. Existing toasts shift up with `transform`. | `--dur-base`, `--ease-out` |
| **Toast out** | opacity 1 → 0, no movement. | `--dur-fast`, `--ease-in` |
| **Modal in** | Scrim opacity 0 → 1. Dialog opacity 0 → 1 and `scale(0.98 → 1)`. | scrim `--dur-base` linear; dialog `--dur-slow` `--ease-out` |
| **Modal out** | Dialog and scrim fade together, no scale. | `--dur-fast`, `--ease-in` |
| **Modal tab / success swap** | Crossfade content; dialog height animates. | `--dur-base`, `--ease-in-out` |
| **Menus, popovers, tooltips** | opacity 0 → 1, 4px offset from the trigger side. Out: opacity only. | in `--dur-fast` `--ease-out`; out `--dur-instant` |
| **Drop-zone hover (empty state)** | Border dashed `--border-strong` → solid `--accent`; background → `--accent-soft`; icon `translateY(0 → -2px)`; heading changes to `Drop to open`. | `--dur-fast`, `--ease-out` |
| **Drop overlay (image open)** | Full-window scrim + centred label fade in on dragenter, out on dragleave/drop. | in `--dur-fast`; out `--dur-instant` |
| **Segment add** | Row height 0 → 32 and opacity 0 → 1; the list scrolls it into view; the row holds `--accent-soft` for 600 ms then settles to its normal active state. | `--dur-base`, `--ease-out` |
| **Segment remove** | Row opacity → 0, then height → 0. The mask voxels disappear immediately. | `--dur-fast`, `--ease-in` |
| **Segment visibility / lock** | Icon swap, no transition. The overlay toggles on the same frame. | — |
| **Presence join** | Avatar `scale(0.8 → 1)`, opacity 0 → 1; the stack makes room with `transform`. Remote cursor fades in. | `--dur-base`, `--ease-out` |
| **Presence leave** | Avatar opacity → 0, then the stack closes. Cursor fades out. | `--dur-fast`, `--ease-in` |
| **Remote cursor movement** | Position is interpolated between network updates. This is the cursor glyph only, never the image. | 80 ms linear |
| **Update banner** | Same as toast in / out. | |
| **Buttons, rows, slider halo** | Background and colour. | `--dur-instant` linear |
| **Settings switch** | Knob slides `translateX(0 → 16px)`; track colour changes. | knob `--dur-fast` `--ease-in-out`; colour `--dur-instant` |
| **Welcome tour: cut-out and card** | The dimming layer is four panels and four corner pieces above the app; each moves with `transform` only, so the hole travels and resizes without animating layout. The card moves with `transform`; its content fades in. Nothing under the layer is animated, the image included. | move `--dur-slow` `--ease-in-out`; content `--dur-base` |
| **Welcome tour: hints** | Small inline SVG drawings in the card (scroll, brush stroke, fill between slices, two cursors) loop with `transform` and `opacity`. The one place a decorative loop is allowed; it is inside the tour card only. | 2 s loop |
| **Connection dot** | Colour change only. Reconnecting: opacity 1 ↔ 0.4 pulse. | 1.2 s loop, `--ease-in-out` |

### 5.4 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-instant: 0ms; --dur-fast: 0ms; --dur-base: 0ms; --dur-slow: 0ms; }
  *, *::before, *::after { animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}
```

- All transforms, slides and scales are removed; state changes are immediate.
- The reconnecting pulse becomes a static amber dot; spinners become static `…` text.
- Remote cursor interpolation is off; cursors jump to each reported position.
- Tour hints stand still in their finished state; the cut-out and card cut to their place.
- Also offered as an in-app setting (`Reduce motion`, Settings → Appearance; sets `data-reduce-motion` on `<html>` with the same overrides) for shared reading-room machines where the OS setting is not the user's to change.

---

## 6. UX copy

Sentence case. No exclamation marks, no "please", no "oops", no "successfully". Errors say what happened and what to do next. Numbers carry units.

### 6.1 Top bar

| Element | Copy |
|---|---|
| App name (empty state) | W Annotator |
| File name, nothing open | No image |
| Unsaved dot tooltip | Unsaved changes |
| File menu | Open image… · Open mask… · Save mask · Save mask as… · Close |
| Layout switcher tooltips | 2 × 2 · 1 large and 3 stacked · 3 side by side · 2 side by side · Single view (each followed by its key) |
| Room button, not in a room | Share |
| Room button tooltip | Start or join a room |
| Room pill tooltip | Room KDR-482 · 3 people |
| Panel toggle tooltip | Hide segments `Mod+\` / Show segments `Mod+\` |

### 6.2 Tool tooltips (name + key)

Crosshair `C` · Pan `H` · Zoom `Z` · Window / Level `W` · Brush `B` · Eraser `E` · Threshold brush `T` · Scissors `S` · Fill `F` · Undo `Mod+Z` · Redo `Mod+Shift+Z`

Disabled edit tool tooltip: `Add a segment to start editing.`

### 6.3 Tool options strip

| Tool | Labels |
|---|---|
| Crosshair | Click to move all views to a point. |
| Pan | Drag to move the image. |
| Zoom | Drag up or down to zoom. · Fit |
| Window / Level | Preset · Custom · Soft tissue · Abdomen · Liver · Pancreas · Lung · Bone · Brain · Stroke · Subdural · Auto · Full range · Mid range · Bright fluid · Dark detail · W · L · Reset · Ctrl-drag a box to set the window from it. (⌘-drag on a Mac) · toast when the box misses the image: Drag the box over the image to set the window from it. |
| Brush | Size · px · Shape · Circle · Sphere · Paint over · Everything · Empty only · Only… · Only Liver · Fill between slices |
| Paint over tooltip | Empty only keeps other segments as they are. (select: … Only paints inside one segment.) · list tooltip: Paint only inside one segment |
| Fill preview | Preview: 1.2 mL between axial slices. · Apply · Cancel · tooltips: Apply `Enter` · Cancel `Esc` |
| Eraser | Size · px · Shape · Circle · Sphere · Active segment only |
| Threshold brush | Range · to · Size · px |
| Threshold brush tooltip | Paints only where the image value is inside the range. |
| Scissors | Shape · Rectangle · Circle · Freehand · Sphere · Action · Erase inside · Erase outside · Fill inside · Depth · This slice · All slices · Paint over |
| Depth tooltip | All slices cuts through the whole stack of this view. |
| Fill | Action · Fill area · Remove island · Keep island · Paint over |
| Fill hints | Click an enclosed area to fill it on this slice. / Click a piece of the segment to remove it. A segment in one piece is removed whole. / Click the piece of the segment to keep. The rest is removed. |
| Size tooltip | Brush size `[` `]` |
| Active segment chip tooltip | Painting on Liver |
| No segment chip | No segment |

### 6.4 Viewports

| Element | Copy |
|---|---|
| Labels | Axial · Sagittal · Coronal · 3D |
| Slice | Slice 84 / 212 |
| Maximise tooltip | Maximise `M` / Restore `M` |
| View picker | Axial · Sagittal · Coronal · 3D. Label tooltip: Change view, or drag onto another pane to swap |
| View menu, slice views | Below the four views, after a divider: checkable item `Smooth pixels` (on by default, remembered, applies to all three slice views). Off draws each voxel as a flat block. Tooltip: Off shows each voxel as a flat block. The image values are the same either way. |
| Reference lines setting | Show reference lines — Always · On hover · With crosshair tool only. Help: Lines in each view that mark where the other two views cut it. Drag one to scroll that view. |
| Loading | Loading… 42% |
| 3D, no mask | Add a segment to see it in 3D. |
| 3D, building | Building 3D view… |
| 3D unavailable | 3D view is not available on this device. |
| Locked segment, on paint attempt (toast) | Liver is locked. Unlock it to edit. |
| Hidden segment, on paint attempt (toast) | Liver is hidden. Show it to edit. |

### 6.5 Right panel

| Element | Copy |
|---|---|
| Title | Segments |
| Add button tooltip | Add segment |
| Default name | Segment 3 |
| Empty | No segments yet. · Add segment |
| Eye tooltip | Hide / Show |
| Lock tooltip | Lock / Unlock |
| Row menu | Rename · Change colour · Show only this · Go to segment · Refine · Grow… · Shrink… · Smooth… · Fill holes · Keep largest island · Remove small islands… · Split into separate segments · Combine… · Measurements · Clear · Delete |
| Split, many islands (confirm) | Split Liver into 21 segments? · Liver has 8 islands. Each becomes a segment of its own. / Liver has 240 islands. The 21 largest become segments of their own; the rest stay in Liver. · Split · Cancel. Asked when more than 5 new segments would be made; never more than 20. New segments are named `Liver 2`, `Liver 3`, … |
| Refine popovers | Grow by · Shrink by · Smooth by · mm · Remove islands under · mm³ · Cancel · Apply |
| Combine popover | Add · Its voxels become part of Liver. · Cancel · Add |
| Measurements | Measurements · Segment · Volume · Voxels · Mean ± SD · Min · Max · Mean, SD, min and max are the image values inside each segment. · Copy as CSV · Done |
| Footer | Opacity · Outline only |
| Remote editing tooltip | Mina is editing |
| Delete confirm (only if segment has voxels) | Delete Liver? · This removes the segment from the mask. · Cancel · Delete |

### 6.6 Status bar

`Slice 84 / 212` · `X 212  Y 148  Z 84` · `Value −412 HU` (plain `Value 1280` when the modality has no unit) · `Segment Liver` / `Segment none` · `W 400  L 40  Soft tissue` (button, tooltip `Change the window`) · `Zoom 125%` (button, tooltip `Change the zoom`) · `Saved` · `Unsaved changes` · `Saving…` · `Synced` · `Reconnecting…` · `Offline`

| Element | Copy |
|---|---|
| Window menu | Presets for · CT · MR · (presets) · Auto · Full range · Save current as preset… · Remove preset Site lung |
| Save dialog | Save window as preset · Name · Cancel · Save · Give the preset a name. · There is already a preset called Lung. Choose another name. · You can keep 12 presets. Remove one to save another. |
| Zoom menu | Zoom in · Zoom out · Fit · Actual size (tooltip: One image pixel on one screen pixel) |
| Shortcut list | Next window preset · Previous window preset · Brighter · Darker · More contrast · Less contrast · Zoom in · Zoom out · Fit to view · mouse: Brightness and contrast, with the Window / Level tool — Two-finger scroll · Window from a box, with the Window / Level tool — Ctrl-drag (⌘-drag) |
| Two-finger scroll setting, help | On a trackpad. When it pans, hold Shift to change slice. With the Window / Level tool it changes brightness and contrast, and Shift changes slice. |

### 6.7 Empty state and drag-drop

| Element | Copy |
|---|---|
| Heading | Drop an image and a mask |
| Body | MHA, NIfTI, NRRD or a DICOM folder. The mask is optional. |
| Buttons | Open image · Open mask |
| Open mask disabled tooltip | Open an image first. |
| Links | Join a room · Open the sample · Settings |
| Recent heading | Recent |
| Dragging over (empty) | Drop to open |
| Dragging over (image open, mask file) | Drop to add as mask |
| Dragging over (image open, image file) | Drop to replace image |
| Dragging over (image open, kind not known: a folder, DICOM, or a browser that hides names) | Drop to add |
| Replace confirm (nothing unsaved, dropped image) | Replace the current image? · follow_up.mha will open in place of ct.nii. · Add as mask (only when its values could be labels) · Cancel · Replace |
| Files section | Files · New mask · Edit {name} · Hide / Show · Dim image / Show image at full brightness · Make active · Save… · Show in Finder / Explorer / folder · Close · Close image |
| Too many masks | Up to 4 masks can be open at once. Close one in Files to add another. |
| Replace confirm (unsaved) | Replace the current image? · Unsaved mask changes will be lost. · Cancel · Save and replace · Replace |
| Loading | Opening chest_ct_014.nii.gz… |

### 6.8 Room

| Element | Copy |
|---|---|
| Tabs | Start a room · Join a room |
| Name label / placeholder | Your name / How others will see you |
| Code label / placeholder | Room code / ABC-123 |
| Start helper | Anyone with the code can view and edit this mask. |
| Buttons | Cancel · Start · Join · Starting… · Joining… |
| Started | Room started · Share this code with the people you want to work with. · Copy code · Copy invite link · Done |
| Popover | Room KDR-482 · Copy code · Copy invite link · People · You · Leave room |
| Person row tooltip | Go to Mina's view |
| Leave confirm (host) | Leave the room? · Others can keep working. Your copy of the mask stays open here. · Cancel · Leave |
| Joining with no image | Getting the image from the room… |

### 6.9 Toasts

| Trigger | Copy |
|---|---|
| Code copied | Code copied |
| Link copied | Invite link copied |
| Someone joined | Mina joined |
| Someone left | Mina left |
| You left | You left the room |
| Reconnected | Back online. Changes are synced. |
| Mask saved to new file | Saved to liver_mask.nii.gz |
| Segment deleted | Liver deleted · Undo |
| Segment cleared | Liver cleared · Undo |
| Large operation done (fill, whole volume) | Filled 18.2 mL · Undo |
| Nothing to fill | Nothing to fill here. |
| Grow, shrink, smooth | Grew Liver by 2 mm · Undo / Shrank Liver by 2 mm · Undo / Smoothed Liver by 2 mm · Undo |
| Fill holes | Filled 1.2 mL in Liver · Undo / No holes in Liver. |
| Islands | Removed 310 mm³ outside the largest island of Liver · Undo / Liver is already one island. / Removed 310 mm³ in small islands of Liver · Undo / No islands under 10 mm³ in Liver. |
| Combine | Added Tumour to Liver, 1.2 mL · Undo |
| Scissors, all slices | Erased 1.2 mL of Liver on all axial slices · Undo / Filled 1.2 mL of Liver on all axial slices · Undo |
| Scissors, Erase outside on this slice, when part of what it erased was out of view | Erased 320 mm³ of Liver on this slice, some of it outside the view · Undo |
| Clicked island | Removed an island of Liver, 320 mm³ · Undo / Removed all of Liver, 1,480 mL. It was one island. · Undo / Removed 1.2 mL of Liver outside this island · Undo / Liver is already one island. / Click a part of Liver. |
| Split | Split Liver into 3 segments. · Undo / Split Liver into 21 segments. The 12 smallest islands stay in Liver. · Undo / Liver is already one island. |
| Fill between slices | Filled 1.2 mL between axial slices · Undo / Fill preview cancelled. / There was nothing left to fill. / Paint Liver on two axial slices with a gap between them, then fill. |
| Paint over limit | Nothing was painted: Paint over is set to Only Liver. / Nothing was painted: Paint over is set to Empty only. (once per choice) / Paint over is back to Everything. (its segment was deleted or became the active one) |
| Operation changed nothing | Liver did not change. |
| Go to an empty segment | Liver is empty. |
| Measurements copied | Measurements copied |
| Threshold matched nothing | No voxels in this range under the brush. |

### 6.10 Errors

| Situation | Copy |
|---|---|
| Unsupported file | Can't open scan.xyz. Use MHA, NIfTI, NRRD or DICOM. |
| Corrupt / unreadable | Can't read chest_ct_014.nii.gz. The file may be damaged or incomplete. |
| DICOM folder has no series | No image series found in this folder. |
| DICOM folder has several series | This folder has 3 series. Choose one to open. |
| Mask before image | Open an image first, then add the mask. |
| Mask size mismatch | This mask is 512 × 512 × 180 but the image is 512 × 512 × 212. They need to match. |
| Mask spacing/orientation differs | This mask doesn't line up with the image. Open it anyway? · Cancel · Open anyway |
| Not enough memory | This image is too large to open on this device. |
| Save failed | Couldn't save the mask. Check that the folder is writable. · Retry |
| Unsaved on close | Save changes to liver_mask.nii.gz? · Don't save · Cancel · Save |
| Name empty | Enter a name. |
| Code empty / malformed | Enter the 6-character room code. |
| Room not found | No room with that code. Check the code and try again. |
| Room closed | This room has ended. |
| Can't reach server | Can't connect. Check your network and try again. · Retry |
| Connection lost mid-session | Connection lost. Reconnecting… You can keep working; changes will sync. |
| Reconnect gave up | Still offline. Your changes are kept on this device. · Try again |
| Update failed | Couldn't install the update. It will try again next time. |

### 6.11 Update banner

`Version 1.4.0 is ready.` · `Restart to update. Your work is saved first.` · `Restart` · `Later` · File menu item: `Restart to update`

### 6.12 Report a problem

| Element | Copy |
|---|---|
| File menu item, empty state link | Report a problem… · Report a problem |
| Error toast action (unexpected errors only) | Report |
| Titles and switch | Report a problem · Suggest an idea · Bug · Idea |
| Bug fields | Title · What happened · What you expected · Steps to reproduce |
| Idea fields | Title · Problem · Proposal |
| Checkbox and preview | Include technical details · What will be sent · No file names or paths. Only what is listed here. |
| Notes | Do not include patient names or screenshots of patient data. · GitHub opens in your browser. You review the report and submit it there with your GitHub account. |
| Buttons | Cancel · Copy report · Continue on GitHub |
| Missing text | Add a short title. · Say what happened. · Describe the problem. · Say what you would like the app to do. |
| Browser did not open | Couldn't open the browser. Use Copy report and paste it into a new issue on GitHub. |
| Copied (toast) | Report copied |
| Log shortened (in the report) | Older log lines were left out to keep the report short. |

---

## 7. Accessibility

**Contrast**
- Text and icons meet 4.5:1 against their surface (see ratios in section 3); disabled text is the only exception.
- Control boundaries that convey state (input borders, slider track, toggles) use `--border-strong` or stronger to reach 3:1 against the surface.
- Viewport overlay text sits on unpredictable pixels: always `--text-2` or brighter with a 1px black shadow. Offer `Hide overlays` in View settings for uninterrupted reading.
- Segment colours cannot guarantee contrast against arbitrary anatomy; the 100 % outline, the opacity control and `Outline only` are the mitigations. Never signal state with segment colour alone.

**Focus**
- `:focus-visible` everywhere: 2px gap in the surface colour + 2px `--accent` ring (`--focus-ring`). Never removed, never replaced by a colour change only.
- A focused viewport shows the accent outline at 2px.
- Modals and popovers trap focus and return it to the trigger on close. `Esc` closes the topmost layer: tooltip → menu → modal → maximised viewport. One press closes one layer: a held key does not go on to the next, and Esc during a drag (a stroke, a pan, an outline) belongs to the drag. The segment popovers (Grow, Combine and the like) hold Tab as modals do.

**Hit sizes**
- Rail buttons 36 × 36; top-bar and strip controls 28 high with at least 28 wide; row icons 24 × 24 with 4px spacing (WCAG 2.2 target size 24 minimum is met everywhere).
- Slider thumb is 14 visible, 28 hit. Segment rows are full-width targets.

**Keyboard**
- `F6` / `Shift+F6` cycles regions: top bar → tool rail → options strip → viewports → right panel → status bar. Each region is a landmark with an `aria-label`.
- Tool rail and segmented controls use roving tabindex with arrow keys; Tab moves between groups.
- Viewport focused: ↑/↓ slice ±1, PageUp/PageDown ±10, Home/End first/last, `+`/`−` zoom, `0` fit, `M` maximise, `Tab` to next viewport.
- Segment list: ↑/↓ move, Enter selects, F2 renames, `V` toggles visibility, `L` toggles lock, Delete deletes (with confirm when non-empty).
- Single-letter hotkeys are ignored while focus is in a text or number field, and can be turned off in settings (WCAG 2.1.4).
- Painting itself needs a pointer; this is a known limit. All non-drawing functions — navigation, segment management, room, save — are fully keyboard operable.

**Screen readers and status**
- Icon-only buttons have `aria-label` matching the tooltip; the hotkey goes in `aria-keyshortcuts`.
- Toasts: `role="status"` (polite); errors `role="alert"`. Presence join/leave is announced politely at most once every 5 s.
- Status bar values under the pointer are not live regions (too noisy). Slice changes made by keyboard are announced: `Slice 85 of 212`.
- Canvas elements get `role="img"` and a label such as `Axial view, slice 84 of 212`.

**Other**
- Respects `prefers-reduced-motion` (5.4) and `prefers-contrast: more` (swap `--border` → `--border-strong`, `--text-3` → `--text-2`).
- UI text scales with a root font-size setting of 100 / 115 / 130 %; bar heights grow with it, viewport overlays do not shrink.
- No information is given by sound. Nothing flashes.

---

## 8. References (Mobbin)

Screens reviewed through the Mobbin connector and what each contributed.

| Screen | Borrowed |
|---|---|
| [Spline — 3D editor with collaborators](https://mobbin.com/screens/f92a4ab3-c72e-4864-9c8c-5ba5952a51b4?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Near-black panels framing a large canvas; presence markers drawn on the canvas itself; avatar + `Share` grouped top-right; compact `Yes / No` segmented controls, reused for Shape, Action and Scope in the options strip. |
| [Spline — object selected](https://mobbin.com/screens/f38d828d-45e6-4d1d-b1c2-6bdede15b89e?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Object list rows: icon, name, trailing lock icon that only shows when set, full-row accent selection. Model for the segment row. Also the right panel changing its contents to match the selection, which became the contextual options strip. |
| [Spline — processing state](https://mobbin.com/screens/f64b1492-b360-4dc6-a2cf-2a3e2650b25d?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Small quiet status pill instead of a blocking loader; informed the in-cell `Loading… 42%` label and the no-shimmer rule. |
| [Figma — canvas with comment and toolbar](https://mobbin.com/screens/feef6518-d698-4e0e-b4eb-b44301dfeb38?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | File name as the top-left anchor that opens the file menu; single-accent active tool state; avatar next to a prominent `Share` button; zoom shown as a plain percentage. |
| [Figma — layers and properties](https://mobbin.com/screens/fc462349-4feb-49ed-81bc-188538edd8e1?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Dense 32px list rows with hover-revealed actions; opacity as slider-plus-number; eye icon for visibility. A warning too: its right panel shows everything at once, which this app deliberately avoids. |
| [Figma Slides — "Done · Try again" toast](https://mobbin.com/screens/eb6d7b23-72b8-4e7a-b6e5-16c57e0bdb16?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Bottom-centre dark toast: icon, short message, one text action, close. Adopted as the toast pattern, including `Undo` actions. |
| [Luma — Share board dialog](https://mobbin.com/screens/7a2aa956-b7f4-4657-af63-32109b1cd276?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Small centred share modal over a dimmed neutral canvas; two link-copy buttons side by side (`Copy code`, `Copy invite link`); people list with a `(You)` tag. Permissions and email invite were dropped because rooms need only a name. |
| [VEED — Invite collaborators](https://mobbin.com/screens/dedee753-195a-4498-a0ee-a1d94a56c043?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | `Copy project link` as a plain text action; member row layout. Also a counter-example: the promotional card inside the dialog is the kind of noise this spec excludes. |
| [SoundCloud — dark upload empty state](https://mobbin.com/screens/da0e50b2-25b1-4420-a3e1-aa744c5365e2?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Dashed drop zone on a dark surface with one icon, one sentence, one button, and a secondary route beneath it. Direct model for the empty state. |
| [WeTransfer — drag and drop to sign](https://mobbin.com/screens/0a2975be-f594-447a-a42e-48ad295a3521?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Accepted formats stated in one quiet line under the button (`Only supports PDFs.`), reused for the format line. |
| [Square — image library drop zone](https://mobbin.com/screens/a3919f0c-a620-4a40-b9d1-3aff457372cb?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Heading that is the instruction itself (`Drag and drop images here, or`) followed directly by the button. |
| [Linear — issue list with "What's new" card](https://mobbin.com/screens/fd1b4d88-f021-49a3-98af-4cd3a87e1d29?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Small bottom-left card for product news that never interrupts; the placement and scale of the update banner. Also row density and the restrained use of one accent. |
| [Linear — issue detail](https://mobbin.com/screens/f00cc4fb-4083-43fc-a0fb-703a6c4ef771?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Right-side properties grouped under small quiet headings; 13px base type with secondary grey for metadata. |
| [Base44 — "URL updated" toast](https://mobbin.com/screens/4a18bfd3-4480-4beb-8b5f-8227ee274532?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) | Two-line card (title + one sentence) with a status icon; the structure of the update banner. |

Not found on Mobbin and specified from domain practice instead: the 2 × 2 MPR grid with orientation markers, window/level presets, slice-aware remote cursors, the segment palette, and the rule that the image is never animated (conventions from 3D Slicer, ITK-SNAP, OHIF and radiology reading-room guidance).
