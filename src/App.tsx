import { useEffect, useRef, useState } from 'react';
import { findUpdate, isTauri, onFilesGiven, onNativeDrag, selfTestRequested, startFilesDump } from './platform';
import { stepBrushSize } from './mask/brush';
import * as session from './session';
import * as windowing from './windowing';
import { DROP_TEXT, dropHint } from './files/roles';
import { fileRows } from './mask/collection';
import { actionFor, comboFromEvent, escapeGoesTo, useShortcuts, type ActionId } from './state/shortcuts';
import { EDIT_TOOLS, get, set, toast, useStore, type ToolId } from './state/store';
import { fitAll, initEngine, scrollSlices } from './viewer/engine';
import { EmptyState } from './ui/EmptyState';
import { ReportDialog } from './ui/ReportDialog';
import { noteImagePaths, startRecovery } from './recovery';
import { OptionsStrip } from './ui/OptionsStrip';
import { RecoveryBar } from './ui/RecoveryBar';
import { RoomBar } from './ui/RoomBar';
import { Busy, ConfirmDialog, Toasts, UpdateBanner } from './ui/Overlays';
import { MeasurementsSheet } from './ui/Measurements';
import { SavePresetDialog } from './ui/ViewMenus';
import { RoomModal } from './ui/RoomModal';
import { SettingsDialog } from './ui/Settings';
import { SegmentsPanel } from './ui/SegmentsPanel';
import { StatusBar } from './ui/StatusBar';
import { ToolRail } from './ui/ToolRail';
import { TopBar } from './ui/TopBar';
import { Viewports } from './ui/Viewports';
import { droppedFiles, pickImage, pickMask, toInputFiles } from './ui/files';
import { getSettings } from './state/settings';
import { chooseLayout, currentLayout } from './state/views';
import { Tour } from './tour/Tour';
import { startTour } from './tour/state';
import { shouldShowTour } from './tour/steps';

/** Anything that closes itself on Esc: menus, the popovers of a segment row, dialogs. */
const OVERLAYS = '.menu, [role="menu"], [role="dialog"]';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox';
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function cycleSegment(step: number): void {
  const s = get();
  if (s.segments.length === 0) return;
  const at = s.segments.findIndex((x) => x.index === s.activeSegment);
  const next = s.segments[(at + step + s.segments.length) % s.segments.length];
  session.selectSegment(next.index);
}

function scrollActive(delta: number): void {
  const view = get().activeView;
  if (view !== 'volume3d') scrollSlices(view, delta);
}

