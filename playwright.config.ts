import { defineConfig, devices } from "@playwright/test";

// Local sandboxes can point at a pre-installed Chromium via PW_EXECUTABLE_PATH;
// CI uses the browser installed by `playwright install`.
const executablePath = process.env.PW_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serve the production build. `npm test` builds first — the suite tests `dist/`,
  // so a source edit tested without a rebuild silently exercises the *previous*
  // bundle, which is how a renamed button label produced a green local run and a
  // red CI. Invoking `playwright test` directly skips that; build first, or use
  // `npm test`.
  webServer: {
    command: "npx vite preview --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
