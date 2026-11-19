import { createRoot } from 'react-dom/client';
import { App } from './App';
import * as session from './session';
import { useStore } from './state/store';
import './styles.css';

// A handle for end-to-end tests and for debugging from the console.
(window as unknown as Record<string, unknown>).__w = { session, store: useStore };

createRoot(document.getElementById('root')!).render(<App />);