function useHotkeys() {
  const previousTool = useRef<ToolId>('crosshair');
  useEffect(() => {
    const unsub = useStore.subscribe((s, p) => {
      if (s.tool !== p.tool) previousTool.current = p.tool;
    });
    const run: Record<ActionId, () => void> = {
      'tool.crosshair': () => session.setTool('crosshair'),
      'tool.pan': () => session.setTool('pan'),
      'tool.zoom': () => session.setTool('zoom'),
      'tool.window': () => session.setTool('window'),
      'tool.measure': () => session.setTool('measure'),
      'tool.brush': () => session.setTool('brush'),
      'tool.eraser': () => session.setTool('eraser'),
      'tool.threshold': () => session.setTool('threshold'),
      'tool.scissors': () => session.setTool('scissors'),
      'tool.fill': () => session.setTool('fill'),
      'tool.last': () => session.setTool(previousTool.current),
      'brush.smaller': () => session.setBrushSize(stepBrushSize(get().brushSize, -1, get().brushMin)),
      'brush.larger': () => session.setBrushSize(stepBrushSize(get().brushSize, 1, get().brushMin)),
      'mask.interpolate': () => session.fillBetweenSlices(),
      'segment.new': () => session.addSegment(),
      'segment.next': () => cycleSegment(1),
      'segment.previous': () => cycleSegment(-1),
      'mask.outline': () => session.setOutlineOnly(!get().outlineOnly),
      'mask.toggle': () => session.setMaskHidden(!get().maskHidden),
      'window.next': () => windowing.stepWindowPreset(1),
      'window.previous': () => windowing.stepWindowPreset(-1),
      // A lower level is a brighter picture; a narrower window is more contrast.
      'window.brighter': () => windowing.nudgeCurrentWindow(0, -windowing.LEVEL_STEP),
      'window.darker': () => windowing.nudgeCurrentWindow(0, windowing.LEVEL_STEP),
      'window.moreContrast': () => windowing.nudgeCurrentWindow(-windowing.WIDTH_STEP, 0),
      'window.lessContrast': () => windowing.nudgeCurrentWindow(windowing.WIDTH_STEP, 0),
      'view.zoomIn': () => windowing.zoomActive(1),
      'view.zoomOut': () => windowing.zoomActive(-1),
      'view.fit': () => fitAll(),
      'slice.previous': () => scrollActive(-1),
      'slice.next': () => scrollActive(1),
      'slice.back5': () => scrollActive(-5),
      'slice.forward5': () => scrollActive(5),
      // After a merge that kept my version of some slices aside: from one such slice to the next.
      'review.previous': () => session.stepReview(-1),
      'review.next': () => session.stepReview(1),
      'view.maximise': () => set({ maximized: get().maximized || currentLayout() === 'single' ? null : get().activeView }),
      'layout.grid': () => chooseLayout('grid'),
      'layout.focus': () => chooseLayout('focus'),
      'layout.three': () => chooseLayout('three'),
      'layout.two': () => chooseLayout('two'),
      'layout.single': () => chooseLayout('single'),
      'view.panel': () => set({ panelOpen: !get().panelOpen }),
      'edit.undo': () => session.undo(),
      'edit.redo': () => session.redo(),
      'file.openImage': () => pickImage(),
      'file.openMask': () => pickMask(),
      'file.save': () => void session.saveMask(),
      'help.shortcuts': () => set({ settings: get().settings === 'shortcuts' ? null : 'shortcuts' }),
      'app.settings': () => set({ settings: get().settings ? null : 'profile' }),
    };
    // These work with nothing open; the rest need an image.
    const always = new Set<ActionId>(['file.openImage', 'help.shortcuts', 'app.settings']);

    const onKey = (e: KeyboardEvent) => {
      const s = get();
      if (s.capturingShortcut || s.report) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const withModifier = combo.startsWith('mod+');
      if (!withModifier && (isTyping(e.target) || s.roomModal || s.confirm || s.measurementsOpen || s.savePreset)) return;
      if (combo === 'mod+y') {
        e.preventDefault();
        return session.redo();
      }
      const bindings = useShortcuts.getState().bindings;
      // "+" is Shift and "=" on many keyboards: unless it has a job of its own it zooms in as "=" does.
      const action = actionFor(bindings, combo) ?? (combo === '+' && bindings['view.zoomIn'] === '=' ? 'view.zoomIn' : null);
      if (action) {
        if (s.settings && !action.endsWith('shortcuts') && action !== 'app.settings') return;
        if (!s.image && !always.has(action)) return;
        e.preventDefault();
        return run[action]();
      }
      if (!s.image || s.settings) return;
      if (e.key >= '1' && e.key <= '9' && combo.length === 1) return session.selectSegment(Number(e.key));
      // A fill preview waits for a yes or a no before anything else.
      if (s.preview && combo === 'enter') {
        e.preventDefault();
        return session.applyFillPreview();
      }
      if (combo !== 'escape') return;
      const to = escapeGoesTo({
        repeat: e.repeat,
        overlay: !!document.querySelector(OVERLAYS),
        dragging,
        preview: !!s.preview,
        maximised: !!s.maximized,
        editTool: EDIT_TOOLS.includes(s.tool),
      });
      if (to === 'nothing') return;
      e.preventDefault();
      if (to === 'preview') session.cancelFillPreview();
      else if (to === 'maximise') set({ maximized: null });
      else session.setTool('crosshair');
    };
    // A button held down anywhere is a drag under way; Esc is not a layout change in the middle of one.
    let dragging = false;
    const onPointer = (e: PointerEvent) => {
      dragging = e.type !== 'pointercancel' && e.buttons !== 0;
    };
    const onBlur = () => {
      dragging = false;
    };
    const pointerEvents = ['pointerdown', 'pointerup', 'pointercancel'] as const;
    for (const type of pointerEvents) window.addEventListener(type, onPointer, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    return () => {
      unsub();
      for (const type of pointerEvents) window.removeEventListener(type, onPointer, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

/**
 * Names of the files held over the window, when they are known; an empty list when a
 * drag is on but the names are hidden (a browser tells them only at the drop); null
 * when nothing is being dragged.
 */
function useFileDrop(): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    // Desktop app: the system's own drag-and-drop gives real paths, also for folders.
    // The files arrive through `onFilesGiven`; here only the overlay follows the drag.
    if (isTauri) {
      let stop = () => {};
      let gone = false;
      void onNativeDrag(setNames).then((off) => (gone ? off() : (stop = off)));
      return () => {
        gone = true;
        stop();
      };
    }
    const setDragging = (on: boolean) => setNames(on ? [] : null);
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = await droppedFiles(e.dataTransfer);
      await session.openFiles(await toInputFiles(files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return names;
}

export function App() {
  const hasImage = useStore((s) => !!s.image);
  const panelOpen = useStore((s) => s.panelOpen);
  const dragged = useFileDrop();
  const dragging = dragged !== null;
  useHotkeys();

  useEffect(() => {
    void initEngine();
    const stopRecovery = startRecovery();
    // Desktop app: files dropped on the window or opened with the app, at launch and later.
    let stopFiles = () => {};
    let gone = false;
    void onFilesGiven({
      reading: (count) => set({ busy: count === 1 ? 'Opening…' : `Reading ${count} files…` }),
      files: async (files) => {
        noteImagePaths(files);
        if (files.length === 0) return set({ busy: null });
        await session.openFiles(files);
      },
      error: (text) => toast('error', text),
    }).then((off) => (gone ? off() : (stopFiles = off)));
    void startFilesDump(() => ({ image: get().image?.name ?? null, files: fileRows(get()).map(({ kind, label, active }) => ({ kind, label, active })) }));
    // Test hook, off unless the app was launched with W_SELFTEST. It waits for the launch files itself.
    void selfTestRequested().then(async (wanted) => {
      if (wanted) void (await import('./selftest')).run();
    });
    void findUpdate().then((update) => update && set({ update }));
    if (shouldShowTour(getSettings().tourSeen, location.search)) startTour();
    const warn = (e: BeforeUnloadEvent) => {
      if (session.anyUnsaved()) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      gone = true;
      stopFiles();
      stopRecovery();
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  return (
    <div className="app" data-empty={!hasImage} data-panel={panelOpen ? 'open' : 'closed'}>
      <TopBar />
      {hasImage ? (
        <>
          <ToolRail />
          <OptionsStrip />
          <RoomBar />
          <RecoveryBar />
          <Viewports />
          {panelOpen && <SegmentsPanel />}
          <StatusBar />
        </>
      ) : (
        <EmptyState dragging={dragging} />
      )}
      {hasImage && dragging && <div className="dropveil">{DROP_TEXT[dropHint(dragged.length > 0 ? dragged : null, true)]}</div>}
      <Busy />
      <Toasts />
      <UpdateBanner />
      <RoomModal />
      <ReportDialog />
      <ConfirmDialog />
      <MeasurementsSheet />
      <SavePresetDialog />
      <SettingsDialog />
      <Tour />
    </div>
  );
}
