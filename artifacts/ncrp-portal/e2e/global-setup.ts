import { request, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import { seedAll } from "./seed";
import { ROLES, stateFile, BASE_URL } from "./fixtures/roles";

// Runs once before the suite. Seeds the deterministic test users (and a
// player-owned character + ledger), then establishes a real session for each
// role via the dev-only /api/auth/test-login backdoor and saves the resulting
// cookies as a Playwright storageState per role. Specs pick the role they need
// with `test.use({ storageState: stateFile("...") })`.
export default async function globalSetup(_config: FullConfig): Promise<void> {
  await seedAll();

  fs.mkdirSync("e2e/.auth", { recursive: true });

  for (const role of ROLES) {
    const ctx = await request.newContext({ baseURL: BASE_URL });
    const res = await ctx.post("/api/auth/test-login", { data: { userId: role.id } });
    if (!res.ok()) {
      throw new Error(
        `test-login failed for ${role.key} (${role.id}): ${res.status()} ${await res.text()}. ` +
          `Is ENABLE_TEST_AUTH=true on the api-server (development env)?`,
      );
    }
    await ctx.storageState({ path: stateFile(role.key) });
    await ctx.dispose();
  }
}
