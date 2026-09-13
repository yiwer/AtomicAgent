import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4311', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: { command: 'npx tsx tests/browser-server.ts', url: 'http://127.0.0.1:4311', reuseExistingServer: false },
});
