import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyText, openExternal } from '../platform';
import { collectDiagnostics, composeReport, type Diagnostics, type ReportKind } from '../report';
import { getImage, getMask } from '../session';
import { set, toast, useStore } from '../state/store';
import { Modal } from './common';

/**
 * Composes a bug report or an idea and hands it to GitHub's new-issue form in
 * the browser. The app sends nothing itself.
 */
export function ReportDialog() {
  const initial = useStore((s) => s.report);
  if (!initial) return null;
  return <ReportForm initial={initial} />;
}

function ReportForm({ initial }: { initial: ReportKind }) {
  const [kind, setKind] = useState<ReportKind>(initial);
  const [title, setTitle] = useState('');
  const [what, setWhat] = useState('');
  const [expected, setExpected] = useState('');
  const [steps, setSteps] = useState('');
  const [problem, setProblem] = useState('');
  const [proposal, setProposal] = useState('');
  const [include, setInclude] = useState(true);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void collectDiagnostics({ image: getImage(), mask: getMask() }).then((d) => live && setDiagnostics(d));
    return () => {
      live = false;
    };
  }, []);

  const close = () => set({ report: null });
  const tab = (next: ReportKind) => {
    setError('');
    setKind(next);
  };

  const report = composeReport(kind, {
    title,
    what,
    expected,
    steps,
    problem,
    proposal,
    diagnostics: include ? diagnostics : null,
  });

  /** Says what is missing, or returns true. */
  const ready = (): boolean => {
    if (!title.trim()) return setError('Add a short title.'), false;
    if (kind === 'bug' && !what.trim()) return setError('Say what happened.'), false;
    if (kind === 'idea' && !problem.trim()) return setError('Describe the problem.'), false;
    if (kind === 'idea' && !proposal.trim()) return setError('Say what you would like the app to do.'), false;
    setError('');
    return true;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready()) return;
    if (await openExternal(report.url)) close();
    else setError("Couldn't open the browser. Use Copy report and paste it into a new issue on GitHub.");
  };

  const copy = async () => {
    if (!ready()) return;
    if (await copyText(report.text)) toast('success', 'Report copied');
    else setError("Couldn't copy the report. Try again.");
  };

  const heading = kind === 'bug' ? 'Report a problem' : 'Suggest an idea';
  return (
    <Modal title={heading} onClose={close} wide>
      <button className="iconbtn close" aria-label="Close" onClick={close}>
        <X size={16} />
      </button>
      <div className="tabs">
        <div className="seg-control" role="tablist" aria-label="Kind of report">
          <button role="tab" aria-selected={kind === 'bug'} onClick={() => tab('bug')}>
            Bug
          </button>
          <button role="tab" aria-selected={kind === 'idea'} onClick={() => tab('idea')}>
            Idea
          </button>
        </div>
      </div>
      <form className="form" onSubmit={submit} noValidate>
        <label>
          Title
          <input type="text" value={title} maxLength={120} placeholder="A short summary" onChange={(e) => setTitle(e.target.value)} />
        </label>
        {kind === 'bug' ? (
          <>
            <label>
              What happened
              <textarea value={what} rows={3} placeholder="What you saw, including any error message" onChange={(e) => setWhat(e.target.value)} />
            </label>
            <label>
              What you expected
              <textarea value={expected} rows={2} onChange={(e) => setExpected(e.target.value)} />
            </label>
            <label>
              Steps to reproduce
              <textarea value={steps} rows={3} placeholder={'1. Open an image\n2. Open a mask\n3. …'} onChange={(e) => setSteps(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label>
              Problem
              <textarea value={problem} rows={3} placeholder="What you are trying to do, and what gets in the way" onChange={(e) => setProblem(e.target.value)} />
            </label>
            <label>
              Proposal
              <textarea value={proposal} rows={3} placeholder="What you would like the app to do" onChange={(e) => setProposal(e.target.value)} />
            </label>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
          Include technical details
        </label>
        {include && (
          <details>
            <summary>What will be sent</summary>
            <pre className="report-preview" data-testid="report-preview" tabIndex={0}>
              {report.details || 'Collecting…'}
            </pre>
            <span className="help">No file names or paths. Only what is listed here.</span>
          </details>
        )}
        <span className="help">Do not include patient names or screenshots of patient data.</span>
        <span className="help">GitHub opens in your browser. You review the report and submit it there with your GitHub account.</span>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
        <div className="footer">
          <button type="button" className="btn text lg" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn secondary lg" onClick={() => void copy()}>
            Copy report
          </button>
          <button type="submit" className="btn primary lg">
            Continue on GitHub
          </button>
        </div>
      </form>
    </Modal>
  );
}
