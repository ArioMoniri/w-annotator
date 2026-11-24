import { describe, expect, it } from 'vitest';
import { readLayout, type Dataset } from './layout';
import { PROGRESS_FILE, emptyProgress, mark, nextToDo, parseProgress, serialiseProgress, tally } from './progress';

const ds = readLayout([
  'imagesTr/a_0001_0000.mha',
  'imagesTr/a_0002_0000.mha',
  'imagesTr/b_0001_0000.mha',
  'labelsTr/a_0001.mha',
]) as Dataset;

const AT = '2026-11-22T10:00:00.000Z';

describe('progress file', () => {
  it('has a fixed name that is not a case name', () => {
    expect(PROGRESS_FILE).toBe('w-annotator-progress.json');
  });

  it('round-trips through text with cases in a stable order', () => {
    let p = emptyProgress('t1');
    p = mark(p, 'b_0001', { status: 'skipped', at: AT });
    p = mark(p, 'a_0001', { status: 'done', changed: true, start: 'own', at: AT });
    const text = serialiseProgress(p);
    expect(text.indexOf('a_0001')).toBeLessThan(text.indexOf('b_0001'));
    expect(text.endsWith('\n')).toBe(true);
    expect(parseProgress(text)).toEqual(p);
  });

  it('marking does not change the progress it was given', () => {
    const p = emptyProgress('t1');
    const q = mark(p, 'a_0001', { status: 'done', at: AT });
    expect(p.cases).toEqual({});
    expect(q.cases.a_0001.status).toBe('done');
  });

  it('reads damaged or foreign text as no progress at all', () => {
    expect(parseProgress('not json')).toEqual(emptyProgress(''));
    expect(parseProgress('[]')).toEqual(emptyProgress(''));
    expect(parseProgress('{"version":2,"cases":{}}')).toEqual(emptyProgress(''));
  });

  it('drops entries it does not understand and keeps the rest', () => {
    const text = JSON.stringify({
      version: 1,
      dataset: 't1',
      cases: {
        a_0001: { status: 'done', at: AT, changed: false, start: 'first' },
        a_0002: { status: 'maybe', at: AT },
        b_0001: 'done',
      },
    });
    expect(parseProgress(text)).toEqual({ version: 1, dataset: 't1', cases: { a_0001: { status: 'done', at: AT, changed: false, start: 'first' } } });
  });
});

describe('nextToDo', () => {
  it('finds the next case with no status after the one given, wrapping round', () => {
    const p = mark(emptyProgress('t1'), 'a_0002', { status: 'done', at: AT });
    expect(nextToDo(ds, p, 'a_0001')).toBe('b_0001');
    expect(nextToDo(ds, p, 'b_0001')).toBe('a_0001');
    expect(nextToDo(ds, p, null)).toBe('a_0001');
  });

  it('counts skipped cases as handled', () => {
    let p = mark(emptyProgress('t1'), 'a_0001', { status: 'done', at: AT });
    p = mark(p, 'a_0002', { status: 'skipped', at: AT });
    expect(nextToDo(ds, p, 'a_0001')).toBe('b_0001');
  });

  it('is null when every case is handled', () => {
    let p = emptyProgress('t1');
    for (const c of ds.cases) p = mark(p, c.id, { status: 'done', at: AT });
    expect(nextToDo(ds, p, 'a_0001')).toBeNull();
  });
});

describe('tally', () => {
  it('counts done, skipped and left over the cases of the dataset only', () => {
    let p = mark(emptyProgress('t1'), 'a_0001', { status: 'done', at: AT });
    p = mark(p, 'b_0001', { status: 'skipped', at: AT });
    p = mark(p, 'gone_0001', { status: 'done', at: AT });
    expect(tally(ds, p)).toEqual({ done: 1, skipped: 1, left: 1 });
  });
});
