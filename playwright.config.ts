import { defineConfig, devices } from "@playwright/test";
import { githubStubPort } from "./e2e/github-stub-port";

// E2E_PORT lets several checkouts run the suite side by side; the GitHub stub follows it.
const PORT = Number(process.env.E2E_PORT ?? 4173);
const CI = !!process.env.CI;
const preview = `pnpm --filter web exec vite preview --port ${PORT} --strictPort`;

/** End-to-end tests against the production build served by `vite preview` (workerd). */
export default defineConfig({
  testDir: "./e2e",
  // One worker: every test talks to the same local workerd, and the hibernation test needs the
  // Durable Object to sit idle.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  // Checks that the build accepts the e2e test identity and publishes to the GitHub stub before
  // any test runs.
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Started in this order. The stub reads the test App's key when a request needs it, so it may
  // start before `pnpm e2e:keys` has written that key on a fresh checkout.
  webServer: [
    {
      // The GitHub the build publishes to (GITHUB_API_BASE in .dev.vars), in memory.
      command: "pnpm exec tsx e2e/github-stub.ts",
      url: `http://127.0.0.1:${githubStubPort()}/__e2e/health`,
      reuseExistingServer: !CI,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // CI builds in its own earlier steps (clearer failures), so it only serves that build here.
      // The test identity must exist before the build, which copies .dev.vars into its output.
      // Local D1 gets the migrations, as production does before each deploy.
      command: CI ? preview : `pnpm e2e:keys && pnpm build && pnpm db:migrate:local && ${preview}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
