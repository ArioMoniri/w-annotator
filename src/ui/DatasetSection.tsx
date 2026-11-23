import { Check, ChevronDown, ChevronRight, ChevronUp, Minus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { StartFrom } from '../dataset/layout';
import { emptyProgress, tally } from '../dataset/progress';
import { chooseOutputFolder, closeDataset, finishCase, openCase, setStartFrom, skipCase, stepCase, zipOutput } from '../session';
import { useStore } from '../state/store';
import { useKeyHint } from './common';

const leaf = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/**
 * The cases of an open dataset folder, by patient. A click opens a case with
 * the mask it starts from; the arrows step through them in order. With a
 * folder to save into, "Done and next" saves the case there and moves on,
 * and "Zip for email…" makes one file of what is saved.
 */
export function DatasetSection() {
  const ds = useStore((s) => s.dataset);
  const busy = useStore((s) => !!s.busy);
  const [open, setOpen] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const key = useKeyHint();
  const current = ds?.current;

  // Keep the case on screen in sight when it changes.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current, open]);

  if (!ds) return null;
  const byId = new Map(ds.cases.map((c) => [c.id, c]));
  const at = ds.current ? ds.cases.findIndex((c) => c.id === ds.current) + 1 : 0;
  const tip = (label: string, id: 'dataset.previous' | 'dataset.next' | 'dataset.done') => `${label}  ${key(id)}`.trimEnd();
  const counts = tally(ds, { ...emptyProgress(ds.name), cases: ds.progress });

  return (
    <section className="files dataset" aria-label="Dataset" data-open={open}>
      <button className="files-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Dataset</span>
        <span className="count" aria-label={at ? `Case ${at} of ${ds.cases.length}` : `${ds.cases.length} cases`}>
          {at ? `${at} / ${ds.cases.length}` : ds.cases.length}
        </span>
      </button>
      {open && (
        <div className="filelist">
          <div className="dataset-bar">
            <span className="name" title={ds.name}>
              {ds.name}
            </span>
            <button className="iconbtn sm" aria-label="Previous case" data-tip={tip('Previous case', 'dataset.previous')} data-tip-side="top" onClick={() => stepCase(-1)}>
              <ChevronUp size={14} />
            </button>
            <button className="iconbtn sm" aria-label="Next case" data-tip={tip('Next case', 'dataset.next')} data-tip-side="top" onClick={() => stepCase(1)}>
              <ChevronDown size={14} />
            </button>
            <button className="iconbtn sm" aria-label="Close dataset" data-tip="Close dataset" data-tip-side="top" onClick={closeDataset}>
              <X size={14} />
            </button>
          </div>
          <label className="dataset-start">
            <span>Start from</span>
            <select className="select" value={ds.start} onChange={(e) => setStartFrom(e.target.value as StartFrom)}>
              <option value="own">This scan’s label</option>
              <option value="first">First scan’s label</option>
            </select>
          </label>
          <div className="dataset-start dataset-out">
            <span>Save to</span>
            {ds.output ? (
              <>
                <span className="folder" title={ds.output}>
                  {ds.output}
                </span>
                <button className="btn text" onClick={() => void chooseOutputFolder()}>
                  Change…
                </button>
              </>
            ) : (
              <button className="btn secondary" onClick={() => void chooseOutputFolder()}>
                Choose folder…
              </button>
            )}
          </div>
          {ds.output && (
            <div className="dataset-tally">
              <span aria-live="polite">
                {counts.done} done · {counts.skipped} skipped · {counts.left} left
              </span>
              <button
                className="btn text"
                disabled={counts.done + counts.skipped === 0 || busy}
                data-tip="One file of the saved masks and the progress, to attach to an email"
                data-tip-side="top"
                onClick={() => void zipOutput()}
              >
                Zip for email…
              </button>
            </div>
          )}
          <div className="dataset-actions">
            <button className="btn secondary" disabled={!ds.current || busy} onClick={() => void skipCase()}>
              Skip
            </button>
            <button className="btn primary" disabled={!ds.current || busy} data-tip={tip('Save to the folder and open the next case', 'dataset.done')} data-tip-side="top" onClick={() => void finishCase()}>
              Done and next
            </button>
          </div>
          <div className="caselist" role="listbox" aria-label="Cases" ref={list}>
            {ds.patients.map((p) => (
              <div key={p.id} role="group" aria-label={`Patient ${p.id}`}>
                {(p.cases.length > 1 || p.id !== p.cases[0]) && (
                  <div className="patient" aria-hidden>
                    {p.id}
                  </div>
                )}
                {p.cases.map((id) => {
                  const c = byId.get(id)!;
                  const status = ds.progress[id]?.status;
                  const words = [id, c.label ? '' : 'no label', status ?? ''].filter(Boolean).join(', ');
                  return (
                    <button
                      key={id}
                      className="caserow"
                      role="option"
                      aria-selected={ds.current === id}
                      aria-label={words}
                      data-status={status}
                      title={c.label ? leaf(c.label) : 'No label in the labels folder'}
                      onClick={() => ds.current !== id && void openCase(id)}
                    >
                      <span className="mark" aria-hidden>
                        {status === 'done' ? <Check size={12} /> : status === 'skipped' ? <Minus size={12} /> : null}
                      </span>
                      <span>{c.scan || c.id}</span>
                      {!c.label && <span className="nolabel">no label</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
