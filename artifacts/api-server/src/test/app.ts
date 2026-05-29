import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import router from "../routes";

// Builds an Express app that mounts the real API router for integration tests.
// The only thing swapped out vs. production is the session/cookie layer: a
// request is "authenticated" by sending an `x-test-user` header carrying the
// user's id, which this shim loads into req.user exactly like the real
// loadUser middleware. The actual role-gating middleware (requireAuth /
// requireRole / requireAnyRole) inside each route still runs unchanged, so
// authorization behavior is genuinely exercised.
export function buildTestApp(): Express {
  const app = express();
  app.use(express.json());

  app.use(
    "/api",
    async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const id = req.header("x-test-user");
        if (id) {
          const [u] = await db.select().from(users).where(eq(users.id, id));
          if (u) req.user = u;
        }
        next();
      } catch (err) {
        next(err);
      }
    },
    router,
  );

  // Minimal error handler so async route rejections surface as 500 JSON
  // instead of crashing the test process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
