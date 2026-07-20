const path = require('node:path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'probe.spec.js',
  timeout: 20_000,
  expect: { timeout: 3_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:41739',
    headless: true,
    viewport: { width: 1000, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.js',
    cwd: __dirname,
    port: 41739,
    reuseExistingServer: true,
  },
  outputDir: path.join(__dirname, 'test-results'),
});
