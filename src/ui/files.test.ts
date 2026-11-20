import { describe, expect, it } from 'vitest';
import { droppedFiles } from './files';

const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name);

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  file(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader(): { readEntries(cb: (e: FakeEntry[]) => void, err: (e: unknown) => void): void };
}

const fileEntry = (f: File, broken = false): FakeEntry => ({
  isFile: true,
  isDirectory: false,
  file: (cb, err) => (broken ? err(new Error('not readable')) : cb(f)),
  createReader: () => ({ readEntries: (cb) => cb([]) }),
});

const folderEntry = (children: FakeEntry[]): FakeEntry => {
  let sent = false;
  return {
    isFile: false,
    isDirectory: true,
    file: (_cb, err) => err(new Error('a folder')),
    createReader: () => ({
      readEntries: (cb) => {
        cb(sent ? [] : children);
        sent = true;
      },
    }),
  };
};

const transfer = (items: { entry: FakeEntry | null; file: File | null }[], files: File[]): DataTransfer =>
  ({
    items: items.map((i) => ({ kind: 'file', webkitGetAsEntry: () => i.entry, getAsFile: () => i.file })),
    files,
  }) as unknown as DataTransfer;

describe('droppedFiles', () => {
  it('returns plain dropped files', async () => {
    const a = file('ct.mha');
    const out = await droppedFiles(transfer([{ entry: fileEntry(a), file: a }], [a]));
    expect(out.map((f) => f.name)).toEqual(['ct.mha']);
  });

  it('takes a dropped file from the item itself when its entry cannot be read', async () => {
    // WebKit hands out an entry for a file that then fails to open.
    const a = file('seg.nii');
    const out = await droppedFiles(transfer([{ entry: fileEntry(a, true), file: a }], [a]));
    expect(out.map((f) => f.name)).toEqual(['seg.nii']);
  });

  it('uses the file list when the items give no entries', async () => {
    const a = file('seg.nii');
    const out = await droppedFiles(transfer([{ entry: null, file: null }], [a]));
    expect(out.map((f) => f.name)).toEqual(['seg.nii']);
  });

  it('reads everything inside a dropped folder and leaves out hidden files', async () => {
    const one = file('1.dcm');
    const two = file('2.dcm');
    const hidden = file('.DS_Store');
    const folder = folderEntry([fileEntry(one), folderEntry([fileEntry(two)]), fileEntry(hidden)]);
    const out = await droppedFiles(transfer([{ entry: folder, file: null }], []));
    expect(out.map((f) => f.name)).toEqual(['1.dcm', '2.dcm']);
  });
});
