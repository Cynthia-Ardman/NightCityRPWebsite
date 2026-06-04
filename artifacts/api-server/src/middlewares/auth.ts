import type { Request, Response, NextFunction } from "express";
import { db, users, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hasRole, ROLE_NAMES } from "../lib/discord";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) return next();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (u) req.user = u;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

// Age-verification gate. Applied (in routes/index.ts) AFTER the always-open
// routers (health, auth, guidebook, storage) and BEFORE every data router, so a
// signed-in member who lacks the guild "Verified 18+" role cannot reach any
// gated endpoint. Unauthenticated requests fall through so the downstream
// requireAuth returns the usual 401. Verified members pass straight through.
export function requireVerified(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    next();
    return;
  }
  if (req.user.verified18) {
    next();
    return;
  }
  res.status(403).json({ error: "verification_required" });
}

export function requireRole(group: keyof typeof ROLE_NAMES) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!hasRole(req.user.roles, group)) {
      res.status(403).json({ error: `Requires ${group} role` });
      return;
    }
    next();
  };
}

// Allow access when the caller holds ANY of the listed role groups.
// Used for endpoints shared between e.g. ADMIN and FIXER (canon enforcers
// can run the character claim workflow without full admin privileges).
export function requireAnyRole(groups: Array<keyof typeof ROLE_NAMES>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const ok = groups.some((g) => hasRole(req.user!.roles, g));
    if (!ok) {
      res.status(403).json({ error: `Requires one of: ${groups.join(", ")}` });
      return;
    }
    next();
  };
}
