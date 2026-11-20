import type { InputFile } from '../io';
import { openFiles } from '../session';

export async function toInputFiles(files: File[]): Promise<InputFile[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

function pick(role: 'image' | 'mask' | undefined, folder = false): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.setAttribute('webkitdirectory', '');
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (files.length) await openFiles(await toInputFiles(files), role);
  };
  // Some webviews ignore a click on an input that is not in the document.
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', () => setTimeout(() => input.remove(), 0));
  input.click();
}

export const pickImage = () => pick('image');
export const pickDicomFolder = () => pick('image', true);
export const pickMask = () => pick('mask');

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  file(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader(): { readEntries(cb: (e: Entry[]) => void, err: (e: unknown) => void): void };
}

async function walk(entry: Entry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await new Promise<File>((res, rej) => entry.file(res, rej)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

/**
 * Files from a drop, including everything inside dropped folders.
 *
 * The drop's data is only readable while the event is being handled, so
 * everything is taken from it before the first wait. A file comes from its
 * item directly; only folders are walked, because WebKit can hand out an entry
 * for a single file that then fails to open.
 */
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const listed = Array.from(data.files);
  const files: File[] = [];
  const folders: Entry[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = (item as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry?.isDirectory) folders.push(entry);
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0 && folders.length === 0) return listed;
  for (const folder of folders) await walk(folder, files);
  return files.filter((f) => !f.name.startsWith('.'));
}
