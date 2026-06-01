import { defineConfig } from "vitest/config";
import { uniqueTestDatabaseUrl } from "./src/test/testDbUrl";

// Give each vitest invocation its own throwaway database. Without this, two
// concurrent/overlapping runs (e.g. a manual run started while the committed
// `test` validation workflow is also running) share one `_test` database and
// the global TRUNCATE in one run wipes the other's seed data mid-flight,
// causing spurious 401/empty/500 failures in unrelated test files.
//
// vitest.config.ts and globalSetup.ts both run in the same main process, so we
// stash the chosen URL on process.env (TEST_DATABASE_URL) for globalSetup /
// teardown to read, and pass it to the forked test workers via test.env.
const dbUrl = (() => {
  try {
    const token = `${process.pid.toString(36)}_${Date.now().toString(36)}`;
    return uniqueTestDatabaseUrl(token);
  } catch {
    return process.env.DATABASE_URL;
  }
})();

if (dbUrl) process.env.TEST_DATABASE_URL = dbUrl;

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./src/test/globalSetup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Files run serially (each in its own forked process). Combined with the
    // per-invocation database above, no run can ever clobber another's data.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      ...(dbUrl ? { DATABASE_URL: dbUrl } : {}),
      SESSION_SECRET: "test-session-secret",
      // Blank out external-service credentials so no test can ever hit the
      // real Unbelievaboat or Discord APIs by accident. Tests that need these
      // services mock them explicitly.
      UNBELIEVABOAT_TOKEN: "",
      UNBELIEVABOAT_API_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      TOKEN: "",
    },
  },
});
