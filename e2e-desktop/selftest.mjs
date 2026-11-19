/**
 * Launches the built app with an image and a mask on the command line and asks
 * it to test itself (W_SELFTEST, see src-tauri/README.md). Needs no WebDriver,
 * so it also runs on macOS.
 *
 *   node e2e-desktop/selftest.mjs [path to the app binary]
 *
 * Exits with 0 only if every step passed and the saved mask checks out.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP } from './app.mjs';
import { count, N, readNifti, writeFixtures } from './fixtures.mjs';

const TIMEOUT = Number(process.env.W_SELFTEST_TIMEOUT ?? 180_000);
const STEPS = ['files opened', 'stroke painted', 'room hosted', 'mask saved'];

const app = process.argv[2] ? resolve(process.argv[2]) : APP;
if (!existsSync(app)) {
  console.error(`The app is not built: ${app}`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'w-selftest-'));
const saveDir = join(dir, 'saved');
const resultPath = join(dir, 'result.json');
const fx = writeFixtures(join(dir, 'in'));
writeFixtures(saveDir);

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

console.log(`Launching ${app}`);
const child = spawn(app, [fx.imagePath, fx.maskPath], {
  env: { ...process.env, W_SELFTEST: resultPath, W_E2E_SAVE_DIR: saveDir },
  stdio: 'inherit',
});
const exit = await new Promise((done) => {
  const timer = setTimeout(() => {
    child.kill();
    done({ timedOut: true });
  }, TIMEOUT);
  child.once('error', (error) => (clearTimeout(timer), done({ error })));
  child.once('exit', (code, signal) => (clearTimeout(timer), done({ code, signal })));
});

if (exit.error) check(false, `the app could not be started: ${exit.error.message}`);
else if (exit.timedOut) check(false, `the app did not finish within ${TIMEOUT / 1000} s`);
else check(exit.code === 0, `the app quit by itself (exit code ${exit.code ?? exit.signal})`);

if (!existsSync(resultPath)) {
  check(false, 'the app wrote a result file');
} else {
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  console.log(`Webview: ${result.userAgent}`);
  for (const name of STEPS) {
    const step = result.steps.find((s) => s.name === name);
    check(step?.ok === true, `${name}: ${step ? step.detail : 'step did not run'}`);
  }
  check(result.ok === true, 'the app reports that every step passed');

  const savedPath = join(saveDir, result.saved?.file ?? 'missing');
  if (!result.saved || !existsSync(savedPath)) {
    check(false, 'the saved mask is on disk');
  } else {
    const saved = readNifti(savedPath);
    check(saved.gzipped && saved.headerSize === 348 && saved.magic === 'n+1', 'the saved mask is a gzipped NIfTI-1 file');
    check(saved.dims.join() === [N, N, N].join() && saved.datatype === 2 && saved.bitpix === 8, `the saved mask is ${saved.dims.join(' x ')} uint8`);
    check(count(saved.data) === result.saved.voxels, `the saved mask holds the ${result.saved.voxels} voxels the app had (file: ${count(saved.data)})`);
    check(count(saved.data) > count(fx.mask), `the painted stroke is in the file (${count(fx.mask)} voxels before)`);
    check(count(saved.data, 2) === count(fx.mask, 2), 'the other segment is unchanged');
  }
}

rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.error(`\nSelf-test failed: ${failures.length} check${failures.length === 1 ? '' : 's'} did not pass.`);
  process.exit(1);
}
console.log('\nSelf-test passed.');
