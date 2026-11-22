import { describe, expect, it } from 'vitest';
import {
  CT_PRESETS,
  PRESET_MAX,
  actualSizeFactor,
  boxValues,
  formatWindow,
  matchChoice,
  mrWindows,
  nudgeWindow,
  parseWindowPresets,
  percentileWindow,
  windowSetFor,
  presetNameError,
  sameWindow,
  sampleValues,
  stepChoice,
  toVoi,
  windowChoices,
  withPreset,
} from './window';

const mrSet = { soft: { lower: 60, upper: 700 }, fluid: { lower: 60, upper: 1900 }, dark: { lower: 60, upper: 300 } };
const ct = { auto: { lower: -900, upper: 250 }, range: [-1000, 3000] as [number, number], mr: mrSet };
const mr = { auto: { lower: 12, upper: 840 }, range: [0, 1900] as [number, number], mr: mrSet };

describe('window width and level', () => {
  it('turns width and level into a range', () => {
    expect(toVoi(400, 40)).toEqual({ lower: -160, upper: 240 });
  });
  it('never makes a window narrower than nothing', () => {
    expect(toVoi(0, 10).upper).toBeGreaterThan(toVoi(0, 10).lower);
  });
  it('shows whole numbers with a real minus sign', () => {
    expect(formatWindow({ lower: -1350.2, upper: 150.1 })).toEqual({ w: '1500', l: '−600' });
  });
  it('shows decimals when the window is narrower than 10', () => {
    expect(formatWindow({ lower: 0, upper: 1 })).toEqual({ w: '1', l: '0.5' });
    expect(formatWindow({ lower: 0.125, upper: 0.375 })).toEqual({ w: '0.25', l: '0.25' });
  });
  it('treats windows that read the same as the same', () => {
    expect(sameWindow({ lower: -160.2, upper: 240.1 }, toVoi(400, 40))).toBe(true);
    expect(sameWindow(toVoi(401, 40), toVoi(400, 40))).toBe(false);
    expect(sameWindow({ lower: 0, upper: 1 }, { lower: 0, upper: 0.5 })).toBe(false);
  });
});

describe('the CT presets', () => {
  const by = (name: string) => CT_PRESETS.find((p) => p.name === name);
  it('has the abdominal windows, next to each other', () => {
    expect(by('Abdomen')).toEqual({ name: 'Abdomen', w: 350, l: 50 });
    expect(by('Liver')).toEqual({ name: 'Liver', w: 150, l: 30 });
    expect(by('Pancreas')).toEqual({ name: 'Pancreas', w: 150, l: 65 });
    const at = ['Abdomen', 'Liver', 'Pancreas'].map((n) => CT_PRESETS.findIndex((p) => p.name === n));
    expect(at[1] - at[0]).toBe(1);
    expect(at[2] - at[1]).toBe(1);
  });
  it('keeps the windows that were there', () => {
    expect(by('Soft tissue')).toMatchObject({ w: 400, l: 40 });
    expect(by('Lung')).toMatchObject({ w: 1500, l: -600 });
    expect(by('Bone')).toMatchObject({ w: 1800, l: 400 });
    expect(by('Brain')).toMatchObject({ w: 80, l: 40 });
    expect(by('Stroke')).toMatchObject({ w: 40, l: 40 });
    expect(by('Subdural')).toMatchObject({ w: 200, l: 75 });
  });
  it('has no two presets with one name or one window', () => {
    expect(new Set(CT_PRESETS.map((p) => p.name)).size).toBe(CT_PRESETS.length);
    expect(new Set(CT_PRESETS.map((p) => `${p.w}/${p.l}`)).size).toBe(CT_PRESETS.length);
  });
});

