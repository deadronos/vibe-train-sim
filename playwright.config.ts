import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  // Software GL is slow enough that tests running side by side starve each other.
  workers: 1,
  timeout: 90_000,
  // CI renders so slowly that the simulation, capped at 0.1 s a frame, runs far behind real time.
  expect: { timeout: 30_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 960, height: 600 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: { command: 'npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173' },
});
