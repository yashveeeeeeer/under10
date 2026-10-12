import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 90000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, viewport: { width: 1440, height: 1100 }, channel: process.platform === 'win32' ? 'msedge' : undefined, screenshot: 'only-on-failure', trace: 'off' },
  webServer: { command: 'npm start', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
  reporter: 'list'
});
