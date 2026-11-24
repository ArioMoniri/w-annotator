import { get, set } from './state/store';

/** A newer release the updater found. */
export interface FoundUpdate {
  version: string;
  download: () => Promise<void>;
  /** Installs the downloaded release and restarts the app. */
  install: () => Promise<void>;
}

/** Looks for a newer release; null when this is the latest. Throws when it cannot tell. */
export interface Updater {
  check: () => Promise<FoundUpdate | null>;
}

/** What the update check in Settings shows. */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string }
  | { kind: 'latest' }
  | { kind: 'ready'; version: string }
  | { kind: 'failed' };

let running: Promise<UpdateStatus> | null = null;
/** Where the running check is, for a check asked for while it runs. */
let phase: UpdateStatus = { kind: 'idle' };
/** True once someone asked for the running check by hand, so its steps are shown. */
let shown = false;

function step(next: UpdateStatus): void {
  phase = next;
  if (shown) set({ updateStatus: next });
}

async function look(updater: Updater): Promise<UpdateStatus> {
  try {
    step({ kind: 'checking' });
    const found = await updater.check();
    if (!found) return { kind: 'latest' };
    step({ kind: 'downloading', version: found.version });
    await found.download();
    // A check asked for by hand shows the banner again even after Later.
    set({ update: { version: found.version, install: found.install }, ...(shown ? { updateDismissed: false } : {}) });
    return { kind: 'ready', version: found.version };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Looks for a newer release and downloads it. The launch check is `quiet`: it
 * shows nothing until an update is ready (the banner). A check asked for in
 * Settings shows each step, and joins a check that is already running.
 */
export async function checkForUpdates({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  const { updater, update } = get();
  if (!updater) return;
  if (update) {
    if (!quiet) set({ updateStatus: { kind: 'ready', version: update.version } });
    return;
  }
  if (!quiet) {
    shown = true;
    set({ updateStatus: running ? phase : { kind: 'checking' } });
  }
  if (!running) {
    running = look(updater).finally(() => {
      running = null;
    });
  }
  const result = await running;
  if (shown) {
    shown = false;
    phase = { kind: 'idle' };
    set({ updateStatus: result });
  }
}
