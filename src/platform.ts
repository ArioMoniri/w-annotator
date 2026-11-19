/** Everything that differs between the desktop app and a plain browser tab. */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const SERVER_KEY = 'w-annotator:server';
const NAME_KEY = 'w-annotator:name';

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage is unavailable; the value just won't be remembered */
  }
}

export const savedName = () => read(NAME_KEY);
export const saveName = (name: string) => write(NAME_KEY, name);

export const savedServer = () => read(SERVER_KEY);
export const saveServer = (url: string) => write(SERVER_KEY, url.trim());

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
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({
      defaultPath: suggested,
      filters: [
        { name: 'NIfTI', extensions: ['nii.gz', 'nii'] },
        { name: 'MetaImage', extensions: ['mha'] },
        { name: 'NRRD', extensions: ['nrrd'] },
      ],
    });
    if (!path) return null;
    const name = path.split(/[\\/]/).pop() ?? suggested;
    await invoke('write_file', make(name), { headers: { 'x-path': encodeURIComponent(path) } });
    return name;
  }
  const bytes = make(suggested);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggested;
}

/** Files the app was launched with ("Open with"), as name + bytes. */
export async function launchFiles(): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (!isTauri) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const paths = await invoke<string[]>('opened_files');
    const out: { name: string; bytes: Uint8Array }[] = [];
    for (const path of paths) {
      const data = await invoke<ArrayBuffer>('read_file', { path });
      out.push({ name: path.split(/[\\/]/).pop() ?? path, bytes: new Uint8Array(data) });
    }
    return out;
  } catch {
    return [];
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

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
