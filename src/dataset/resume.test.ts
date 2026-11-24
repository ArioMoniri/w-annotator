import { describe, expect, it, vi } from 'vitest';
import { commonFolder, loadResume, outputFor, rememberOutputFor, resumeDataset, saveResume, type Resume } from './resume';

/** A Storage that lives in a plain object. */
function memory(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, String(v)),
  };
}

const t1: Resume = { name: 't1', root: 'D:\\data\\t1', output: 'D:\\data\\q', case: '10000_0002', start: 'first' };

describe('commonFolder', () => {
  it('is the deepest folder holding every file, on Windows and elsewhere', () => {
    expect(commonFolder(['D:\\data\\t1\\ImagesTr\\a_0000.mha', 'D:\\data\\t1\\LabelsTr\\a.mha', 'D:\\data\\t1\\dataset.json'])).toBe('D:\\data\\t1');
    expect(commonFolder(['/home/me/t1/ImagesTr/a_0000.mha', '/home/me/t1/LabelsTr/a.mha'])).toBe('/home/me/t1');
  });

  it('is the one folder when everything is in it', () => {
    expect(commonFolder(['/home/me/t1/ImagesTr/a_0000.mha', '/home/me/t1/ImagesTr/b_0000.mha'])).toBe('/home/me/t1/ImagesTr');
  });

  it('does not stop inside a name that two folders share', () => {
    expect(commonFolder(['/data/t10/a.mha', '/data/t11/b.mha'])).toBe('/data');
  });

  it('is null without paths', () => {
    expect(commonFolder([])).toBeNull();
  });
});

describe('remembering the open dataset', () => {
  it('keeps the dataset, its Save to folder and the case for this window', () => {
    const store = memory();
    saveResume(t1, store);
    expect(loadResume(store)).toEqual(t1);
    saveResume(null, store);
    expect(loadResume(store)).toBeNull();
  });

  it('ignores what it cannot read', () => {
    const store = memory();
    store.setItem('w-annotator:dataset', '{not json');
    expect(loadResume(store)).toBeNull();
    store.setItem('w-annotator:dataset', JSON.stringify({ name: 3 }));
    expect(loadResume(store)).toBeNull();
  });

  it('remembers the last Save to folder of each dataset', () => {
    const store = memory();
    expect(outputFor('D:\\data\\t1', store)).toBeNull();
    rememberOutputFor('D:\\data\\t1', 'D:\\data\\q', store);
    rememberOutputFor('D:\\data\\t2', 'D:\\data\\r', store);
    expect(outputFor('D:\\data\\t1', store)).toBe('D:\\data\\q');
    expect(outputFor('D:\\data\\t2', store)).toBe('D:\\data\\r');
  });
});

describe('coming back after a reload', () => {
  function deps(saved: Resume | null) {
    const store = memory();
    if (saved) saveResume(saved, store);
    return {
      store,
      reopenFolder: vi.fn(async (_path: string) => [{ path: 'D:\\data\\t1\\ImagesTr\\10000_0002_0000.mha' }]),
      reopenOutput: vi.fn(async (_path: string) => ({ name: 'q' })),
      open: vi.fn(async () => undefined),
      say: vi.fn(),
    };
  }

  it('opens the same dataset, Save to folder and case again', async () => {
    const d = deps(t1);
    await resumeDataset(d);
    expect(d.reopenFolder).toHaveBeenCalledWith('D:\\data\\t1');
    expect(d.reopenOutput).toHaveBeenCalledWith('D:\\data\\q');
    expect(d.open).toHaveBeenCalledWith([{ path: 'D:\\data\\t1\\ImagesTr\\10000_0002_0000.mha' }], { output: { name: 'q' }, case: '10000_0002', start: 'first' });
    expect(d.say).not.toHaveBeenCalled();
  });

  it('opens the dataset without a Save to folder when there was none', async () => {
    const d = deps({ ...t1, output: null });
    await resumeDataset(d);
    expect(d.reopenOutput).not.toHaveBeenCalled();
    expect(d.open).toHaveBeenCalledWith(expect.anything(), { output: null, case: '10000_0002', start: 'first' });
  });

  it('asks for the folder again when it cannot be reopened, as in a browser', async () => {
    const browser = deps({ ...t1, root: null, output: null });
    await resumeDataset(browser);
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.say).toHaveBeenCalledWith('Open the dataset folder again to carry on with t1.');
    expect(loadResume(browser.store)).toBeNull();

    const refused = deps(t1);
    refused.reopenFolder.mockResolvedValue(null as never);
    await resumeDataset(refused);
    expect(refused.open).not.toHaveBeenCalled();
    expect(refused.say).toHaveBeenCalledWith('Open the dataset folder again to carry on with t1.');
  });

  it('does nothing when no dataset was open', async () => {
    const d = deps(null);
    await resumeDataset(d);
    expect(d.open).not.toHaveBeenCalled();
    expect(d.say).not.toHaveBeenCalled();
  });
});
