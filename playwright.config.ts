import { defineConfig } from '@playwright/test';

const gl = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1420',
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: gl },
    trace: 'off',
  },
  webServer: [
    { command: 'pnpm dev', url: 'http://localhost:1420', reuseExistingServer: true, timeout: 60_000 },
    {
      command: 'cargo run --quiet --manifest-path relay/Cargo.toml -- --port 8787',
      url: 'http://localhost:8787/health',
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
