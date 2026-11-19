/**
 * Composes a problem report or an idea and the link that opens GitHub's
 * new-issue form with it filled in. The app never posts anything itself:
 * the person reads the form in their browser and submits it as themselves.
 *
 * Technical details hold the app version, operating system, renderer, image
 * size, voxel type, file extensions and recent console errors. They never
 * hold file names, paths or anything else that could identify a patient.
 */

export const REPO_URL = 'https://github.com/ArioMoniri/w-annotator';
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/** Longer links are cut short by some browsers and by GitHub. */
export const MAX_URL = 7500;

export type ReportKind = 'bug' | 'idea';

/** The options of the "Operating system" dropdown in the bug form, or nothing. */
export type OsName = 'macOS' | 'Windows' | 'Linux' | '';

export interface VolumeFacts {
  dims: [number, number, number];
  /** For example Int16 or Uint8. */
  voxelType: string;
  /** For example .nii.gz; empty when the name has no known extension. */
  extension: string;
}

export interface Diagnostics {
  version: string;
  os: OsName;
  renderer: string;
  image: VolumeFacts | null;
  mask: VolumeFacts | null;
  /** Recent console errors and warnings, oldest first, already scrubbed. */
  logs: string[];
}

export interface ReportFields {
  title: string;
  what?: string;
  expected?: string;
  steps?: string;
  problem?: string;
  proposal?: string;
  /** Left out when the person chose not to include technical details. */
  diagnostics?: Diagnostics | null;
}

// ── Platform ──────────────────────────────────────────────────────────

/** Maps `navigator.platform`, a user agent string or an OS name to the form's option. */
export function osName(platform: string): OsName {
  if (/mac|darwin|iphone|ipad/i.test(platform)) return 'macOS';
  if (/win/i.test(platform)) return 'Windows';
  if (/linux|x11|cros/i.test(platform)) return 'Linux';
  return '';
}

// ── Scrubbing ─────────────────────────────────────────────────────────

/** Image and sidecar extensions, longest first so `.nii.gz` wins over `.gz`. */
const EXTENSIONS = [
  'seg.nrrd', 'nii.gz', 'img.gz', 'dicom', 'nrrd', 'nhdr', 'zraw', 'json', 'jpeg', 'tiff',
  'nii', 'hdr', 'img', 'mha', 'mhd', 'dcm', 'ima', 'raw', 'zip', 'tar', 'txt', 'csv', 'xml', 'png', 'jpg', 'tif', 'bmp', 'pdf', 'gz',
];
const EXT_PATTERN = EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|');

/** The known extension of a file name, lower-cased with its dot. Never any part of the name itself. */
export function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  const ext = EXTENSIONS.find((e) => lower.endsWith(`.${e}`));
  return ext ? `.${ext}` : '';
}

const MAX_ENTRY = 300;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function leaf(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
}

