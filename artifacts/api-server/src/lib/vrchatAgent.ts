import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, vrchatAgents } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

// Allowed command kinds the portal may queue for an agent.
export const VRCHAT_COMMAND_KINDS = [
  "isolate",
  "restore",
  "refresh",
  "snapshot",
  "save_allowlist",
] as const;
export type VrchatCommandKind = (typeof VRCHAT_COMMAND_KINDS)[number];

export function isVrchatCommandKind(v: unknown): v is VrchatCommandKind {
  return typeof v === "string" && (VRCHAT_COMMAND_KINDS as readonly string[]).includes(v);
}

// An agent is considered "online" if it has polled within this window.
export const AGENT_ONLINE_WINDOW_MS = 30_000;

// A claimed-but-unfinished command is re-offered after this long, so a crash
// mid-command doesn't strand the queue (block/unblock are idempotent agent-side).
export const COMMAND_CLAIM_STALE_MS = 120_000;

// Mint a fresh opaque token and return both the plaintext (handed to the agent
// once, baked into its download) and the sha256 hex we persist.
export function mintAgentToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, hash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // The staff user id that owns the authenticated agent (set by requireAgent).
      agentUserId?: string;
    }
  }
}

// Bearer-token auth for the local agent. Unlike requireAuth this never looks at
// the Discord session — it hashes the Authorization bearer token and matches it
// against a non-revoked vrchat_agents row. Attaches req.agentUserId on success.
export async function requireAgent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) {
    res.status(401).json({ error: "agent_token_required" });
    return;
  }
  const hash = hashAgentToken(m[1].trim());
  const [agent] = await db
    .select()
    .from(vrchatAgents)
    .where(and(eq(vrchatAgents.tokenHash, hash), isNull(vrchatAgents.revokedAt)));
  if (!agent) {
    res.status(401).json({ error: "agent_token_invalid" });
    return;
  }
  req.agentUserId = agent.userId;
  next();
}
