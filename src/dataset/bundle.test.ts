import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { EMAIL_LIMIT, bundleMasks, bundleName, fitsEmail, packBundle, sizeText } from './bundle';
import { readLayout, type Dataset } from './layout';
import type { CaseProgress } from './progress';

const ds = readLayout([
  'imagesTr/a_0001_0000.mha',
  'imagesTr/a_0002_0000.mha',
  'imagesTr/b_0001_0000.nii.gz',
  'labelsTr/a_0001.mha',
]) as Dataset;

const AT = '2026-11-23T10:00:00.000Z';

describe('bundleName', () => {
  it('is the folder name with the day, so zips sent on different days do not collide', () => {
    expect(bundleName('LabelsTr_corrected', new Date(2026, 10, 3, 23, 30))).toBe('LabelsTr_corrected-2026-11-03.zip');
  });
});

describe('bundleMasks', () => {
  it('lists the saved mask of every done case, in case order, and nothing for skipped ones', () => {
    const progress: Record<string, CaseProgress> = {
      b_0001: { status: 'done', at: AT },
      a_0002: { status: 'skipped', at: AT },
      a_0001: { status: 'done', at: AT },
    };
    expect(bundleMasks(ds, progress)).toEqual(['a_0001.mha', 'b_0001.nii.gz']);
  });

  it('ignores progress for cases the dataset does not have', () => {
    expect(bundleMasks(ds, { z_0001: { status: 'done', at: AT } })).toEqual([]);
  });
});

describe('packBundle', () => {
  // Bytes that do not compress (xorshift), like a compressed mask.
  let seed = 2463534242;
  const random = new Uint8Array(4000).map(() => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 24;
  });
  const zeros = new Uint8Array(4000);

  it('puts every file in one folder named after the output folder', () => {
    const zip = packBundle('out', [
      { name: 'a_0001.mha', bytes: zeros },
      { name: 'w-annotator-progress.json', bytes: new TextEncoder().encode('{}\n') },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['out/a_0001.mha', 'out/w-annotator-progress.json']);
    expect(files['out/a_0001.mha']).toEqual(zeros);
    expect(strFromU8(files['out/w-annotator-progress.json'])).toBe('{}\n');
  });

  it('stores files that do not get smaller (already compressed) and compresses the rest', () => {
    const zip = packBundle('out', [
      { name: 'b.nii.gz', bytes: random },
      { name: 'a.nii', bytes: zeros },
    ]);
    // Stored: the bytes are in the zip as they are. Compressed: the zip is far smaller than the zeros.
    const at = zip.findIndex((_, i) => random.every((v, j) => zip[i + j] === v));
    expect(at).toBeGreaterThan(0);
    expect(zip.length).toBeLessThan(random.length + zeros.length / 4);
    expect(unzipSync(zip)['out/b.nii.gz']).toEqual(random);
  });
});

describe('size', () => {
  it('reads as a person would say it', () => {
    expect(sizeText(900)).toBe('1 KB');
    expect(sizeText(6_700)).toBe('7 KB');
    expect(sizeText(5.24 * 1024 * 1024)).toBe('5.2 MB');
  });

  it('fits an email attachment up to the limit only', () => {
    expect(fitsEmail(EMAIL_LIMIT)).toBe(true);
    expect(fitsEmail(EMAIL_LIMIT + 1)).toBe(false);
  });
});
