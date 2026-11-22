import { defineConfig } from '@playwright/test';

// Ports can be moved so several checkouts can run their tests side by side.
const port = Number(process.env.W_PORT ?? 1420);
const relayPort = Number(process.env.W_RELAY_PORT ?? 8787);

const gl = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

// Chromium by default. W_E2E_BROWSER=webkit runs the same tests in WebKit instead: on macOS
// that is the closest stand-in for the desktop app's WKWebView, which has no WebDriver.
const project =
  process.env.W_E2E_BROWSER === 'webkit'
    ? { name: 'webkit', use: { browserName: 'webkit' as const } }
    : { name: 'chromium', use: { browserName: 'chromium' as const, launchOptions: { args: gl } } };

// The real-data checks need a downloaded case, so they are only part of the run when asked for.
const realData = process.env.W_REALDATA_DIR ? [] : ['**/real-data.spec.ts'];
// Rooms on a full-size scan take minutes and gigabytes: `W_SCALE=1 pnpm e2e e2e/room-scale.spec.ts`.
const scale = process.env.W_SCALE ? [] : ['**/room-scale.spec.ts'];

export default defineConfig({
  testDir: 'e2e',
  testIgnore: [...realData, ...scale],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    // Every test starts as someone who has already seen the welcome tour; e2e/tour.spec.ts opts out.
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'w-annotator:settings', value: '{"tourSeen":true}' }] }],
    },
    viewport: { width: 1280, height: 800 },
    trace: 'off',
  },
  projects: [project],
  webServer: [
    {
      command: `pnpm vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      env: { VITE_RELAY_URL: `ws://localhost:${relayPort}` },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `cargo run --quiet -p w-relay -- --port ${relayPort}`,
      url: `http://localhost:${relayPort}/health`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
