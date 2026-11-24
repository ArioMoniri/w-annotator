import { describe, expect, it } from 'vitest';
import { DROP_TEXT, assignRoles, dropHint, labelLook, namedLikeMask, openChoice, sameCase, type Candidate } from './roles';

const image = (name: string): Candidate => ({ name, look: 'image' });
const labels = (name: string): Candidate => ({ name, look: 'labels' });
const maybe = (name: string): Candidate => ({ name, look: 'maybe' });

describe('labelLook', () => {
  it('calls a few whole numbers from 0 to 255 labels', () => {
    expect(labelLook(new Uint8Array([0, 0, 1, 2, 2, 0]))).toBe('labels');
    expect(labelLook(new Float32Array([0, 1, 3]))).toBe('labels');
  });

  it('calls many different small whole numbers a maybe', () => {
    expect(labelLook(Uint8Array.from({ length: 200 }, (_, i) => i))).toBe('maybe');
  });

  it('calls anything negative, fractional or large an image', () => {
    expect(labelLook(new Int16Array([0, -1000, 40]))).toBe('image');
    expect(labelLook(new Float32Array([0, 0.5]))).toBe('image');
    expect(labelLook(new Uint16Array([0, 256]))).toBe('image');
  });
});

describe('namedLikeMask', () => {
  it('reads the file name, not the folders above it', () => {
    expect(namedLikeMask('ct_seg.nii.gz')).toBe(true);
    expect(namedLikeMask('Liver-Mask.mha')).toBe(true);
    expect(namedLikeMask('labels.nrrd')).toBe(true);
    expect(namedLikeMask('/data/segmentations/ct.nii')).toBe(false);
    expect(namedLikeMask('C:\\masks\\ct.nii')).toBe(false);
  });

  it('knows the label of an nnU-Net image by its name', () => {
    expect(namedLikeMask('10000_0001.mha', '10000_0001_0000.mha')).toBe(true);
    expect(namedLikeMask('10000_0001.mha', '10000_0002_0000.mha')).toBe(false);
    expect(namedLikeMask('10000_0001.mha')).toBe(false);
  });
});

describe('sameCase', () => {
  it('pairs an nnU-Net image with its label, in any format and folder', () => {
    expect(sameCase('10000_0001_0000.mha', '10000_0001.mha')).toBe(true);
    expect(sameCase('/data/imagesTr/10000_0001_0000.mha', 'C:\\data\\labelsTr\\10000_0001.nii.gz')).toBe(true);
    expect(sameCase('BraTS_001_0003.nii.gz', 'brats_001.nii.gz')).toBe(true);
  });

  it('does not pair other cases, the image with itself, or names without a channel', () => {
    expect(sameCase('10000_0001_0000.mha', '10000_0002.mha')).toBe(false);
    expect(sameCase('10000_0001_0000.mha', '10000_0001_0000.mha')).toBe(false);
    expect(sameCase('ct.mha', 'ct.nii.gz')).toBe(false);
    expect(sameCase('10000_0001_000.mha', '10000_0001.mha')).toBe(false);
  });
});

describe('dropHint', () => {
  it('says open when nothing is open', () => {
    expect(dropHint(['ct.nii'], false)).toBe('open');
    expect(dropHint(null, false)).toBe('open');
  });

  it('says add as mask when every file is named like a mask', () => {
    expect(dropHint(['ct_seg.nii.gz'], true)).toBe('mask');
    expect(dropHint(['a_mask.mha', 'b_label.nrrd'], true)).toBe('mask');
    expect(dropHint(['organs.seg.nrrd'], true)).toBe('mask');
  });

  it('says replace image when an image file is among them', () => {
    expect(dropHint(['ct.nii.gz'], true)).toBe('replace');
    expect(dropHint(['ct.mha', 'ct_seg.nii.gz'], true)).toBe('replace');
  });

  it('says add when the names do not tell', () => {
    // A browser hides the names until the drop.
    expect(dropHint(null, true)).toBe('add');
    expect(dropHint([], true)).toBe('add');
    // A folder, or DICOM files: an image series or a segmentation object.
    expect(dropHint(['/scans/series 3'], true)).toBe('add');
    expect(dropHint(['IM0001.dcm', 'IM0002.dcm'], true)).toBe('add');
  });

  it('says add as mask for the label of the open nnU-Net image', () => {
    expect(dropHint(['10000_0001.mha'], true, '10000_0001_0000.mha')).toBe('mask');
    expect(dropHint(['10000_0002.mha'], true, '10000_0001_0000.mha')).toBe('replace');
  });

  it('ignores the data file of a header', () => {
    expect(dropHint(['ct_seg.mhd', 'ct_seg.raw'], true)).toBe('mask');
  });

  it('has the words of the design spec', () => {
    expect(DROP_TEXT).toEqual({ open: 'Drop to open', mask: 'Drop to add as mask', replace: 'Drop to replace image', add: 'Drop to add' });
  });
});

