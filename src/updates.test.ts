import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, set } from './state/store';
import { checkForUpdates, type FoundUpdate, type Updater } from './updates';

/** A release the fake updater finds, with a download that waits until it is let go. */
function release(version: string) {
  let finish: (failed?: boolean) => void = () => undefined;
  const found: FoundUpdate = {
    version,
    download: vi.fn(() => new Promise<void>((resolve, reject) => (finish = (failed) => (failed ? reject(new Error('download failed')) : resolve())))),
    install: vi.fn(async () => undefined),
  };
  return { found, finish: (failed?: boolean) => finish(failed) };
}

function updater(check: Updater['check']): Updater {
  return { check: vi.fn(check) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('checking for updates', () => {
  beforeEach(() => set({ update: null, updateDismissed: false, updateStatus: { kind: 'idle' }, updater: null }));

  it('says so when this is the latest version', async () => {
    set({ updater: updater(async () => null) });
    const done = checkForUpdates();
    expect(get().updateStatus).toEqual({ kind: 'checking' });
    await done;
    expect(get().updateStatus).toEqual({ kind: 'latest' });
    expect(get().update).toBeNull();
  });

  it('downloads a new version, then offers it like the launch check does', async () => {
    const r = release('0.2.0');
    set({ updater: updater(async () => r.found), updateDismissed: true });
    const done = checkForUpdates();
    await flush();
    expect(get().updateStatus).toEqual({ kind: 'downloading', version: '0.2.0' });
    expect(get().update).toBeNull();
    r.finish();
    await done;
    expect(get().updateStatus).toEqual({ kind: 'ready', version: '0.2.0' });
    expect(get().update?.version).toBe('0.2.0');
    // Asked for by hand, so the banner shows again even after Later.
    expect(get().updateDismissed).toBe(false);
    await get().update!.install();
    expect(r.found.install).toHaveBeenCalledOnce();
  });

  it('says it could not check when the check fails', async () => {
    set({ updater: updater(async () => Promise.reject(new Error('offline'))) });
    await checkForUpdates();
    expect(get().updateStatus).toEqual({ kind: 'failed' });
  });

  it('says it could not check when the download fails, and offers nothing', async () => {
    const r = release('0.2.0');
    set({ updater: updater(async () => r.found) });
    const done = checkForUpdates();
    await flush();
    r.finish(true);
    await done;
    expect(get().updateStatus).toEqual({ kind: 'failed' });
    expect(get().update).toBeNull();
  });

  it('the launch check shows nothing until an update is ready', async () => {
    set({ updater: updater(async () => Promise.reject(new Error('offline'))) });
    await checkForUpdates({ quiet: true });
    expect(get().updateStatus).toEqual({ kind: 'idle' });

    const r = release('0.2.0');
    set({ updater: updater(async () => r.found) });
    const done = checkForUpdates({ quiet: true });
    await flush();
    expect(get().updateStatus).toEqual({ kind: 'idle' });
    r.finish();
    await done;
    expect(get().update?.version).toBe('0.2.0');
  });

  it('a check asked for while the launch check runs waits for it instead of starting another', async () => {
    const r = release('0.2.0');
    const u = updater(async () => r.found);
    set({ updater: u });
    const launch = checkForUpdates({ quiet: true });
    await flush();
    const asked = checkForUpdates();
    // It picks up where the launch check is.
    expect(get().updateStatus).toEqual({ kind: 'downloading', version: '0.2.0' });
    r.finish();
    await Promise.all([launch, asked]);
    expect(u.check).toHaveBeenCalledOnce();
    expect(get().updateStatus).toEqual({ kind: 'ready', version: '0.2.0' });
  });

  it('does not look again once an update is ready', async () => {
    const r = release('0.2.0');
    r.finish();
    const u = updater(async () => r.found);
    set({ updater: u, update: { version: '0.2.0', install: async () => undefined } });
    await checkForUpdates();
    expect(u.check).not.toHaveBeenCalled();
    expect(get().updateStatus).toEqual({ kind: 'ready', version: '0.2.0' });
  });

  it('does nothing where the app cannot update itself', async () => {
    await checkForUpdates();
    expect(get().updateStatus).toEqual({ kind: 'idle' });
  });
});
