import { defineConfig } from "@playwright/test";
import { execSync } from "node:child_process";

// Resolve the Chromium binary. In the Replit/Nix environment Playwright's own
// downloaded browsers fail to launch (missing shared libs), so we use the
// Nix-provided `chromium` (installed as a system dependency) via executablePath.
function resolveChromium(): string {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  try {
    return execSync("which chromium", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Could not find a `chromium` binary on PATH. Install it with the package " +
        "manager (Nix system dependency `chromium`) before running the e2e suite.",
    );
  }
}

// The suite runs against the live Test environment (the running dev workflows),
// reachable on the Replit dev domain. The portal is served at `/` and the API at
// `/api` on the same origin, so session cookies set by /api/auth/test-login are
// carried by ordinary page navigations.
const devDomain = process.env.REPLIT_DEV_DOMAIN;
if (!devDomain) {
  throw new Error(
    "REPLIT_DEV_DOMAIN is required to run the e2e suite (it is provided " +
      "automatically inside the Replit workspace).",
  );
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `https://${devDomain}`,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: resolveChromium(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
});
