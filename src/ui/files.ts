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

/** Files from a drop, including everything inside dropped folders. */
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const entries: Entry[] = [];
  for (const item of Array.from(data.items)) {
    const entry = (item as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Array.from(data.files);
  const out: File[] = [];
  for (const e of entries) await walk(e, out);
  return out.filter((f) => !f.name.startsWith('.'));
}