/** Every spelling of a file name worth removing: the whole name, its last part, and that without its extension. */
function nameForms(names: string[]): string[] {
  const forms = new Set<string>();
  for (const name of names) {
    const file = leaf(name);
    const ext = fileExtension(file);
    for (const form of [name, file, ext ? file.slice(0, -ext.length) : file]) {
      if (form.trim().length >= 3) forms.add(form.trim());
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function removeKnown(text: string, known: string[]): string {
  for (const form of nameForms(known)) text = text.replace(new RegExp(escapeRegExp(form), 'gi'), '<file>');
  return text;
}

/**
 * Removes file paths, file names and anything that looks like a person or an
 * identifier from a log line. `known` lists file names seen in this session,
 * which are removed even when they contain spaces. Errs on the side of removing.
 */
export function scrub(text: string, known: string[] = []): string {
  let out = removeKnown(text.replace(/\s*\n\s*/g, ' '), known);
  out = out
    // DICOM-style keys: drop everything after "PatientName:", "Patient ID =" and the like.
    .replace(/(patient[\w ]{0,12}?\s*[:=]\s*).+/gi, '$1<removed>')
    .replace(/"[^"\n]*"/g, '"<text>"')
    .replace(/`[^`\n]*`/g, '`<text>`')
    .replace(/(^|[\s(=:,])'[^'\n]+'(?=$|[\s).,:;])/g, "$1'<text>'")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    // Anything with a slash or backslash in it: paths and URLs on every platform.
    .replace(/[^\s"'<>()]*[\\/][^\s"'<>()]*[^\s"'<>().,:;!?]/g, '<path>')
    .replace(new RegExp(`[^\\s"'<>()]+?\\.(${EXT_PATTERN})(?![A-Za-z0-9])`, 'gi'), (_m, ext: string) => `<file>.${ext.toLowerCase()}`)
    // DICOM person names (DOE^JOHN), then two or more capitalised words in a row.
    .replace(/\S*\^\S*/g, '<name>')
    .replace(/\b[A-Z][a-z]+(?:[ ,]+[A-Z][a-z]+)+\b/g, '<name>')
    // Long numbers: record numbers, dates, UIDs.
    .replace(/\d[\d.]{5,}\d/g, '<number>');
  return out.length > MAX_ENTRY ? `${out.slice(0, MAX_ENTRY - 1)}…` : out;
}

// ── Log buffer ────────────────────────────────────────────────────────

export type LogLevel = 'error' | 'warn';

export interface LogBuffer {
  add(level: LogLevel, text: string): void;
  /** Remember a file name so it is removed from every entry, past and future. */
  noteName(name: string): void;
  /** Entries as `level: text`, oldest first. */
  lines(): string[];
}

/** A small in-memory ring of scrubbed log lines. Nothing is written to disk or sent anywhere. */
export function createLogBuffer(limit = 50): LogBuffer {
  const entries: string[] = [];
  const names = new Set<string>();
  return {
    add(level, text) {
      entries.push(`${level}: ${scrub(text, [...names])}`);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    noteName(name) {
      if (name) names.add(name);
    },
    lines() {
      const known = [...names];
      return entries.map((e) => removeKnown(e, known));
    },
  };
}

function describeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === null || typeof arg !== 'object') return String(arg);
  // Objects may hold image metadata; only say that one was there.
  return '[object]';
}

interface ConsoleLike {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}
interface ErrorTarget {
  // Loose on purpose: a window fits, and so does a stand-in in tests.
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
}

const captured = new WeakSet<object>();

/** Copies console errors, warnings and uncaught errors into `log`. Safe to call more than once. */
export function installLogCapture(log: LogBuffer, con: ConsoleLike, target?: ErrorTarget): void {
  if (captured.has(con)) return;
  captured.add(con);
  for (const level of ['error', 'warn'] as const) {
    const original = con[level].bind(con);
    con[level] = (...args: unknown[]) => {
      original(...args);
      try {
        log.add(level, args.map(describeArg).join(' '));
      } catch {
        /* a log line that cannot be recorded is not worth failing for */
      }
    };
  }
  target?.addEventListener('error', (event) => {
    const message = (event as { message?: string }).message || 'Unknown error';
    log.add('error', /^Uncaught/.test(message) ? message : `Uncaught ${message}`);
  });
  target?.addEventListener('unhandledrejection', (event) => {
    log.add('error', `Unhandled rejection: ${describeArg((event as { reason?: unknown }).reason)}`);
  });
}

/** The app's own log, filled once `startLogCapture` has run. */
export const appLog = createLogBuffer(50);

/** Call once at startup. */
export function startLogCapture(): void {
  if (typeof window === 'undefined') return;
  installLogCapture(appLog, console, window as unknown as ErrorTarget);
}

// ── Diagnostics ───────────────────────────────────────────────────────

declare const __APP_VERSION__: string | undefined;

interface VolumeLike {
  name: string;
  dims: [number, number, number];
  data: { constructor: { name: string } };
}

export interface DiagnosticsSource {
  image?: VolumeLike | null;
  mask?: VolumeLike | null;
  /** These default to what the running app and browser report. */
  version?: string;
  platform?: string;
  renderer?: string;
  logs?: string[];
}

function facts(vol: VolumeLike | null | undefined): VolumeFacts | null {
  if (!vol) return null;
  return {
    dims: [vol.dims[0], vol.dims[1], vol.dims[2]],
    voxelType: vol.data.constructor.name.replace(/Array$/, ''),
    extension: fileExtension(vol.name),
  };
}

async function appVersion(): Promise<string> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    } catch {
      /* fall back to the version this build was made from */
    }
  }
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

function browserPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return hinted || navigator.platform || navigator.userAgent || '';
}

let rendererCache: string | null = null;

/** The WebGL vendor and renderer, e.g. "Apple · Apple M2". Empty when WebGL is not available. */
function webglRenderer(): string {
  if (rendererCache !== null) return rendererCache;
  if (typeof document === 'undefined') return '';
  let found = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = String(gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? '');
      const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      found = [vendor, renderer].filter(Boolean).join(' · ');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* no WebGL here */
  }
  rendererCache = found;
  return found;
}

/** Gathers the technical details. Takes sizes, voxel types and extensions from the volumes and nothing else. */
export async function collectDiagnostics(source: DiagnosticsSource = {}): Promise<Diagnostics> {
  return {
    version: source.version ?? (await appVersion()),
    os: osName(source.platform ?? browserPlatform()),
    renderer: source.renderer ?? webglRenderer(),
    image: facts(source.image),
    mask: facts(source.mask),
    logs: source.logs ?? appLog.lines(),
  };
}

// ── Composing ─────────────────────────────────────────────────────────

const LOG_HEADING = 'Recent errors and warnings:';
const LOG_SHORTENED = 'Older log lines were left out to keep the report short.';
const TEXT_SHORTENED = '(Shortened to fit. Add the rest on GitHub.)';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const clean = (text: string | undefined) => (text ?? '').replace(/\r\n?/g, '\n').replace(LONE_SURROGATE, '�').trim();

function formats(d: Diagnostics): string {
  const parts: string[] = [];
  if (d.image?.extension) parts.push(`${d.image.extension} image`);
  if (d.mask?.extension) parts.push(`${d.mask.extension} mask`);
  return parts.join(', ');
}

