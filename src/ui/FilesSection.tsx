import { ChevronDown, ChevronRight, Ellipsis, Eye, EyeOff, Image as ImageIcon, Layers, Sun, SunDim } from 'lucide-react';
import { useCallback, useState } from 'react';
import { IMAGE_ROW, fileRows, type FileRow } from '../mask/collection';
import { REVEAL_LABEL, isTauri, revealFile } from '../platform';
import { closeImage, closeMask, saveMaskById, setActiveMask, setImageDimmed, setMaskVisible } from '../session';
import { set, toast, useStore } from '../state/store';
import { useDismiss } from './common';

async function reveal(path: string): Promise<void> {
  if (!(await revealFile(path))) toast('error', "Couldn't show the file. It may have been moved.");
}

function Row({ row }: { row: FileRow }) {
  const [menu, setMenu] = useState(false);
  const [anchor, setAnchor] = useState<React.CSSProperties>({});
  const close = useCallback(() => setMenu(false), []);
  const ref = useDismiss<HTMLDivElement>(menu, close);
  const image = row.kind === 'image';
  const pick = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };
  const canReveal = isTauri && !!row.path;
  const eyeLabel = image ? (row.visible ? 'Dim image' : 'Show image at full brightness') : row.visible ? 'Hide' : 'Show';

  return (
    <div className="filerow" data-file={row.id} data-kind={row.kind} data-active={row.active} data-hidden={!row.visible}>
      {image ? (
        <span className="mark" aria-hidden />
      ) : (
        <button
          className="mark"
          role="radio"
          aria-checked={row.active}
          aria-label={`Edit ${row.label}`}
          data-tip={row.active ? 'Being edited' : 'Edit this mask'}
          data-tip-side="top"
          onClick={() => setActiveMask(row.id)}
        />
      )}
      <span className="kind" style={row.color ? { color: row.color } : undefined} aria-hidden>
        {image ? <ImageIcon size={14} /> : <Layers size={14} />}
      </span>
      <span className="name" title={row.detail}>
        {row.label}
        {row.dirty && (
          <span className="unsaved" role="img" aria-label="Unsaved changes">
            {' '}
            •
          </span>
        )}
      </span>
      <button
        className="iconbtn sm act"
        data-on={!row.visible}
        aria-label={eyeLabel}
        aria-pressed={!row.visible}
        data-tip={eyeLabel}
        data-tip-side="top"
        onClick={() => (image ? setImageDimmed(row.visible) : setMaskVisible(row.id, !row.visible))}
      >
        {image ? row.visible ? <Sun size={14} /> : <SunDim size={14} /> : row.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button
        className="iconbtn sm act"
        data-on={menu}
        aria-label={`More for ${row.label}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = (e.currentTarget.closest('.filerow') as HTMLElement).getBoundingClientRect();
          setAnchor({ position: 'fixed', top: r.bottom - 2, right: window.innerWidth - r.right + 4 });
          setMenu(!menu);
        }}
      >
        <Ellipsis size={14} />
      </button>
      {menu && (
        <div className="menu" role="menu" ref={ref} style={anchor}>
          {!image && (
            <>
              <button className="item" role="menuitem" disabled={row.active} onClick={pick(() => setActiveMask(row.id))}>
                Make active
              </button>
              <button className="item" role="menuitem" onClick={pick(() => void saveMaskById(row.id))}>
                Save…
              </button>
            </>
          )}
          {canReveal && (
            <button className="item" role="menuitem" onClick={pick(() => void reveal(row.path!))}>
              {REVEAL_LABEL}
            </button>
          )}
          {(!image || canReveal) && <hr />}
          <button className="item" role="menuitem" onClick={pick(() => (image ? closeImage() : closeMask(row.id)))}>
            {image ? 'Close image' : 'Close'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * What is open: the image and every mask on it. One mask is being edited; the
 * others are drawn as outlines so two masks can be compared.
 */
export function FilesSection() {
  const open = useStore((s) => s.filesOpen);
  const image = useStore((s) => s.image);
  const masks = useStore((s) => s.masks);
  const activeMask = useStore((s) => s.activeMask);
  const maskName = useStore((s) => s.maskName);
  const dirty = useStore((s) => s.dirty);
  const maskHidden = useStore((s) => s.maskHidden);
  const imageDimmed = useStore((s) => s.imageDimmed);
  const rows = fileRows({ image, masks, activeMask, maskName, dirty, maskHidden, imageDimmed });
  const imageRow = rows.find((r) => r.id === IMAGE_ROW);
  const maskRows = rows.filter((r) => r.kind === 'mask');

  return (
    <section className="files" aria-label="Files" data-open={open}>
      <button className="files-head" aria-expanded={open} onClick={() => set({ filesOpen: !open })}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Files</span>
        {!open && <span className="count">{rows.length}</span>}
      </button>
      {open && (
        <div className="filelist">
          {imageRow && <Row row={imageRow} />}
          <div role="radiogroup" aria-label="Mask being edited">
            {maskRows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
