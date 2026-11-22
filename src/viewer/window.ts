import { voxelAt } from './geometry';

/**
 * Window and level: which image values are drawn from black to white. All of this is
 * about display only. Nothing here writes a voxel value.
 */

export interface Voi {
  lower: number;
  upper: number;
}

/** A window as people say it: how wide, and where its middle is. */
export interface WindowPreset {
  name: string;
  w: number;
  l: number;
}

/**
 * CT windows in Hounsfield units, abdominal ones together.
 *
 * All but Pancreas follow Radiopaedia, "Windowing (CT)", https://doi.org/10.53347/rID-52108
 * (revised 7 Jan 2025): soft tissues W 350–400 L 20–60, liver W 150 L 30, lungs W 1500
 * L −600, bone W 1800 L 400, brain W 80 L 40, stroke W 40 L 40, subdural W 130–300 L 50–100.
 * Where that page gives a range (Soft tissue, Abdomen, Subdural), the value here is one
 * inside it.
 *
 * Pancreas is not a standard preset and is not on that list. It is a narrow window chosen
 * by this project, at the owner's request, for a contrast-enhanced pancreas: W 150, L 65,
 * which shows −10 to 140 HU. The width and the range L 50–80 are taken from one paper on
 * a pancreatitis severity index ("Management of Acute Pancreatitis by Using Modified Computed
 * Tomography Severity Index", Int J Contemp Med Surg Radiol 2018;3(1)), which is not a
 * windowing reference; L 65 is the middle of that range, picked here. On an unenhanced scan
 * the gland is dark grey in this window. A site with its own value saves it as a preset.
 */
export const CT_PRESETS: readonly WindowPreset[] = [
  { name: 'Soft tissue', w: 400, l: 40 },
  { name: 'Abdomen', w: 350, l: 50 },
  { name: 'Liver', w: 150, l: 30 },
  { name: 'Pancreas', w: 150, l: 65 },
  { name: 'Lung', w: 1500, l: -600 },
  { name: 'Bone', w: 1800, l: 400 },
  { name: 'Brain', w: 80, l: 40 },
  { name: 'Stroke', w: 40, l: 40 },
  { name: 'Subdural', w: 200, l: 75 },
];

/**
 * Names of the windows worked out from an image that has no unit, in the order of
 * `MrWindows`: soft, fluid, dark. None shares a name with a CT preset: "Soft tissue" is a
 * fixed Hounsfield window, and these are shares of one image's own values.
 */
export const MR_NAMES = ['Mid range', 'Bright fluid', 'Dark detail'] as const;

/** The most presets a person can save. */
export const PRESET_MAX = 12;
export const PRESET_NAME_MAX = 24;

export function toVoi(w: number, l: number): Voi {
  const width = Math.max(w, 1e-6);
  return { lower: l - width / 2, upper: l + width / 2 };
}

/** Below this width whole numbers no longer tell two windows apart. */
const FINE = 10;

const width = (v: Voi) => v.upper - v.lower;
const level = (v: Voi) => (v.upper + v.lower) / 2;

/** Width and level as text. Whole numbers, or two decimals when the window is narrow. */
export function formatWindow(voi: Voi): { w: string; l: string } {
  const fine = width(voi) < FINE;
  const text = (v: number) => {
    const n = fine ? Number(v.toFixed(2)) : Math.round(v);
    return String(n === 0 ? 0 : n).replace('-', '−');
  };
  return { w: text(width(voi)), l: text(level(voi)) };
}

/**
 * The smallest change of width or level worth typing for an image, from the span of its
 * values: 1 where values are whole numbers apart (CT, most MR), a hundredth of the span,
 * rounded down to a power of ten, where the span is narrow (an image scaled 0 to 1 gives 0.01).
 */
export function windowStep(range: readonly [number, number]): number {
  const size = range[1] - range[0];
  if (!Number.isFinite(size) || size <= 0) return 1;
  // Written as a decimal, so 0.0001 is exactly what 0.0001 parses to.
  return Math.min(1, Number(`1e${Math.floor(Math.log10(size / 100))}`));
}

/** A number rounded to a step, without the stray digits binary fractions leave. */
function toStep(value: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const rounded = Number((Math.round(value / step) * step).toFixed(digits));
  return rounded === 0 ? 0 : rounded;
}

/** Width and level as numbers for the fields they are typed in, to the image's step. */
export function windowFields(voi: Voi, step: number): { w: number; l: number } {
  return { w: toStep(width(voi), step), l: toStep(level(voi), step) };
}

/** The window for a typed width and level. It is never narrower than one step. */
export function windowFromFields(w: number, l: number, step: number): Voi {
  const wide = Math.max(step, toStep(w, step));
  return { lower: l - wide / 2, upper: l + wide / 2 };
}

/** True when two windows read the same on screen. */
export function sameWindow(a: Voi, b: Voi): boolean {
  if (width(a) >= FINE && width(b) >= FINE) return Math.round(width(a)) === Math.round(width(b)) && Math.round(level(a)) === Math.round(level(b));
  const slack = Math.max(width(a), width(b)) * 1e-3;
  return Math.abs(a.lower - b.lower) <= slack && Math.abs(a.upper - b.upper) <= slack;
}

