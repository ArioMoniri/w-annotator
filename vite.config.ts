import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // xmlbuilder2 (pulled in by Cornerstone) expects Node's EventEmitter.
  resolve: { alias: { events: require.resolve('events/') } },
  server: { port: Number(process.env.W_PORT ?? 1420), strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
