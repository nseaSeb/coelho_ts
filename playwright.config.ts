import { defineConfig } from "@playwright/test";

// What jsdom cannot show: layout, the real clipboard, two browsers on one
// server. Run with `pnpm e2e`, which builds what the servers serve.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { browserName: "chromium", trace: "retain-on-failure" },
  projects: [
    { name: "demo", testMatch: /demo\.spec\.ts/, use: { baseURL: "http://localhost:5190" } },
    { name: "notes", testMatch: /notes\.spec\.ts/, use: { baseURL: "http://localhost:1240" } },
  ],
  webServer: [
    { command: "pnpm --filter coelho-demo exec vite --port 5190 --strictPort", url: "http://localhost:5190", reuseExistingServer: !process.env.CI },
    // In memory: every run starts with no account, so the first sign-up is the admin.
    { command: "node apps/notes/dist/server/main.js", url: "http://localhost:1240", env: { PORT: "1240" }, reuseExistingServer: false },
  ],
});