export interface WindowChoice {
  name: string;
  voi: Voi;
  kind: 'builtin' | 'custom' | 'auto' | 'full';
}

/** Which presets are listed: fixed Hounsfield windows, or windows worked out from the image. */
export type WindowSet = 'ct' | 'mr';

/** The three MR windows, each worked out from the image's own values. */
export interface MrWindows {
  /** Shown as "Mid range": the brightest tenth is clipped. */
  soft: Voi;
  fluid: Voi;
  dark: Voi;
}

/** What is known about the image that the choices depend on. */
export interface WindowSource {
  /** The window the image opens on when nothing better is known. */
  auto: Voi;
  /** The smallest and largest value in the image. */
  range: [number, number];
  mr: MrWindows;
}

/**
 * Every window on offer for an image, in the order shown and stepped through. The CT set
 * is fixed Hounsfield windows. MR values have no unit, so the MR set is worked out from
 * the image. Saved presets are in both.
 */
export function windowChoices(image: WindowSource, custom: readonly WindowPreset[], set: WindowSet): WindowChoice[] {
  const saved: WindowChoice[] = custom.map((p) => ({ name: p.name, voi: toVoi(p.w, p.l), kind: 'custom' }));
  const full = { lower: image.range[0], upper: image.range[1] > image.range[0] ? image.range[1] : image.range[0] + 1 };
  const fromImage: WindowChoice[] = [
    { name: 'Auto', voi: image.auto, kind: 'auto' },
    { name: 'Full range', voi: full, kind: 'full' },
  ];
  if (set === 'mr') {
    const worked = [image.mr.soft, image.mr.fluid, image.mr.dark].map((voi, i): WindowChoice => ({ name: MR_NAMES[i], voi, kind: 'builtin' }));
    return [...fromImage, ...worked, ...saved];
  }
  return [...CT_PRESETS.map((p): WindowChoice => ({ name: p.name, voi: toVoi(p.w, p.l), kind: 'builtin' })), ...saved, ...fromImage];
}

/** The choice that is on screen now, if the window is one of them. */
export function matchChoice(choices: readonly WindowChoice[], voi: Voi): WindowChoice | null {
  return choices.find((c) => sameWindow(c.voi, voi)) ?? null;
}

/**
 * The next choice, or the one before, that would change the picture. From a window that
 * is no preset, forward starts at the first and back at the last. Null when nothing differs.
 */
export function stepChoice(choices: readonly WindowChoice[], voi: Voi, step: 1 | -1): WindowChoice | null {
  const n = choices.length;
  const at = choices.findIndex((c) => sameWindow(c.voi, voi));
  const start = at < 0 ? (step > 0 ? -1 : n) : at;
  for (let i = 1; i <= n; i++) {
    const c = choices[(((start + step * i) % n) + n) % n];
    if (!sameWindow(c.voi, voi)) return c;
  }
  return null;
}

/** The finite values, sorted, in a new array. */
function sortedValues(values: ArrayLike<number>): Float64Array {
  const kept = new Float64Array(values.length);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) kept[n++] = v;
  }
  return kept.subarray(0, n).sort();
}

const quantile = (sorted: Float64Array, q: number) => sorted[Math.round(q * (sorted.length - 1))];
const span = (lower: number, upper: number): Voi => ({ lower, upper: upper > lower ? upper : lower + 1 });

/**
 * A window that spans most of the given values: from the `lo` to the `hi` quantile, so a
 * few very dark or very bright voxels do not flatten the rest. Null when there are no values.
 */
export function percentileWindow(values: ArrayLike<number>, lo = 0.01, hi = 0.99): Voi | null {
  const sorted = sortedValues(values);
  if (sorted.length === 0) return null;
  return span(quantile(sorted, lo), quantile(sorted, hi));
}

/** Values this near the bottom of the image, as a share of its 0.5 to 99.5 percentile span, are background. */
const BACKGROUND = 0.05;

/**
 * Windows for an image whose values have no unit, from the values themselves. Background
 * (air around the body) is left out first: everything within 5% of the bottom of the
 * image's 0.5 to 99.5 percentile span. Of what is left, the tissue:
 * - soft ("Mid range"): 2nd to 90th percentile. The brightest tenth, usually fluid or fat, is clipped.
 * - fluid: 2nd percentile to the largest value. Nothing bright is clipped.
 * - dark: 2nd to 50th percentile. A narrow window on the darker half.
 */
export function mrWindows(values: ArrayLike<number>): MrWindows {
  const all = sortedValues(values);
  if (all.length === 0) return { soft: span(0, 1), fluid: span(0, 1), dark: span(0, 1) };
  const low = quantile(all, 0.005);
  const floor = low + BACKGROUND * (quantile(all, 0.995) - low);
  let from = 0;
  while (from < all.length && all[from] <= floor) from++;
  const tissue = from < all.length ? all.subarray(from) : all;
  const bottom = quantile(tissue, 0.02);
  return {
    soft: span(bottom, quantile(tissue, 0.9)),
    fluid: span(bottom, tissue[tissue.length - 1]),
    dark: span(bottom, quantile(tissue, 0.5)),
  };
}

