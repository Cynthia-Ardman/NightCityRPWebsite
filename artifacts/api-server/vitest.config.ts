import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "./src/test/testDbUrl";

const dbUrl = (() => {
  try {
    return testDatabaseUrl();
  } catch {
    return process.env.DATABASE_URL;
  }
})();

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./src/test/globalSetup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Each test file writes to a shared database; run files serially (each in
    // its own forked process) so they don't clobber each other's truncate.
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
