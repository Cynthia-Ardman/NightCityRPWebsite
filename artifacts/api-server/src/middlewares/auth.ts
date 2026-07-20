import type { Request, Response, NextFunction } from "express";
import { db, users, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hasRole, ROLE_NAMES } from "../lib/discord";
import { isLoginRestricted, isLockdownExempt } from "../lib/siteAccess";
import { recordHit } from "../lib/siteActivity";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// lastSeenAt is otherwise only stamped at OAuth login, but sessions last for
// weeks — touch it on any authenticated request, throttled to once per hour,
// fire-and-forget so it never slows or fails a request.
const LAST_SEEN_TOUCH_MS = 60 * 60 * 1000;

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) return next();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (u) {
    req.user = u;
    recordHit(u.id);
    const seen = u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : 0;
    if (Date.now() - seen > LAST_SEEN_TOUCH_MS) {
      const now = new Date();
      u.lastSeenAt = now;
      void db.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId)).catch(() => {});
    }
  }
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

// Staff-only lockdown gate. Mounted (in routes/index.ts) AFTER the always-open
// routers (health, auth, guidebook, storage) and the age gate, BEFORE every
// data router. When an admin has restricted login, any signed-in member who is
// NOT staff (ADMIN / FIXER incl. coordinator / ARCHIVIST) gets a 403 from here
// on, so an already-logged-in player is locked out too — not just new logins.
// Unauthenticated requests fall through so the downstream requireAuth returns
// the usual 401. Staff and the open routers are never affected.
export async function requireSiteAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    next();
    return;
  }
  if (isLockdownExempt(req.user.roles)) {
    next();
    return;
  }
  if (await isLoginRestricted()) {
    res.status(403).json({ error: "site_locked" });
    return;
  }
  next();
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
