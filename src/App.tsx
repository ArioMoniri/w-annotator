import { useEffect, useRef, useState } from 'react';
import { findUpdate, launchFiles } from './platform';
import * as session from './session';
import { EDIT_TOOLS, get, set, useStore, type ToolId } from './state/store';
import { initEngine, scrollSlices } from './viewer/engine';
import { EmptyState } from './ui/EmptyState';
import { OptionsStrip } from './ui/OptionsStrip';
import { Busy, ConfirmDialog, ShortcutsSheet, Toasts, UpdateBanner } from './ui/Overlays';
import { RoomModal } from './ui/RoomModal';
import { SegmentsPanel } from './ui/SegmentsPanel';
import { StatusBar } from './ui/StatusBar';
import { ToolRail } from './ui/ToolRail';
import { TopBar } from './ui/TopBar';
import { Viewports } from './ui/Viewports';
import { droppedFiles, pickImage, pickMask, toInputFiles } from './ui/files';

const TOOL_KEYS: Record<string, ToolId> = {
  c: 'crosshair',
  h: 'pan',
  z: 'zoom',
  w: 'window',
  r: 'measure',
  b: 'brush',
  e: 'eraser',
  t: 'threshold',
  s: 'scissors',
  f: 'fill',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox';
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function useHotkeys() {
  const previousTool = useRef<ToolId>('crosshair');
  useEffect(() => {
    const unsub = useStore.subscribe((s, p) => {
      if (s.tool !== p.tool) previousTool.current = p.tool;
    });
    const onKey = (e: KeyboardEvent) => {
      const s = get();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) session.redo();
          else session.undo();
        } else if (key === 'y') {
          e.preventDefault();
          session.redo();
        } else if (key === 'o') {
          e.preventDefault();
          if (e.shiftKey) pickMask();
          else pickImage();
        } else if (key === 's') {
          e.preventDefault();
          void session.saveMask();
        } else if (key === '\\') {
          e.preventDefault();
          set({ panelOpen: !s.panelOpen });
        }
        return;
      }
      if (isTyping(e.target) || e.altKey || s.roomModal || s.confirm) return;
      if (e.key === '?') return set({ shortcutsOpen: !s.shortcutsOpen });
      if (!s.image || s.shortcutsOpen) return;

      if (TOOL_KEYS[key]) return session.setTool(TOOL_KEYS[key]);
      if (e.key >= '1' && e.key <= '9') return session.selectSegment(Number(e.key));
      switch (e.key) {
        case '[':
          return session.setBrushSize(s.brushSize - (s.brushSize > 10 ? 2 : 1));
        case ']':
          return session.setBrushSize(s.brushSize + (s.brushSize >= 10 ? 2 : 1));
        case ' ':
          e.preventDefault();
          return session.setTool(previousTool.current);
        case 'n':
        case 'N':
          return session.addSegment();
        case 'o':
        case 'O':
          return session.setOutlineOnly(!s.outlineOnly);
        case 'x':
        case 'X':
          return session.setOpacity(s.opacity > 0 ? 0 : 0.5);
        case 'm':
        case 'M':
          return set({ maximized: s.maximized ? null : s.activeView });
        case 'Escape':
          if (s.maximized) return set({ maximized: null });
          if (EDIT_TOOLS.includes(s.tool)) return session.setTool('crosshair');
          return;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'PageUp':
        case 'PageDown': {
          if (s.activeView === 'volume3d') return;
          e.preventDefault();
          const step = e.key.startsWith('Page') || e.shiftKey ? 5 : 1;
          return scrollSlices(s.activeView, e.key === 'ArrowUp' || e.key === 'PageUp' ? step : -step);
        }
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
    void launchFiles().then((files) => {
      if (files.length) void session.openFiles(files);
    });
    void findUpdate().then((update) => update && set({ update }));
    const warn = (e: BeforeUnloadEvent) => {
      if (get().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  return (
    <div className="app" data-empty={!hasImage} data-panel={panelOpen ? 'open' : 'closed'}>
      <TopBar />
      {hasImage ? (
        <>
          <ToolRail />
          <OptionsStrip />
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
      <ConfirmDialog />
      <ShortcutsSheet />
    </div>
  );
}
