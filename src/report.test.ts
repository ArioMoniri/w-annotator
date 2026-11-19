import { describe, expect, it } from 'vitest';
import {
  MAX_URL,
  buildIssueUrl,
  collectDiagnostics,
  composeReport,
  createLogBuffer,
  fileExtension,
  installLogCapture,
  osName,
  scrub,
  type Diagnostics,
} from './report';

const diag = (over: Partial<Diagnostics> = {}): Diagnostics => ({
  version: '0.1.0',
  os: 'Linux',
  renderer: 'Google Inc. · ANGLE (SwiftShader)',
  image: { dims: [512, 512, 212], voxelType: 'Int16', extension: '.nii.gz' },
  mask: { dims: [512, 512, 212], voxelType: 'Uint8', extension: '.nrrd' },
  logs: ['error: Something broke', 'warn: Slow frame'],
  ...over,
});

const params = (url: string) => new URL(url).searchParams;

describe('osName', () => {
  it('maps the platform to the options of the issue form', () => {
    expect(osName('MacIntel')).toBe('macOS');
    expect(osName('macOS')).toBe('macOS');
    expect(osName('Win32')).toBe('Windows');
    expect(osName('Windows')).toBe('Windows');
    expect(osName('Linux x86_64')).toBe('Linux');
    expect(osName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('Linux');
    expect(osName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
    expect(osName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
  });

  it('gives nothing for a platform the form does not list', () => {
    expect(osName('FreeBSD amd64')).toBe('');
    expect(osName('')).toBe('');
  });
});

describe('fileExtension', () => {
  it('keeps only the extension, longest known one first', () => {
    expect(fileExtension('DOE_JOHN_chest.nii.gz')).toBe('.nii.gz');
    expect(fileExtension('/Users/mina/scans/liver.seg.nrrd')).toBe('.seg.nrrd');
    expect(fileExtension('C:\\data\\Head.MHA')).toBe('.mha');
    expect(fileExtension('IM0001.dcm')).toBe('.dcm');
  });

  it('gives nothing when there is no known extension', () => {
    expect(fileExtension('IM0001')).toBe('');
    expect(fileExtension('doe.john.19700101')).toBe('');
  });
});

describe('scrub', () => {
  it('removes file paths on every platform', () => {
    expect(scrub('Could not open /Users/mina/scans/doe_john.nii.gz: denied')).toBe('Could not open <path>: denied');
    expect(scrub('Could not open C:\\Users\\Mina\\doe_john.nii: denied')).toBe('Could not open <path>: denied');
    expect(scrub('at load (file:///home/mina/app/main.js:10:2)')).not.toMatch(/mina|home/);
    expect(scrub('failed for scans/doe_john/series1')).not.toMatch(/doe|series1/);
  });

  it('removes file names but keeps the extension', () => {
    expect(scrub("Can't read doe_john_014.nii.gz. The file may be damaged.")).toBe(
      "Can't read <file>.nii.gz. The file may be damaged.",
    );
    expect(scrub('Bad header in IM0001.dcm')).toBe('Bad header in <file>.dcm');
  });

  it('removes names it was told about, with or without the extension, even with spaces', () => {
    const known = ['Doe John chest.nii.gz'];
    expect(scrub('Opening Doe John chest.nii.gz…', known)).toBe('Opening <file>…');
    expect(scrub('volume doe john chest is empty', known)).toBe('volume <file> is empty');
  });

  it('removes things that look like a person or an identifier', () => {
    expect(scrub('PatientName: whoever it is')).toBe('PatientName: <removed>');
    expect(scrub('tag (0010,0010) DOE^JOHN^A found')).not.toMatch(/DOE|JOHN/);
    expect(scrub('series for John Smith not found')).toBe('series for <name> not found');
    expect(scrub('contact mina@example.org now')).toBe('contact <email> now');
    expect(scrub('study 1.2.840.113619.2.55.3 id 12345678')).not.toMatch(/113619|12345678/);
    expect(scrub('label "Liver of Mr X" rejected')).toBe('label "<text>" rejected');
  });

  it('leaves ordinary messages readable', () => {
    expect(scrub('TypeError: cannot read properties of undefined')).toBe('TypeError: cannot read properties of undefined');
    expect(scrub('Mask is 48 × 48 × 48 but the image is 48 × 48 × 40')).toBe('Mask is 48 × 48 × 48 but the image is 48 × 48 × 40');
  });

  it('keeps one entry short', () => {
    expect(scrub('x'.repeat(2000)).length).toBeLessThanOrEqual(300);
  });
});

describe('log buffer', () => {
  it('keeps only the newest entries', () => {
    const log = createLogBuffer(50);
    for (let i = 0; i < 60; i++) log.add('warn', `entry number ${i}`);
    const lines = log.lines();
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('warn: entry number 10');
    expect(lines[49]).toBe('warn: entry number 59');
  });

  it('scrubs entries as they come in and again for names learned later', () => {
    const log = createLogBuffer(50);
    log.add('error', 'Could not read /data/doe/scan.nii');
    log.add('error', 'volume secret patient is empty');
    log.noteName('Secret Patient.nii');
    const text = log.lines().join('\n');
    expect(text).not.toMatch(/doe|secret patient/i);
    expect(text).toContain('error: Could not read <path>');
  });

  it('records console errors, warnings and uncaught errors once installed', () => {
    const seen: string[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    const fakeConsole = {
      error: (...a: unknown[]) => void seen.push(`e:${a.join(' ')}`),
      warn: (...a: unknown[]) => void seen.push(`w:${a.join(' ')}`),
    };
    const target = { addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn) };
    const log = createLogBuffer(50);
    installLogCapture(log, fakeConsole, target);
    installLogCapture(log, fakeConsole, target); // a second call must not wrap twice

    fakeConsole.error('Render failed', new RangeError('bad size'), { patient: 'x' });
    fakeConsole.warn('Slow frame');
    listeners.error({ message: 'Uncaught ReferenceError: nope is not defined' });
    listeners.unhandledrejection({ reason: new Error('load gave up') });

    expect(seen).toEqual(['e:Render failed RangeError: bad size [object Object]', 'w:Slow frame']);
    expect(log.lines()).toEqual([
      'error: Render failed RangeError: bad size [object]',
      'warn: Slow frame',
      'error: Uncaught ReferenceError: nope is not defined',
      'error: Unhandled rejection: Error: load gave up',
    ]);
  });
});

describe('collectDiagnostics', () => {
  it('reports sizes, voxel types and extensions but never a file name', async () => {
    const d = await collectDiagnostics({
      image: { name: '/Users/mina/DOE_JOHN_chest.nii.gz', dims: [4, 5, 6], data: new Int16Array(120) },
      mask: { name: 'DOE_JOHN_liver.seg.nrrd', dims: [4, 5, 6], data: new Uint8Array(120) },
      version: '1.2.3',
      platform: 'MacIntel',
      renderer: 'Apple · Apple M2',
      logs: ['error: one'],
    });
    expect(d).toEqual({
      version: '1.2.3',
      os: 'macOS',
      renderer: 'Apple · Apple M2',
      image: { dims: [4, 5, 6], voxelType: 'Int16', extension: '.nii.gz' },
      mask: { dims: [4, 5, 6], voxelType: 'Uint8', extension: '.seg.nrrd' },
      logs: ['error: one'],
    });
    expect(JSON.stringify(d)).not.toMatch(/doe|john|mina|users/i);
  });

  it('works with nothing open and outside a browser', async () => {
    const d = await collectDiagnostics({ platform: 'Win32', logs: [] });
    expect(d.image).toBeNull();
    expect(d.mask).toBeNull();
    expect(d.os).toBe('Windows');
    expect(d.renderer).toBe('');
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('buildIssueUrl', () => {
  it('fills the bug form', () => {
    const url = buildIssueUrl('bug', {
      title: 'Fill leaks & spills',
      what: 'Line one\nLine two — 50% of the time?',
      expected: 'No leak #1',
      steps: '1. Open\n2. Fill',
      diagnostics: diag(),
    });
    expect(url.startsWith('https://github.com/ArioMoniri/w-annotator/issues/new?template=bug.yml&')).toBe(true);
    const p = params(url);
    expect(p.get('title')).toBe('Bug: Fill leaks & spills');
    expect(p.get('what')).toBe('Line one\nLine two — 50% of the time?');
    expect(p.get('expected')).toBe('No leak #1');
    expect(p.get('steps')).toBe('1. Open\n2. Fill');
    expect(p.get('version')).toBe('0.1.0');
    expect(p.get('os')).toBe('Linux');
    expect(p.get('data')).toBe('.nii.gz image, .nrrd mask');
    const logs = p.get('logs')!;
    expect(logs).toContain('Renderer: Google Inc. · ANGLE (SwiftShader)');
    expect(logs).toContain('Image: 512 × 512 × 212, Int16');
    expect(logs).toContain('Mask: 512 × 512 × 212, Uint8');
    expect(logs).toContain('error: Something broke\nwarn: Slow frame');
  });

  it('percent-encodes every value', () => {
    const url = buildIssueUrl('bug', { title: 'a&b=c #d', what: 'x y+z\nü' });
    expect(url).toContain('title=Bug%3A%20a%26b%3Dc%20%23d');
    expect(url).toContain('what=x%20y%2Bz%0A%C3%BC');
    expect(url).not.toMatch(/[\s#]/);
  });

  it('fills the feature form', () => {
    const url = buildIssueUrl('idea', { title: 'Lasso', problem: 'Slow edits', proposal: 'A lasso tool', diagnostics: diag() });
    const p = params(url);
    expect(p.get('template')).toBe('feature.yml');
    expect(p.get('title')).toBe('Feature: Lasso');
    expect(p.get('proposal')).toBe('A lasso tool');
    expect(p.get('problem')).toBe('Slow edits\n\nApp version: 0.1.0\nOperating system: Linux');
    expect(p.has('logs')).toBe(false);
    expect(p.has('what')).toBe(false);
  });

  it('sends no technical details unless they are given', () => {
    const p = params(buildIssueUrl('bug', { title: 't', what: 'w' }));
    expect([...p.keys()].sort()).toEqual(['template', 'title', 'what']);
    const idea = params(buildIssueUrl('idea', { title: 't', problem: 'p', proposal: 'q' }));
    expect(idea.get('problem')).toBe('p');
  });

  it('leaves out an operating system the form does not list, and empty fields', () => {
    const p = params(buildIssueUrl('bug', { title: 't', what: 'w', expected: '  ', diagnostics: diag({ os: '', image: null, mask: null, renderer: '', logs: [] }) }));
    expect(p.has('os')).toBe(false);
    expect(p.has('expected')).toBe(false);
    expect(p.has('data')).toBe(false);
    expect(p.has('logs')).toBe(false);
  });

  it('shortens the log first, oldest lines first, and says so', () => {
    const logs = Array.from({ length: 50 }, (_, i) => `error: line ${i} ${'é'.repeat(100)}`);
    const what = 'What I saw. '.repeat(40);
    const report = composeReport('bug', { title: 't', what, diagnostics: diag({ logs }) });
    expect(report.url.length).toBeLessThanOrEqual(MAX_URL);
    const p = params(report.url);
    expect(p.get('what')).toBe(what.trim());
    const sent = p.get('logs')!;
    expect(sent).toContain('Older log lines were left out to keep the report short.');
    expect(sent).toContain('error: line 49');
    expect(sent).not.toContain('error: line 0 ');
    expect(sent).toContain('Renderer: ');
    expect(report.details).toContain(sent);
  });

  it('shortens the written text only when the log is already gone, and says so', () => {
    const what = 'word '.repeat(4000);
    const report = composeReport('bug', { title: 't', what, steps: 'short steps', diagnostics: diag() });
    expect(report.url.length).toBeLessThanOrEqual(MAX_URL);
    const p = params(report.url);
    expect(p.get('what')).toMatch(/\(Shortened to fit\. Add the rest on GitHub\.\)$/);
    expect(p.get('steps')).toBe('short steps');
    expect(p.get('logs')).not.toContain('error: Something broke');
    expect(p.get('version')).toBe('0.1.0');
  });
});

describe('composeReport', () => {
  it('previews exactly the technical details that go in the link', () => {
    const report = composeReport('bug', { title: 't', what: 'w', diagnostics: diag() });
    expect(report.details).toBe(
      [
        'App version: 0.1.0',
        'Operating system: Linux',
        'File formats: .nii.gz image, .nrrd mask',
        'Renderer: Google Inc. · ANGLE (SwiftShader)',
        'Image: 512 × 512 × 212, Int16',
        'Mask: 512 × 512 × 212, Uint8',
        'Recent errors and warnings:',
        'error: Something broke',
        'warn: Slow frame',
      ].join('\n'),
    );
    expect(composeReport('bug', { title: 't', what: 'w' }).details).toBe('');
  });

  it('gives the same report as text to copy', () => {
    const { text } = composeReport('bug', { title: 'Fill leaks', what: 'It leaked', steps: '1. Fill', diagnostics: diag() });
    expect(text).toContain('https://github.com/ArioMoniri/w-annotator/issues/new');
    expect(text).toContain('Bug: Fill leaks');
    expect(text).toContain('What happened\nIt leaked');
    expect(text).toContain('Steps to reproduce\n1. Fill');
    expect(text).not.toContain('What you expected');
    expect(text).toContain('App version: 0.1.0');
    const bare = composeReport('idea', { title: 'Lasso', problem: 'Slow', proposal: 'Lasso tool' }).text;
    expect(bare).toContain('Problem\nSlow');
    expect(bare).toContain('Proposal\nLasso tool');
    expect(bare).not.toContain('App version');
  });
});