describe('assignRoles', () => {
  it('opens an image and its mask together as a pair', () => {
    expect(assignRoles([image('ct.mha'), labels('ct_seg.nii.gz')], { hasImage: false })).toEqual({ image: 0, masks: [1], extra: [] });
    expect(assignRoles([labels('ct_seg.nii.gz'), image('ct.mha')], { hasImage: false })).toEqual({ image: 1, masks: [0], extra: [] });
  });

  it('pairs by content when no name says mask', () => {
    expect(assignRoles([image('a.nii'), labels('b.nii')], { hasImage: false })).toEqual({ image: 0, masks: [1], extra: [] });
  });

  it('takes several masks with one image', () => {
    expect(assignRoles([labels('model_seg.nii'), image('ct.nii'), labels('fixed_seg.nii')], { hasImage: false })).toEqual({
      image: 1,
      masks: [0, 2],
      extra: [],
    });
  });

  it('adds a single mask to the open image', () => {
    expect(assignRoles([labels('anything.nii')], { hasImage: true })).toEqual({ image: null, masks: [0], extra: [] });
  });

  it('adds a mask with many segments when its name says mask', () => {
    expect(assignRoles([maybe('total_seg.nii.gz')], { hasImage: true })).toEqual({ image: null, masks: [0], extra: [] });
    // Without the name it may be an 8-bit image; the user is asked.
    expect(assignRoles([maybe('t1.nii.gz')], { hasImage: true })).toEqual({ image: 0, masks: [], extra: [] });
  });

  it('never calls a file with image values a mask because of its name', () => {
    expect(assignRoles([image('label_study.nii')], { hasImage: true })).toEqual({ image: 0, masks: [], extra: [] });
    expect(assignRoles([image('ct.nii'), image('mask_protocol.nii')], { hasImage: false })).toEqual({ image: 0, masks: [], extra: [1] });
  });

  it('treats a single file as the image when nothing is open', () => {
    expect(assignRoles([labels('ct_seg.nii')], { hasImage: false })).toEqual({ image: 0, masks: [], extra: [] });
  });

  it('adds several masks to the open image', () => {
    expect(assignRoles([labels('a_seg.nii'), labels('b_seg.nii')], { hasImage: true })).toEqual({ image: null, masks: [0, 1], extra: [] });
  });

  it('picks an image among label-like files when nothing is open', () => {
    expect(assignRoles([labels('a.nii'), labels('b.nii')], { hasImage: false })).toEqual({ image: 1, masks: [0], extra: [] });
    // Both are named as masks: there is no image to show them on.
    expect(assignRoles([labels('a_seg.nii'), labels('b_seg.nii')], { hasImage: false })).toEqual({ image: null, masks: [0, 1], extra: [] });
  });

  it('follows what the user asked for', () => {
    expect(assignRoles([image('ct.nii')], { role: 'mask', hasImage: true })).toEqual({ image: null, masks: [0], extra: [] });
    expect(assignRoles([labels('seg.nii')], { role: 'image', hasImage: true })).toEqual({ image: 0, masks: [], extra: [] });
  });

  it('pairs an nnU-Net image and label by name', () => {
    // A label with many segments is a "maybe" by its values; the shared case name settles it.
    expect(assignRoles([maybe('10000_0001.mha'), image('10000_0001_0000.mha')], { hasImage: false })).toEqual({ image: 1, masks: [0], extra: [] });
    expect(assignRoles([maybe('10000_0001.mha')], { hasImage: true, imageName: '10000_0001_0000.mha' })).toEqual({ image: null, masks: [0], extra: [] });
  });

  it('opens one image and leaves the others out', () => {
    expect(assignRoles([image('a.nii'), image('b.nii')], { hasImage: false })).toEqual({ image: 0, masks: [], extra: [1] });
  });
});

describe('openChoice', () => {
  it('opens at once when nothing is open', () => {
    expect(openChoice({ role: 'image', hasImage: false, unsaved: false, look: 'labels' })).toBe('open');
    expect(openChoice({ hasImage: false, unsaved: false, look: 'image' })).toBe('open');
  });

  it('replaces at once when asked for by name with nothing unsaved', () => {
    expect(openChoice({ role: 'image', hasImage: true, unsaved: false, look: 'image' })).toBe('open');
    expect(openChoice({ role: 'image', hasImage: true, unsaved: false, look: 'maybe' })).toBe('open');
  });

  it('asks before replacing when dropped or with unsaved edits', () => {
    expect(openChoice({ hasImage: true, unsaved: false, look: 'image' })).toBe('ask-replace');
    expect(openChoice({ role: 'image', hasImage: true, unsaved: true, look: 'image' })).toBe('ask-replace');
  });

  it('offers to add a file of labels as a mask before it replaces the image', () => {
    expect(openChoice({ role: 'image', hasImage: true, unsaved: false, look: 'labels' })).toBe('ask-mask');
    expect(openChoice({ role: 'image', hasImage: true, unsaved: true, look: 'labels' })).toBe('ask-mask');
  });
});
