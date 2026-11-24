import { describe, expect, it } from 'vitest';
import { caseAfter, maskName, readLayout, startLabel, type Dataset } from './layout';

/** The PANTHER task 1 layout: scan 0001 labelled by hand, later scans in a second image folder. */
const panther = [
  't1/ImagesTr/10000_0001_0000.mha',
  't1/ImagesTr/10001_0001_0000.mha',
  't1/ImagesTr_unlabeled/10000_0002_0000.mha',
  't1/ImagesTr_unlabeled/10000_0003_0000.mha',
  't1/ImagesTr_unlabeled/10001_0002_0000.mha',
  't1/LabelsTr/10000_0001.mha',
  't1/LabelsTr/10000_0002.nii.gz',
  't1/LabelsTr/10001_0001.mha',
  't1/LabelsTr/10001_0002.nii.gz',
  't1/dataset.json',
  't1/.DS_Store',
];

function read(paths: string[]): Dataset {
  const out = readLayout(paths);
  if ('error' in out) throw new Error(out.error);
  return out;
}

describe('readLayout', () => {
  it('pairs nnU-Net images with their labels and groups them by patient', () => {
    const ds = read(panther);
    expect(ds.cases.map((c) => c.id)).toEqual(['10000_0001', '10000_0002', '10000_0003', '10001_0001', '10001_0002']);
    expect(ds.cases[0]).toEqual({
      id: '10000_0001',
      patient: '10000',
      scan: '0001',
      image: 't1/ImagesTr/10000_0001_0000.mha',
      label: 't1/LabelsTr/10000_0001.mha',
      channels: 1,
    });
    expect(ds.cases[1].label).toBe('t1/LabelsTr/10000_0002.nii.gz');
    expect(ds.cases[2].label).toBeUndefined();
    expect(ds.patients).toEqual([
      { id: '10000', cases: ['10000_0001', '10000_0002', '10000_0003'] },
      { id: '10001', cases: ['10001_0001', '10001_0002'] },
    ]);
  });

  it('names the dataset after the folder that holds it', () => {
    expect(read(panther).name).toBe('t1');
    expect(read(['imagesTr/a_0000.nii.gz']).name).toBe('imagesTr');
  });

  it('accepts absolute paths with either kind of slash', () => {
    const ds = read(['D:\\data\\t1\\ImagesTr\\10000_0001_0000.mha', 'D:\\data\\t1\\LabelsTr\\10000_0001.mha']);
    expect(ds.name).toBe('t1');
    expect(ds.cases[0].label).toBe('D:\\data\\t1\\LabelsTr\\10000_0001.mha');
  });

  it('opens the first channel of a case with several and counts them', () => {
    const ds = read(['imagesTr/BraTS_001_0001.nii.gz', 'imagesTr/BraTS_001_0000.nii.gz', 'imagesTr/BraTS_001_0002.nii.gz']);
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0].image).toBe('imagesTr/BraTS_001_0000.nii.gz');
    expect(ds.cases[0].channels).toBe(3);
  });

  it('matches folder and case names in any case', () => {
    const ds = read(['IMAGESTR/Liver_7_0000.nii', 'labelstr/liver_7.nii']);
    expect(ds.cases[0].label).toBe('labelstr/liver_7.nii');
  });

  it('takes a label only from a labels folder', () => {
    // A file named like a case but beside the images is not its label.
    const ds = read(['imagesTr/a_0000.nii', 'imagesTr/a.nii']);
    expect(ds.cases[0].label).toBeUndefined();
  });

  it('keeps cases without a scan number as their own patient', () => {
    const ds = read(['imagesTr/liver_0000.nii', 'imagesTr/spleen_0000.nii']);
    expect(ds.patients).toEqual([
      { id: 'liver', cases: ['liver'] },
      { id: 'spleen', cases: ['spleen'] },
    ]);
    expect(ds.cases[0].scan).toBe('');
  });

  it('sorts numbers by value', () => {
    const ds = read(['imagesTr/p_10_0000.nii', 'imagesTr/p_9_0000.nii', 'imagesTr/p_100_0000.nii']);
    expect(ds.cases.map((c) => c.scan)).toEqual(['9', '10', '100']);
  });

  it('says so when there is no nnU-Net image in the folder', () => {
    expect(readLayout(['scans/ct.nii.gz', 'scans/ct_seg.nii.gz'])).toEqual({
      error: 'No images named like nnU-Net cases (case_0000.nii.gz) were found in this folder.',
    });
    expect(readLayout([])).toEqual({ error: 'No images named like nnU-Net cases (case_0000.nii.gz) were found in this folder.' });
  });
});

describe('startLabel', () => {
  const ds = read(panther);
  const find = (id: string) => ds.cases.find((c) => c.id === id)!;

  it('starts from the case’s own label', () => {
    expect(startLabel(ds, find('10000_0002'), 'own')).toBe('t1/LabelsTr/10000_0002.nii.gz');
    expect(startLabel(ds, find('10000_0003'), 'own')).toBeUndefined();
  });

  it('starts from the label of the patient’s first scan that has one', () => {
    expect(startLabel(ds, find('10000_0002'), 'first')).toBe('t1/LabelsTr/10000_0001.mha');
    expect(startLabel(ds, find('10000_0003'), 'first')).toBe('t1/LabelsTr/10000_0001.mha');
    expect(startLabel(ds, find('10001_0001'), 'first')).toBe('t1/LabelsTr/10001_0001.mha');
  });

  it('falls back to the case’s own label when the patient has no other', () => {
    const single = read(['imagesTr/x_0003_0000.nii', 'labelsTr/x_0003.nii']);
    expect(startLabel(single, single.cases[0], 'first')).toBe('labelsTr/x_0003.nii');
  });
});

describe('caseAfter', () => {
  const ds = read(panther);

  it('steps through the cases in list order and stops at the ends', () => {
    expect(caseAfter(ds, '10000_0003', 1)).toBe('10001_0001');
    expect(caseAfter(ds, '10001_0001', -1)).toBe('10000_0003');
    expect(caseAfter(ds, '10001_0002', 1)).toBeNull();
    expect(caseAfter(ds, '10000_0001', -1)).toBeNull();
  });

  it('starts at the first case when none is open', () => {
    expect(caseAfter(ds, null, 1)).toBe('10000_0001');
  });
});

describe('maskName', () => {
  it("is the case name with its image's extension, whatever the label folder holds", () => {
    const ds = read(panther);
    expect(maskName(ds.cases.find((c) => c.id === '10000_0002')!)).toBe('10000_0002.mha');
    expect(maskName(read(['imagesTr/a_0001_0000.nii.gz']).cases[0])).toBe('a_0001.nii.gz');
  });
});
