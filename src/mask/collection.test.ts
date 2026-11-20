import { describe, expect, it } from 'vitest';
import { COMPARE_COLORS, IMAGE_ROW, MAX_MASKS, MaskSet, fileRows, shortName } from './collection';

const m = (id: string) => ({ id });

describe('MaskSet', () => {
  it('makes the first mask active, whatever is asked', () => {
    const set = new MaskSet<{ id: string }>();
    expect(set.active).toBeNull();
    expect(set.add(m('a'), false)).toBe(true);
    expect(set.active?.id).toBe('a');
    expect(set.others).toEqual([]);
  });

  it('adds later masks for comparison unless asked to make them active', () => {
    const set = new MaskSet<{ id: string }>();
    set.add(m('a'), true);
    set.add(m('b'), false);
    expect(set.active?.id).toBe('a');
    expect(set.others.map((x) => x.id)).toEqual(['b']);
    set.add(m('c'), true);
    expect(set.active?.id).toBe('c');
    expect(set.others.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('has exactly one active mask after any switch', () => {
    const set = new MaskSet<{ id: string }>();
    for (const id of ['a', 'b', 'c']) set.add(m(id), false);
    expect(set.activate('c')).toBe(true);
    expect(set.active?.id).toBe('c');
    expect(set.others.map((x) => x.id)).toEqual(['a', 'b']);
    // Already active, or not there: nothing changes.
    expect(set.activate('c')).toBe(false);
    expect(set.activate('zz')).toBe(false);
    expect(set.active?.id).toBe('c');
  });

  it('stops at the limit and does not take the same mask twice', () => {
    const set = new MaskSet<{ id: string }>();
    for (let i = 0; i < MAX_MASKS; i++) expect(set.add(m(`m${i}`), false)).toBe(true);
    expect(set.full).toBe(true);
    expect(set.add(m('one-more'), true)).toBe(false);
    expect(set.size).toBe(MAX_MASKS);
    expect(set.active?.id).toBe('m0');
    const two = new MaskSet<{ id: string }>();
    two.add(m('a'), true);
    expect(two.add(m('a'), true)).toBe(false);
  });

  it('hands the active role to the next mask when the active one is closed', () => {
    const set = new MaskSet<{ id: string }>();
    for (const id of ['a', 'b', 'c']) set.add(m(id), false);
    set.activate('b');
    expect(set.remove('b')?.id).toBe('b');
    expect(set.active?.id).toBe('c');
    // The last in the list hands over to the one before it.
    expect(set.remove('c')?.id).toBe('c');
    expect(set.active?.id).toBe('a');
    set.remove('a');
    expect(set.active).toBeNull();
    expect(set.size).toBe(0);
  });

  it('keeps the active mask when another one is closed', () => {
    const set = new MaskSet<{ id: string }>();
    for (const id of ['a', 'b', 'c']) set.add(m(id), false);
    set.remove('b');
    expect(set.active?.id).toBe('a');
    expect(set.remove('nope')).toBeNull();
  });

  it('replaces a mask in place', () => {
    const set = new MaskSet<{ id: string }>();
    set.add(m('blank'), true);
    set.add(m('b'), false);
    expect(set.replace('blank', m('file'))).toBe(true);
    expect(set.all.map((x) => x.id)).toEqual(['file', 'b']);
    expect(set.active?.id).toBe('file');
    expect(set.replace('gone', m('x'))).toBe(false);
  });
});

describe('shortName', () => {
  it('drops the folder and the extension', () => {
    expect(shortName('/data/ct_seg.nii.gz')).toBe('ct_seg');
    expect(shortName('C:\\scans\\liver.seg.nrrd')).toBe('liver');
  });

  it('cuts the middle out of a long name', () => {
    const short = shortName('case_0042_portal_venous_phase_model_output_v3.nii.gz');
    expect(short).toBe('case_0042_p…_output_v3');
    expect(short.length).toBe(22);
  });
});

describe('fileRows', () => {
  const base = {
    image: { name: 'ct.mha', dims: [512, 512, 300], path: '/data/ct.mha' },
    masks: [
      { id: 'm1', name: 'stale name.nii', dirty: false, visible: true },
      { id: 'm2', name: 'model_seg.nii.gz', dirty: true, visible: false, path: '/data/model_seg.nii.gz' },
      { id: 'm3', name: null, dirty: false, visible: true },
    ],
    activeMask: 'm1',
    maskName: 'fixed_seg.nii.gz',
    dirty: true,
    maskHidden: false,
    imageDimmed: false,
  };

  it('is empty with no image', () => {
    expect(fileRows({ ...base, image: null })).toEqual([]);
  });

  it('lists the image first, then the masks in the order opened', () => {
    const rows = fileRows(base);
    expect(rows.map((r) => [r.id, r.kind, r.label])).toEqual([
      [IMAGE_ROW, 'image', 'ct'],
      ['m1', 'mask', 'fixed_seg'],
      ['m2', 'mask', 'model_seg'],
      ['m3', 'mask', 'New mask'],
    ]);
    expect(rows[0].detail).toBe('ct.mha\n512 × 512 × 300');
    expect(rows[0].path).toBe('/data/ct.mha');
    expect(rows[2].path).toBe('/data/model_seg.nii.gz');
  });

  it('marks exactly one mask as active, and reads its name and unsaved state live', () => {
    const rows = fileRows(base);
    expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual(['m1']);
    expect(rows[1]).toMatchObject({ label: 'fixed_seg', dirty: true, visible: true, color: null });
    expect(fileRows({ ...base, maskHidden: true })[1].visible).toBe(false);
    expect(fileRows({ ...base, dirty: false })[1].dirty).toBe(false);
  });

  it('gives each comparison mask its own outline colour and its own state', () => {
    const rows = fileRows(base);
    expect(rows[2]).toMatchObject({ active: false, dirty: true, visible: false, color: COMPARE_COLORS[0] });
    expect(rows[3]).toMatchObject({ active: false, dirty: false, visible: true, color: COMPARE_COLORS[1] });
    // The colours follow the order among the comparison masks, not the place in the list.
    expect(fileRows({ ...base, activeMask: 'm2', maskName: 'model_seg.nii.gz' }).map((r) => r.color)).toEqual([
      null,
      COMPARE_COLORS[0],
      null,
      COMPARE_COLORS[1],
    ]);
  });

  it('shows the image as not fully visible while it is dimmed', () => {
    expect(fileRows(base)[0].visible).toBe(true);
    expect(fileRows({ ...base, imageDimmed: true })[0].visible).toBe(false);
  });
});
