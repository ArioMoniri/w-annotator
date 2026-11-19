import { Blend, Brush, Contrast, Crosshair, Eraser, Hand, PaintBucket, Redo2, Ruler, Scissors, Undo2, ZoomIn, Keyboard } from 'lucide-react';
import type { ReactNode } from 'react';
import { EDIT_TOOLS, set, useStore, type ToolId } from '../state/store';
import { redo, setTool, undo } from '../session';
import { formatCombo, useShortcuts, type ActionId } from '../state/shortcuts';
import { isMac } from './common';

export const TOOLS: { id: ToolId; name: string; key: string; icon: ReactNode }[] = [
  { id: 'crosshair', name: 'Crosshair', key: 'C', icon: <Crosshair size={18} strokeWidth={1.5} /> },
  { id: 'pan', name: 'Pan', key: 'H', icon: <Hand size={18} strokeWidth={1.5} /> },
  { id: 'zoom', name: 'Zoom', key: 'Z', icon: <ZoomIn size={18} strokeWidth={1.5} /> },
  { id: 'window', name: 'Window / Level', key: 'W', icon: <Contrast size={18} strokeWidth={1.5} /> },
  { id: 'measure', name: 'Ruler', key: 'R', icon: <Ruler size={18} strokeWidth={1.5} /> },
  { id: 'brush', name: 'Brush', key: 'B', icon: <Brush size={18} strokeWidth={1.5} /> },
  { id: 'eraser', name: 'Eraser', key: 'E', icon: <Eraser size={18} strokeWidth={1.5} /> },
  { id: 'threshold', name: 'Threshold brush', key: 'T', icon: <Blend size={18} strokeWidth={1.5} /> },
  { id: 'scissors', name: 'Scissors', key: 'S', icon: <Scissors size={18} strokeWidth={1.5} /> },
  { id: 'fill', name: 'Fill', key: 'F', icon: <PaintBucket size={18} strokeWidth={1.5} /> },
];

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const hasSegments = useStore((s) => s.segments.length > 0);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const bindings = useShortcuts((s) => s.bindings);
  const key = (id: ActionId) => (bindings[id] ? `  ${formatCombo(bindings[id], isMac)}` : '');

  const button = (t: (typeof TOOLS)[number]) => {
    const disabled = EDIT_TOOLS.includes(t.id) && !hasSegments;
    return (
      <button
        key={t.id}
        className="toolbtn"
        role="radio"
        aria-checked={tool === t.id}
        aria-disabled={disabled}
        aria-label={t.name}
        data-tool={t.id}
        data-tour={t.id === 'brush' ? 'brush' : undefined}
        data-tip={disabled ? 'Add a segment to start editing.' : `${t.name}${key(`tool.${t.id}` as ActionId)}`}
        data-tip-side="right"
        onClick={() => setTool(t.id)}
      >
        {t.icon}
      </button>
    );
  };

  return (
    <nav className="rail" role="radiogroup" aria-label="Tools" data-tour="tools">
      {TOOLS.slice(0, 5).map(button)}
      <hr />
      {TOOLS.slice(5).map(button)}
      <div className="grow" />
      <button className="toolbtn" aria-label="Undo" data-tour="undo" data-tip={`Undo${key('edit.undo')}`} data-tip-side="right" disabled={!canUndo} onClick={undo}>
        <Undo2 size={18} strokeWidth={1.5} />
      </button>
      <button className="toolbtn" aria-label="Redo" data-tour="redo" data-tip={`Redo${key('edit.redo')}`} data-tip-side="right" disabled={!canRedo} onClick={redo}>
        <Redo2 size={18} strokeWidth={1.5} />
      </button>
      <button
        className="toolbtn"
        aria-label="Keyboard shortcuts"
        data-tour="shortcuts"
        data-tip={`Shortcuts${key('help.shortcuts')}`}
        data-tip-side="right"
        onClick={() => set({ settings: 'shortcuts' })}
      >
        <Keyboard size={18} strokeWidth={1.5} />
      </button>
    </nav>
  );
}
