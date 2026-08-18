import { logger } from "./lib/logger";
import { runMigrations, shouldRunMigrations } from "./lib/runMigrations";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// In production deployments, apply pending DB migrations BEFORE the app module
// loads (importing ./app starts cron jobs and session storage against the DB).
// Fail closed: a failed migration must not serve traffic against a
// half-migrated schema.
if (shouldRunMigrations()) {
  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, "Database migration failed; refusing to start");
    process.exit(1);
  }
}

const { default: app } = await import("./app");
const { flushSiteActivity } = await import("./lib/siteActivity");

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Best-effort flush of pending site-activity counters on graceful shutdown so
// deploy restarts don't drop the final (≤30s) batch of hit counts.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void flushSiteActivity().finally(() => process.exit(0));
  });
}