const size = (label: string, v: VolumeFacts) => `${label}: ${v.dims.join(' × ')}, ${v.voxelType}`;

/** The "Logs" field of the bug form: renderer and sizes, then the newest `keep` log lines. */
function logsField(d: Diagnostics, keep: number): string {
  const lines: string[] = [];
  if (d.renderer) lines.push(`Renderer: ${d.renderer}`);
  if (d.image) lines.push(size('Image', d.image));
  if (d.mask) lines.push(size('Mask', d.mask));
  const shortened = keep < d.logs.length;
  if (keep > 0) lines.push(LOG_HEADING);
  if (shortened) lines.push(LOG_SHORTENED);
  if (keep > 0) lines.push(...d.logs.slice(-keep));
  return lines.join('\n');
}

type Params = [string, string][];

interface Draft {
  params: Params;
  /** The technical details as they appear in the link. */
  details: string;
}

/** Keys of the fields the person wrote, which are shortened only as a last resort. */
const WRITTEN = ['what', 'expected', 'steps', 'problem', 'proposal'];

function draft(kind: ReportKind, f: ReportFields, keepLogs: number, limits: Record<string, number>): Draft {
  const d = f.diagnostics ?? null;
  const written = (key: string, value: string | undefined) => {
    const text = clean(value);
    const limit = limits[key];
    if (limit === undefined || limit >= text.length) return text;
    // Never cut a character in half.
    const end = limit > 0 && /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
    return `${text.slice(0, end).trimEnd()}\n\n${TEXT_SHORTENED}`.trim();
  };
  const title = clean(f.title).replace(/\n+/g, ' ');
  const params: Params = [];
  const details: string[] = [];
  const add = (key: string, value: string) => {
    if (value) params.push([key, value]);
  };

  if (kind === 'bug') {
    add('template', 'bug.yml');
    add('title', `Bug: ${title}`);
    add('what', written('what', f.what));
    add('expected', written('expected', f.expected));
    add('steps', written('steps', f.steps));
    if (d) {
      const data = formats(d);
      const logs = logsField(d, keepLogs);
      add('version', d.version);
      add('os', d.os);
      add('data', data);
      add('logs', logs);
      if (d.version) details.push(`App version: ${d.version}`);
      if (d.os) details.push(`Operating system: ${d.os}`);
      if (data) details.push(`File formats: ${data}`);
      if (logs) details.push(logs);
    }
  } else {
    // The feature form has no technical fields, so the two short lines go under the problem.
    if (d?.version) details.push(`App version: ${d.version}`);
    if (d?.os) details.push(`Operating system: ${d.os}`);
    add('template', 'feature.yml');
    add('title', `Feature: ${title}`);
    add('problem', [written('problem', f.problem), details.join('\n')].filter(Boolean).join('\n\n'));
    add('proposal', written('proposal', f.proposal));
  }
  return { params, details: details.join('\n') };
}

const toUrl = (params: Params) => `${NEW_ISSUE_URL}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

const HEADINGS: Record<string, string> = {
  what: 'What happened',
  expected: 'What you expected',
  steps: 'Steps to reproduce',
  problem: 'Problem',
  proposal: 'Proposal',
};

export interface Report {
  /** Opens GitHub's new-issue form with the report filled in. Never longer than `MAX_URL`. */
  url: string;
  /** Exactly the technical details in the link; empty when none are included. */
  details: string;
  /** The same report as plain text, for pasting into an issue by hand. */
  text: string;
}

export function composeReport(kind: ReportKind, fields: ReportFields): Report {
  const total = fields.diagnostics?.logs.length ?? 0;
  const limits: Record<string, number> = {};
  const fits = (keep: number) => toUrl(draft(kind, fields, keep, limits).params).length <= MAX_URL;

  // The log goes first, oldest lines first.
  let keep = total;
  while (keep > 0 && !fits(keep)) keep--;

  // Then, only if it still does not fit, the longest thing the person wrote.
  if (!fits(keep)) {
    const lengths = WRITTEN.map((key) => [key, clean(fields[key as keyof ReportFields] as string | undefined).length] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [key, length] of lengths) {
      let low = 0;
      let high = length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        limits[key] = mid;
        if (fits(keep)) low = mid;
        else high = mid - 1;
      }
      limits[key] = low;
      if (fits(keep)) break;
    }
  }

  const { params, details } = draft(kind, fields, keep, limits);
  const title = params.find(([k]) => k === 'title')?.[1] ?? '';
  const sections = WRITTEN.map((key) => {
    const value = clean(fields[key as keyof ReportFields] as string | undefined);
    return value ? `${HEADINGS[key]}\n${value}` : '';
  }).filter((_s, i) => (kind === 'bug' ? i < 3 : i >= 3));
  if (details) sections.push(`Technical details\n${details}`);
  const text = [`W Annotator report. Paste it into a new issue at ${NEW_ISSUE_URL}`, title, ...sections.filter(Boolean)].join('\n\n');
  return { url: toUrl(params), details, text };
}

/** The link that opens GitHub's new-issue form with the report filled in. */
export function buildIssueUrl(kind: ReportKind, fields: ReportFields): string {
  return composeReport(kind, fields).url;
}
