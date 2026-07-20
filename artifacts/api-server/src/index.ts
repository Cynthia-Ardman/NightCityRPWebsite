import app from "./app";
import { logger } from "./lib/logger";
import { flushSiteActivity } from "./lib/siteActivity";

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
