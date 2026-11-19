import { describe, expect, it } from 'vitest';
import { readVolume } from './index';
import { ascii } from './fixtures';

const UNSUPPORTED = 'This file is not a supported image. Try NIfTI, MHA, NRRD or DICOM.';

describe('readVolume', () => {
  it('rejects files that are no known image format', () => {
    expect(() => readVolume([{ name: 'notes.txt', bytes: ascii('hello there, this is a text file') }])).toThrow(UNSUPPORTED);
    expect(() => readVolume([{ name: 'empty', bytes: new Uint8Array(0) }])).toThrow(UNSUPPORTED);
  });
  it('rejects an empty selection', () => {
    expect(() => readVolume([])).toThrow(/No file/);
  });
  it('throws plain Error objects', () => {
    try {
      readVolume([{ name: 'a.nii', bytes: new Uint8Array(10) }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
