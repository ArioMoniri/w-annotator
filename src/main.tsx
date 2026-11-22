// First, so the saved appearance is applied before anything renders.
import './state/theme';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import * as recovery from './recovery';
import { startLogCapture } from './report';
import * as session from './session';
import * as settings from './state/settings';
import * as windowing from './windowing';
import * as engine from './viewer/engine';
import { useStore } from './state/store';
import { guardPageGestures } from './ui/gestureInput';
import './styles.css';

// Keeps the last few console errors in memory, for a problem report the user chooses to send.
startLogCapture();

// Whatever the content security policy of the desktop app refused, kept in memory for the tests of the
// built app: a policy that is too tight shows up there instead of as a feature that quietly stopped working.
const blocked: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  if (blocked.length < 100) blocked.push(`${e.effectiveDirective} ${e.blockedURI || 'inline'}${e.sourceFile ? ` (${e.sourceFile}:${e.lineNumber})` : ''}`);
});

// A handle for end-to-end tests and for debugging from the console.
(window as unknown as Record<string, unknown>).__w = { session, engine, store: useStore, settings, recovery, windowing, blocked };

// A pinch or Ctrl+wheel never zooms the window itself.
guardPageGestures();

createRoot(document.getElementById('root')!).render(<App />);