/** At most `most` values of `data`, taken evenly from start to end. */
export function sampleValues(data: ArrayLike<number>, most: number): Float64Array {
  const count = Math.min(data.length, Math.max(1, Math.floor(most)));
  const step = data.length / Math.max(count, 1);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = data[Math.floor(i * step)];
  return out;
}

interface Volume {
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
  data: ArrayLike<number>;
}

/** Where a slice view's pixels are in the world: its first pixel, and one pixel across and down. */
interface Frame {
  origin: ArrayLike<number>;
  right: ArrayLike<number>;
  down: ArrayLike<number>;
}

/** The most points looked at under a box; more than enough for steady percentiles. */
const BOX_SAMPLES = 40000;

/**
 * The image values on the slice on screen under a box, given by two opposite corners in
 * the view's pixels. Points off the image are left out. A large box is sampled evenly.
 */
export function boxValues(image: Volume, frame: Frame, a: readonly [number, number], b: readonly [number, number], most = BOX_SAMPLES): Float64Array {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const w = Math.abs(a[0] - b[0]);
  const h = Math.abs(a[1] - b[1]);
  const step = Math.max(1, Math.sqrt((w * h) / Math.max(1, most)));
  const nx = Math.max(1, Math.floor(w / step));
  const ny = Math.max(1, Math.floor(h / step));
  const out = new Float64Array(nx * ny);
  let n = 0;
  const [dx, dy] = image.dims;
  for (let iy = 0; iy < ny; iy++) {
    const y = y0 + ((iy + 0.5) * h) / ny;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ((ix + 0.5) * w) / nx;
      const world = [0, 1, 2].map((c) => frame.origin[c] + frame.right[c] * x + frame.down[c] * y);
      const ijk = voxelAt(image, world);
      if (ijk) out[n++] = image.data[ijk[0] + dx * (ijk[1] + dy * ijk[2])];
    }
  }
  return out.subarray(0, n);
}

const cleanPresetName = (name: unknown): string => (typeof name === 'string' ? name.trim().slice(0, PRESET_NAME_MAX).trim() : '');

/** Saved presets as they are kept: named, with real numbers, no two with one name, no more than the cap. */
export function parseWindowPresets(raw: unknown): WindowPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: WindowPreset[] = [];
  for (const item of raw as unknown[]) {
    if (out.length >= PRESET_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const { name, w, l } = item as Record<string, unknown>;
    const clean = cleanPresetName(name);
    if (!clean || typeof w !== 'number' || typeof l !== 'number' || !Number.isFinite(w) || !Number.isFinite(l) || w <= 0) continue;
    if (out.some((p) => p.name.toLowerCase() === clean.toLowerCase())) continue;
    out.push({ name: clean, w, l });
  }
  return out;
}

/** Why a new preset cannot be saved under `name`, as a sentence for the user. Empty when it can. */
export function presetNameError(name: string, custom: readonly WindowPreset[]): string {
  if (custom.length >= PRESET_MAX) return `You can keep ${PRESET_MAX} presets. Remove one to save another.`;
  const clean = cleanPresetName(name);
  if (!clean) return 'Give the preset a name.';
  const names = [...CT_PRESETS.map((p) => p.name), ...MR_NAMES, 'Auto', 'Full range', ...custom.map((p) => p.name)];
  const taken = names.find((n) => n.toLowerCase() === clean.toLowerCase());
  return taken ? `There is already a preset called ${taken}. Choose another name.` : '';
}

/** `custom` with the window `voi` added under `name`. The caller checks the name first. */
export function withPreset(custom: readonly WindowPreset[], name: string, voi: Voi): WindowPreset[] {
  const fine = width(voi) < FINE;
  const tidy = (v: number) => (fine ? Number(v.toFixed(4)) : Math.round(v));
  return parseWindowPresets([...custom, { name, w: Math.max(tidy(width(voi)), fine ? 1e-4 : 1), l: tidy(level(voi)) }]);
}

/**
 * A window after a nudge, in shares of its own width so a step feels the same on any image:
 * `dl` moves the level by that share of the width, and the width is multiplied by e^`dw`.
 */
export function nudgeWindow(voi: Voi, dw: number, dl: number): Voi {
  const w = Math.max(width(voi) * Math.exp(dw), Number.MIN_VALUE);
  const l = level(voi) + dl * width(voi);
  return { lower: l - w / 2, upper: l + w / 2 };
}

/**
 * How much to magnify a view so that one voxel is one screen pixel. `mmPerPixel` is what
 * the view shows now; `spacing` the two voxel sizes in its plane. The smaller one counts,
 * so no voxel is drawn smaller than a pixel.
 */
export function actualSizeFactor(mmPerPixel: number, spacing: readonly [number, number]): number {
  const voxel = Math.min(spacing[0], spacing[1]);
  return mmPerPixel > 0 && voxel > 0 ? mmPerPixel / voxel : 1;
}
