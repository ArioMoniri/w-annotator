import { describe, expect, it } from 'vitest';
import { baseName, fileKind } from './names';

describe('fileKind', () => {
  it('recognises each format by extension, ignoring case', () => {
    expect(fileKind('a.nii')).toBe('nifti');
    expect(fileKind('a.NII.GZ')).toBe('nifti');
    expect(fileKind('a.hdr')).toBe('nifti');
    expect(fileKind('a.img')).toBe('nifti');
    expect(fileKind('scan.mha')).toBe('metaimage');
    expect(fileKind('scan.mhd')).toBe('metaimage');
    expect(fileKind('scan.zraw')).toBe('metaimage');
    expect(fileKind('seg.seg.nrrd')).toBe('nrrd');
    expect(fileKind('x.nhdr')).toBe('nrrd');
    expect(fileKind('IM0001.dcm')).toBe('dicom');
    expect(fileKind('IM0001.DICOM')).toBe('dicom');
  });
  it('returns unknown for anything else', () => {
    expect(fileKind('notes.txt')).toBe('unknown');
    expect(fileKind('IM0001')).toBe('unknown');
  });
});

describe('baseName', () => {
  it('strips known extensions, including double ones', () => {
    expect(baseName('liver.nii.gz')).toBe('liver');
    expect(baseName('liver.nii')).toBe('liver');
    expect(baseName('liver.seg.nrrd')).toBe('liver');
    expect(baseName('liver.nrrd')).toBe('liver');
    expect(baseName('ct.v2.mha')).toBe('ct.v2');
    expect(baseName('IM1.dcm')).toBe('IM1');
  });
  it('drops any folder part and keeps unknown extensions', () => {
    expect(baseName('/data/p1/ct.mhd')).toBe('ct');
    expect(baseName('C:\\data\\ct.NII.GZ')).toBe('ct');
    expect(baseName('notes.txt')).toBe('notes.txt');
  });
});