describe('the list of windows to choose from', () => {
  it('offers the CT presets, then Auto and Full range, in the CT set', () => {
    const names = windowChoices(ct, [], 'ct').map((c) => c.name);
    expect(names).toEqual([...CT_PRESETS.map((p) => p.name), 'Auto', 'Full range']);
  });
  it('offers windows worked out from the image, and no CT presets, in the MR set', () => {
    expect(windowChoices(mr, [], 'mr').map((c) => c.name)).toEqual(['Auto', 'Full range', 'Soft tissue', 'Bright fluid', 'Dark detail']);
  });
  it('takes the MR windows from the image', () => {
    const list = windowChoices(mr, [], 'mr');
    expect(list.map((c) => c.voi)).toEqual([{ lower: 12, upper: 840 }, { lower: 0, upper: 1900 }, mrSet.soft, mrSet.fluid, mrSet.dark]);
  });
  it('puts saved presets after the built-in ones in both sets', () => {
    const custom = [{ name: 'Site lung', w: 1600, l: -550 }];
    expect(windowChoices(ct, custom, 'ct').map((c) => c.name)).toEqual([...CT_PRESETS.map((p) => p.name), 'Site lung', 'Auto', 'Full range']);
    expect(windowChoices(mr, custom, 'mr').map((c) => `${c.kind}:${c.name}`)).toEqual([
      'auto:Auto',
      'full:Full range',
      'builtin:Soft tissue',
      'builtin:Bright fluid',
      'builtin:Dark detail',
      'custom:Site lung',
    ]);
  });
  it('names the window in use, or none', () => {
    const list = windowChoices(ct, [], 'ct');
    expect(matchChoice(list, toVoi(1500, -600))?.name).toBe('Lung');
    expect(matchChoice(list, toVoi(150, 65))?.name).toBe('Pancreas');
    expect(matchChoice(list, toVoi(1501, -600))).toBeNull();
    expect(matchChoice(windowChoices(mr, [], 'mr'), { lower: 60, upper: 1900 })?.name).toBe('Bright fluid');
  });
});

describe('stepping through presets', () => {
  const list = windowChoices(ct, [{ name: 'Mine', w: 900, l: 100 }], 'ct');
  it('goes to the next and the previous one', () => {
    expect(stepChoice(list, toVoi(400, 40), 1)?.name).toBe('Abdomen');
    expect(stepChoice(list, toVoi(350, 50), -1)?.name).toBe('Soft tissue');
    expect(stepChoice(list, toVoi(200, 75), 1)?.name).toBe('Mine');
  });
  it('wraps at both ends', () => {
    expect(stepChoice(list, { lower: -1000, upper: 3000 }, 1)?.name).toBe('Soft tissue');
    expect(stepChoice(list, toVoi(400, 40), -1)?.name).toBe('Full range');
  });
  it('starts at the first, or the last going back, from a window that is no preset', () => {
    expect(stepChoice(list, toVoi(123, 45), 1)?.name).toBe('Soft tissue');
    expect(stepChoice(list, toVoi(123, 45), -1)?.name).toBe('Full range');
  });
  it('works in the MR set, saved presets included', () => {
    const mrList = windowChoices(mr, [{ name: 'Mine', w: 900, l: 100 }], 'mr');
    expect(stepChoice(mrList, mrSet.dark, 1)?.name).toBe('Mine');
    expect(stepChoice(mrList, toVoi(900, 100), 1)?.name).toBe('Auto');
  });
  it('skips a choice that would show the same window', () => {
    const same = { lower: 0, upper: 100 };
    const flat = windowChoices({ auto: same, range: [0, 100], mr: { soft: same, fluid: same, dark: same } }, [{ name: 'Mine', w: 50, l: 25 }], 'mr');
    expect(stepChoice(flat, same, 1)?.name).toBe('Mine');
  });
  it('gives nothing when there is nothing else to show', () => {
    const same = { lower: 0, upper: 100 };
    const one = windowChoices({ auto: same, range: [0, 100], mr: { soft: same, fluid: same, dark: same } }, [], 'mr');
    expect(stepChoice(one, same, 1)).toBeNull();
  });
});

