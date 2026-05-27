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
