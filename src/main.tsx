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

// A handle for end-to-end tests and for debugging from the console.
(window as unknown as Record<string, unknown>).__w = { session, engine, store: useStore, settings, recovery, windowing };

// A pinch or Ctrl+wheel never zooms the window itself.
guardPageGestures();

createRoot(document.getElementById('root')!).render(<App />);