describe('window from the values in a region', () => {
  it('spans the 1st to the 99th percentile', () => {
    const values = Array.from({ length: 1001 }, (_, i) => i);
    expect(percentileWindow(values)).toEqual({ lower: 10, upper: 990 });
  });
  it('is not thrown by a few extreme values', () => {
    const values = [...Array.from({ length: 998 }, (_, i) => 100 + (i % 50)), -32768, 32767];
    const voi = percentileWindow(values)!;
    expect(voi.lower).toBeGreaterThanOrEqual(100);
    expect(voi.upper).toBeLessThanOrEqual(149);
  });
  it('does not depend on the order of the values', () => {
    expect(percentileWindow([5, 1, 4, 2, 3])).toEqual(percentileWindow([1, 2, 3, 4, 5]));
  });
  it('ignores values that are not numbers', () => {
    expect(percentileWindow([NaN, 10, Infinity, 20, -Infinity])).toEqual({ lower: 10, upper: 20 });
  });
  it('gives a window one wide for a flat region', () => {
    expect(percentileWindow([7, 7, 7])).toEqual({ lower: 7, upper: 8 });
  });
  it('gives nothing for no values', () => {
    expect(percentileWindow([])).toBeNull();
    expect(percentileWindow([NaN])).toBeNull();
  });
  it('leaves the values as they were', () => {
    const values = new Int16Array([3, 1, 2]);
    percentileWindow(values);
    expect(Array.from(values)).toEqual([3, 1, 2]);
  });
});

describe('windows worked out from an image with no unit', () => {
  // Half air at 0 to 9, then tissue spread evenly from 100 to 1099 with ten very bright voxels of fluid.
  const air = Array.from({ length: 1000 }, (_, i) => i % 10);
  const tissue = Array.from({ length: 1000 }, (_, i) => 100 + i);
  const fluid = Array.from({ length: 10 }, () => 4000);
  const w = mrWindows([...tissue, ...air, ...fluid]);

  it('leaves the background out, so every window starts in the tissue', () => {
    expect(w.soft.lower).toBeGreaterThanOrEqual(100);
    expect(w.soft.lower).toBeLessThan(140);
    expect(w.fluid.lower).toBe(w.soft.lower);
    expect(w.dark.lower).toBe(w.soft.lower);
  });
  it('soft tissue ends at the 90th percentile of the tissue, clipping the brightest', () => {
    expect(w.soft.upper).toBeGreaterThan(980);
    expect(w.soft.upper).toBeLessThan(1030);
  });
  it('bright fluid keeps the top of the range', () => {
    expect(w.fluid.upper).toBe(4000);
  });
  it('dark detail ends at the median of the tissue', () => {
    expect(w.dark.upper).toBeGreaterThan(580);
    expect(w.dark.upper).toBeLessThan(630);
  });
  it('orders them: dark detail is narrowest, bright fluid widest', () => {
    expect(w.dark.upper).toBeLessThan(w.soft.upper);
    expect(w.soft.upper).toBeLessThan(w.fluid.upper);
  });
  it('is the same on the same image scaled and shifted', () => {
    const scaled = mrWindows([...tissue, ...air, ...fluid].map((v) => v * 0.001 + 5));
    expect(scaled.soft.lower).toBeCloseTo(w.soft.lower * 0.001 + 5);
    expect(scaled.soft.upper).toBeCloseTo(w.soft.upper * 0.001 + 5);
    expect(scaled.dark.upper).toBeCloseTo(w.dark.upper * 0.001 + 5);
  });
  it('gives usable windows for a flat or empty image', () => {
    for (const v of [mrWindows([]), mrWindows([5, 5, 5]), mrWindows([NaN])]) {
      for (const voi of [v.soft, v.fluid, v.dark]) expect(voi.upper).toBeGreaterThan(voi.lower);
    }
  });
  it('samples a large image evenly', () => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => i);
    expect(Array.from(sampleValues(data, 4))).toEqual([0, 250, 500, 750]);
    expect(sampleValues(data, 5000).length).toBe(1000);
  });
});

