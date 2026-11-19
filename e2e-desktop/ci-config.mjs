/**
 * Prints the Tauri config overrides for a test build, for `tauri build --config <file>`:
 * no web build step (the caller ran `vite build`) and no updater archive.
 *
 *   node e2e-desktop/ci-config.mjs [WebView2 debugging port] > overrides.json
 *
 * With a port, the main window also opens WebView2's remote debugging port. That is how the
 * Edge driver reaches the app on Windows: it normally asks for the port through the
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS variable, which the app's WebView2 does not apply
 * (seen on the CI runners with WebView2 156 and 157), so the build has to ask for it itself.
 * Only test builds get this; the shipped config is untouched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const port = process.argv[2];

const overrides = { build: { beforeBuildCommand: '' }, bundle: { createUpdaterArtifacts: false } };
if (port) {
  if (!/^\d+$/.test(port)) throw new Error(`Not a port: ${port}`);
  // Setting the arguments replaces wry's defaults, so they are repeated here.
  const args = `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=${port}`;
  overrides.app = { windows: base.app.windows.map((w, i) => (i === 0 ? { ...w, additionalBrowserArgs: args } : w)) };
}
process.stdout.write(`${JSON.stringify(overrides, null, 2)}\n`);
