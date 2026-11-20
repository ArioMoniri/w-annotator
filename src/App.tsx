import { useEffect, useRef, useState } from 'react';
import { findUpdate, launchFiles } from './platform';
import { stepBrushSize } from './mask/brush';
import * as session from './session';
import { actionFor, comboFromEvent, useShortcuts, type ActionId } from './state/shortcuts';
import { EDIT_TOOLS, get, set, useStore, type ToolId } from './state/store';
import { initEngine, scrollSlices } from './viewer/engine';
import { EmptyState } from './ui/EmptyState';
import { ReportDialog } from './ui/ReportDialog';
import { noteImagePaths, startRecovery } from './recovery';
import { OptionsStrip } from './ui/OptionsStrip';
import { RecoveryBar } from './ui/RecoveryBar';
import { Busy, ConfirmDialog, Toasts, UpdateBanner } from './ui/Overlays';
import { MeasurementsSheet } from './ui/Measurements';
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
      'slice.previous': () => scrollActive(-1),
      'slice.next': () => scrollActive(1),
      'slice.back5': () => scrollActive(-5),
      'slice.forward5': () => scrollActive(5),
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
      if (!withModifier && (isTyping(e.target) || s.roomModal || s.confirm || s.measurementsOpen)) return;
      if (combo === 'mod+y') {
        e.preventDefault();
        return session.redo();
      }
      const action = actionFor(useShortcuts.getState().bindings, combo);
      if (action) {
        if (s.settings && !action.endsWith('shortcuts') && action !== 'app.settings') return;
        if (!s.image && !always.has(action)) return;
        e.preventDefault();
        return run[action]();
      }
      if (!s.image || s.settings) return;
      if (e.key >= '1' && e.key <= '9' && combo.length === 1) return session.selectSegment(Number(e.key));
      if (e.key === 'Escape') {
        if (s.maximized) return set({ maximized: null });
        if (EDIT_TOOLS.includes(s.tool)) return session.setTool('crosshair');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unsub();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

function useFileDrop() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
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
  return dragging;
}

export function App() {
  const hasImage = useStore((s) => !!s.image);
  const panelOpen = useStore((s) => s.panelOpen);
  const dragging = useFileDrop();
  useHotkeys();

  useEffect(() => {
    void initEngine();
    const stopRecovery = startRecovery();
    void launchFiles().then((files) => {
      noteImagePaths(files);
      if (files.length) void session.openFiles(files);
    });
    void findUpdate().then((update) => update && set({ update }));
    if (shouldShowTour(getSettings().tourSeen, location.search)) startTour();
    const warn = (e: BeforeUnloadEvent) => {
      if (get().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
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
          <RecoveryBar />
          <Viewports />
          {panelOpen && <SegmentsPanel />}
          <StatusBar />
        </>
      ) : (
        <EmptyState dragging={dragging} />
      )}
      {hasImage && dragging && <div className="dropveil">Drop to open</div>}
      <Busy />
      <Toasts />
      <UpdateBanner />
      <RoomModal />
      <ReportDialog />
      <ConfirmDialog />
      <MeasurementsSheet />
      <SettingsDialog />
      <Tour />
    </div>
  );
}