describe('the values under a box drawn on a slice view', () => {
  // 4 × 3 × 2 voxels, 2 mm apart in the plane; the value is 100·k + 10·j + i.
  const dims: [number, number, number] = [4, 3, 2];
  const data = new Int16Array(24);
  for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) data[i + 4 * (j + 3 * k)] = 100 * k + 10 * j + i;
  const image = { dims, spacing: [2, 2, 5] as [number, number, number], origin: [0, 0, 0] as [number, number, number], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data };
  // An axial view of slice k = 1, one screen pixel per mm, with the first voxel's centre at pixel (10, 10).
  const frame = { origin: [-10, -10, 5], right: [1, 0, 0], down: [0, 1, 0] };
  const sorted = (v: ArrayLike<number>) => Array.from(v).sort((a, b) => a - b);
  const unique = (v: ArrayLike<number>) => [...new Set(sorted(v))];

  it('reads the voxels of the slice on screen inside the box', () => {
    // Pixels 12 to 14, across and down, lie over voxels 1 and 2 of each axis.
    const values = boxValues(image, frame, [12, 12], [14, 14]);
    expect(unique(values)).toEqual([111, 112, 121, 122]);
  });
  it('takes the corners in any order', () => {
    expect(sorted(boxValues(image, frame, [14, 14], [12, 12]))).toEqual(sorted(boxValues(image, frame, [12, 12], [14, 14])));
  });
  it('leaves out the part of the box that is off the image', () => {
    const values = boxValues(image, frame, [-50, -50], [10, 10]);
    expect(unique(values)).toEqual([100]);
    expect(boxValues(image, frame, [-50, -50], [-20, -20]).length).toBe(0);
  });
  it('samples a large box rather than reading every pixel', () => {
    // Zoomed far in: 100 screen pixels per mm.
    const near = { origin: [-1, -1, 5], right: [0.01, 0, 0], down: [0, 0.01, 0] };
    const values = boxValues(image, near, [0, 0], [2000, 2000], 400);
    expect(values.length).toBeLessThanOrEqual(400);
    expect(unique(values).length).toBeGreaterThan(1);
  });
  it('does not change the image', () => {
    const before = Array.from(data);
    boxValues(image, frame, [0, 0], [40, 40]);
    expect(Array.from(data)).toEqual(before);
  });
});

describe('saved presets', () => {
  it('keeps well-formed presets', () => {
    expect(parseWindowPresets([{ name: 'Site lung', w: 1600, l: -550 }])).toEqual([{ name: 'Site lung', w: 1600, l: -550 }]);
  });
  it('drops anything that is not a preset', () => {
    expect(parseWindowPresets('nope')).toEqual([]);
    expect(parseWindowPresets([null, 3, { name: '', w: 1, l: 1 }, { name: 'A', w: 0, l: 1 }, { name: 'B', w: 'x', l: 1 }, { name: 'C', w: 5, l: NaN }])).toEqual([]);
  });
  it('trims names, cuts them to 24 characters and keeps the first of two with one name', () => {
    const out = parseWindowPresets([
      { name: '  Long name that goes on and on and on  ', w: 10, l: 5 },
      { name: 'Mine', w: 10, l: 5 },
      { name: 'mine', w: 20, l: 5 },
    ]);
    expect(out.map((p) => p.name)).toEqual(['Long name that goes on a', 'Mine']);
  });
  it('keeps no more than the cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `P${i}`, w: 10, l: i }));
    expect(parseWindowPresets(many)).toHaveLength(PRESET_MAX);
  });
});

describe('naming a new preset', () => {
  const custom = [{ name: 'Mine', w: 10, l: 5 }];
  it('accepts a new name', () => {
    expect(presetNameError('Site lung', custom)).toBe('');
  });
  it('asks for a name', () => {
    expect(presetNameError('   ', custom)).toBe('Give the preset a name.');
  });
  it('refuses a name that is taken, whatever its case', () => {
    expect(presetNameError('lung', custom)).toBe('There is already a preset called Lung. Choose another name.');
    expect(presetNameError('MINE', custom)).toBe('There is already a preset called Mine. Choose another name.');
    expect(presetNameError('auto', [])).toBe('There is already a preset called Auto. Choose another name.');
    expect(presetNameError('bright fluid', [])).toBe('There is already a preset called Bright fluid. Choose another name.');
  });
  it('says when the list is full', () => {
    const full = Array.from({ length: PRESET_MAX }, (_, i) => ({ name: `P${i}`, w: 10, l: i }));
    expect(presetNameError('One more', full)).toBe(`You can keep ${PRESET_MAX} presets. Remove one to save another.`);
  });
});

