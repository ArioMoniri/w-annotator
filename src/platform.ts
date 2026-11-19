/** Everything that differs between the desktop app and a plain browser tab. */

import { getSettings, setSetting } from './state/settings';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const savedName = () => getSettings().displayName;
export const saveName = (name: string) => setSetting('displayName', name);

export const savedServer = () => getSettings().server;
export const saveServer = (url: string) => setSetting('server', url.trim());

/** Shown under the room server field, in the room dialog and in Settings. */
export const SERVER_HELP = isTauri
  ? 'Leave empty to host the room on this computer for people on the same network. Enter a room server address to work over the internet.'
  : 'Address of the room server.';

/** The room server to use, or null when this computer should host. */
export function relayServer(): string | null {
  const saved = savedServer();
  if (saved) return saved.replace(/^http/, 'ws').replace(/\/+$/, '');
  const fromBuild = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (fromBuild) return fromBuild;
  return isTauri ? null : `ws://${location.hostname}:8787`;
}

/** Start the room server built into the desktop app. Returns its address on the local network. */
export async function hostRoom(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ port: number; addresses: string[] }>('host_room', {});
    const host = info.addresses[0] ?? '127.0.0.1';
    return `ws://${host}:${info.port}`;
  } catch {
    return null;
  }
}

export async function stopHosting(): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('stop_hosting');
  } catch {
    /* nothing was running */
  }
}

/**
 * Ask where to save, then write. `make` gets the chosen file name so the
 * format can follow the extension. Returns the saved name, or null if cancelled.
 */
export async function saveBytes(suggested: string, make: (name: string) => Uint8Array): Promise<string | null> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    // The app only writes to a path the user picked in its own save dialog.
    const path = await invoke<string | null>('pick_save_path', {
      defaultName: suggested,
      filters: [
        { name: 'NIfTI', extensions: ['nii.gz', 'nii'] },
        { name: 'MetaImage', extensions: ['mha'] },
        { name: 'NRRD', extensions: ['nrrd'] },
        { name: 'DICOM SEG', extensions: ['dcm'] },
      ],
    });
    if (!path) return null;
    const name = path.split(/[\\/]/).pop() ?? suggested;
    await invoke('write_file', make(name), { headers: { 'x-file-path': encodeURIComponent(path) } });
    savedPath = path;
    return name;
  }
  savedPath = null;
  const bytes = make(suggested);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggested;
}

let savedPath: string | null = null;
/** Desktop app: where the last `saveBytes` wrote. Null in a browser, which does not tell. */
export const lastSavedPath = (): string | null => savedPath;

const leaf = (path: string) => path.split(/[\\/]/).pop() ?? path;

export interface GivenFile {
  name: string;
  bytes: Uint8Array;
  path: string;
}

export interface GivenHandlers {
  /** Files are about to be read from disk. */
  reading: (count: number) => void;
  /** One batch, read and ready to open together. Awaited before the next batch is read. */
  files: (files: GivenFile[]) => Promise<void> | void;
  /** Something could not be taken, in words for the user. */
  error: (text: string) => void;
}

/**
 * Desktop app: files the system hands over, in batches that belong together:
 * dropped on the window, opened with the app ("Open with", double click, the
 * command line), at launch or while running. The Rust side makes each path
 * readable when it arrives; this side can only read what it was given.
 * Returns a function that stops listening.
 */
export async function onFilesGiven(handlers: GivenHandlers): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    // One batch at a time, in the order they arrived.
    let queue: Promise<void> = Promise.resolve();
    const off = await listen<{ paths: string[]; error: string | null }>('files-given', (event) => {
      const { paths, error } = event.payload;
      queue = queue.then(async () => {
        if (error) handlers.error(error);
        if (paths.length === 0) return;
        handlers.reading(paths.length);
        const out: GivenFile[] = [];
        for (const path of paths) {
          try {
            const data = await invoke<ArrayBuffer>('read_file', { path });
            out.push({ name: leaf(path), bytes: new Uint8Array(data), path });
          } catch {
            handlers.error(`Can't read ${leaf(path)}. Check that the file still exists.`);
          }
        }
        try {
          await handlers.files(out);
        } catch {
          /* the handler reports its own errors */
        }
      });
    });
    // Files the app was launched with have waited for this.
    await invoke('files_ready');
    return off;
  } catch {
    return () => {};
  }
}

/**
 * Desktop app: files are being dragged over the window. `names` are the file
 * names when the system tells them before the drop, otherwise empty; null when
 * the drag left or ended. The drop itself arrives through `onFilesGiven`.
 */
export async function onNativeDrag(handler: (names: string[] | null) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return await getCurrentWebview().onDragDropEvent((event) => {
      const drag = event.payload;
      if (drag.type === 'enter') handler(drag.paths.map(leaf));
      else if (drag.type === 'leave' || drag.type === 'drop') handler(null);
    });
  } catch {
    return () => {};
  }
}

/** Desktop app: shows a file the user opened in Finder, Explorer or the file manager. */
export async function revealFile(path: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('reveal_file', { path });
    return true;
  } catch {
    return false;
  }
}

/** What the system's file manager is called, for the menu item. */
export const REVEAL_LABEL =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
    ? 'Show in Finder'
    : typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
      ? 'Show in Explorer'
      : 'Show in folder';

/**
 * Test hook of the desktop app: when it was launched with `W_FILES_DUMP=<file>`,
 * writes what `describe` returns to that file twice a second. Does nothing otherwise.
 */
export async function startFilesDump(describe: () => unknown): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const write = () => invoke<boolean>('dump_files', { text: JSON.stringify(describe()) });
    if (await write()) setInterval(() => void write().catch(() => undefined), 500);
  } catch {
    /* not available */
  }
}

export interface ReadyUpdate {
  version: string;
  install: () => Promise<void>;
}

/** Looks for a new release and downloads it in the background. */
export async function findUpdate(): Promise<ReadyUpdate | null> {
  if (!isTauri) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;
    await update.download();
    return {
      version: update.version,
      install: async () => {
        await update.install();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}

/**
 * Opens a web page in the user's browser. The desktop app may only open pages
 * under the project's GitHub repository (see src-tauri/capabilities).
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
