import { defineConfig } from '@playwright/test';

// Ports can be moved so several checkouts can run their tests side by side.
const port = Number(process.env.W_PORT ?? 1420);
const relayPort = Number(process.env.W_RELAY_PORT ?? 8787);

const gl = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: gl },
    trace: 'off',
  },
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