describe('saving the window on screen', () => {
  it('adds it after the others as whole numbers', () => {
    const out = withPreset([{ name: 'Mine', w: 10, l: 5 }], ' Site lung ', { lower: -1350.4, upper: 250.2 });
    expect(out).toEqual([
      { name: 'Mine', w: 10, l: 5 },
      { name: 'Site lung', w: 1601, l: -550 },
    ]);
  });
  it('keeps decimals for a narrow window', () => {
    expect(withPreset([], 'Fine', { lower: 0.125, upper: 0.375 })).toEqual([{ name: 'Fine', w: 0.25, l: 0.25 }]);
  });
});

describe('nudging the window', () => {
  it('moves the level by a share of the width and keeps the width', () => {
    const up = nudgeWindow(toVoi(400, 40), 0, 0.1);
    expect(up.lower).toBeCloseTo(-120);
    expect(up.upper).toBeCloseTo(280);
  });
  it('multiplies the width about the same level', () => {
    const wide = nudgeWindow(toVoi(400, 40), Math.log(2), 0);
    expect(wide.lower).toBeCloseTo(-360);
    expect(wide.upper).toBeCloseTo(440);
  });
  it('comes back with the opposite nudge', () => {
    const back = nudgeWindow(nudgeWindow(toVoi(400, 40), 0.3, 0), -0.3, 0);
    expect(back.lower).toBeCloseTo(-160);
    expect(back.upper).toBeCloseTo(240);
  });
  it('never closes the window', () => {
    const v = nudgeWindow(toVoi(400, 40), -50, 0);
    expect(v.upper).toBeGreaterThanOrEqual(v.lower);
    expect((v.upper + v.lower) / 2).toBeCloseTo(40);
  });
  it('feels the same on an image with a tiny range', () => {
    const v = nudgeWindow({ lower: 0, upper: 1 }, 0, 0.1);
    expect(v.lower).toBeCloseTo(0.1);
    expect(v.upper).toBeCloseTo(1.1);
  });
});

describe('actual size', () => {
  it('magnifies until one voxel is one screen pixel', () => {
    expect(actualSizeFactor(2, [1, 1])).toBe(2);
    expect(actualSizeFactor(0.25, [0.5, 0.5])).toBe(0.5);
  });
  it('goes by the smaller voxel side', () => {
    expect(actualSizeFactor(1, [0.5, 3])).toBe(2);
  });
  it('changes nothing when the view is not known', () => {
    expect(actualSizeFactor(0, [1, 1])).toBe(1);
  });
});

describe('an 8-bit picture of someone else\'s view', () => {
  const source = { auto: { lower: 0, upper: 255 }, range: [0, 255] as [number, number], mr: { soft: { lower: 0, upper: 255 }, fluid: { lower: 0, upper: 255 }, dark: { lower: 0, upper: 255 } } };
  it('offers the whole grey scale and nothing in Hounsfield units', () => {
    const choices = windowChoices(source, [{ name: 'Mine', w: 400, l: 40 }], 'grey');
    expect(choices).toEqual([{ name: 'Full range', voi: { lower: 0, upper: 255 }, kind: 'full' }]);
  });
  it('is the set for such an image whatever list was asked for', () => {
    expect(windowSetFor({ ct: false, grey: true }, 'ct')).toBe('grey');
    expect(windowSetFor({ ct: true }, null)).toBe('ct');
    expect(windowSetFor({ ct: false }, null)).toBe('mr');
    expect(windowSetFor({ ct: false }, 'ct')).toBe('ct');
  });
});
