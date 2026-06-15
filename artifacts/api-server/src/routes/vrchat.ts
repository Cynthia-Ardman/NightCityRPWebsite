import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db, vrchatAgents, vrchatAgentCommands } from "@workspace/db";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import {
  requireAgent,
  mintAgentToken,
  isVrchatCommandKind,
  AGENT_ONLINE_WINDOW_MS,
  COMMAND_CLAIM_STALE_MS,
} from "../lib/vrchatAgent";
import { buildAgentBundle } from "../lib/vrchatAgentFiles";
import { buildZip } from "../lib/zip";
import { getCachedInstances, pollGroupInstances } from "../lib/vrchatInstances";
import { vrchatCredsConfigured } from "../lib/vrchatClient";

const router: IRouter = Router();

// Staff who may operate the CyberPsycho control panel. Each staffer drives their
// OWN agent (rows are scoped to req.user.id), so this is self-service control.
const staffOnly = [requireAuth, requireAnyRole(["ADMIN", "FIXER"])] as const;

// Absolute, public base URL the downloaded agent should POST back to. The agent
// runs on a staffer's PC over the internet, so it needs the deployed origin +
// the "/api" mount, NOT a relative path. Mirrors the PUBLIC_BASE_URL ??
// REPLIT_DOMAINS[0] fallback used elsewhere for outbound deep links.
function publicApiBase(): string {
  const raw = process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "";
  let base = raw.replace(/\/+$/, "");
  if (base && !/^https?:\/\//.test(base)) base = `https://${base}`;
  return `${base}/api`;
}

// ---------------------------------------------------------------------------
// Agent-facing endpoint (bearer-token auth, NO Discord session)
// ---------------------------------------------------------------------------

// POST /vrchat/agent/poll — the agent's heartbeat + command pump. It reports its
// latest status and the outcomes of any commands it just ran, and receives the
// next batch of pending commands to execute. Mounted in the gated section but
// safe there: agent requests carry no session, so the verify/lockdown gates fall
// through (they only act on req.user) and this token check runs.
router.post("/vrchat/agent/poll", requireAgent, async (req: Request, res: Response): Promise<void> => {
  const userId = req.agentUserId!;
  const body = (req.body ?? {}) as {
    status?: Record<string, unknown>;
    results?: Array<{ id?: number; ok?: boolean; message?: string; result?: Record<string, unknown> }>;
  };
  const now = new Date();

  // Update heartbeat + status snapshot. Pull a friendly label from the reported
  // VRChat display name when present.
  const label =
    body.status && typeof body.status.my_name === "string" && body.status.my_name
      ? (body.status.my_name as string)
      : undefined;
  await db
    .update(vrchatAgents)
    .set({
      lastSeenAt: now,
      ...(body.status ? { status: body.status, statusAt: now } : {}),
      ...(label ? { label } : {}),
    })
    .where(eq(vrchatAgents.userId, userId));

  // Record outcomes of completed commands (scoped to this agent's own rows). The
  // status='claimed' guard prevents a late/duplicate report from regressing a row
  // that already reached a terminal state (done/error) or from clobbering a row
  // that was re-claimed for a fresh run.
  if (Array.isArray(body.results)) {
    for (const r of body.results) {
      if (!r || typeof r.id !== "number") continue;
      await db
        .update(vrchatAgentCommands)
        .set({
          status: r.ok ? "done" : "error",
          result: r.result ?? null,
          error: r.ok ? null : r.message ?? "Command failed",
          completedAt: now,
        })
        .where(
          and(
            eq(vrchatAgentCommands.id, r.id),
            eq(vrchatAgentCommands.userId, userId),
            eq(vrchatAgentCommands.status, "claimed"),
          ),
        );
    }
  }

  // Atomically claim pending commands plus any claimed-but-stale ones (crash
  // recovery), returning exactly the rows this poll won. A single guarded
  // UPDATE...RETURNING avoids the select-then-update race where two concurrent
  // polls hand out the same command or a stale UPDATE regresses a newer status:
  // under READ COMMITTED, Postgres re-evaluates the predicate against the
  // freshly-committed row, so a row another poll just claimed won't be re-won.
  const staleBefore = new Date(Date.now() - COMMAND_CLAIM_STALE_MS);
  const claimed = await db
    .update(vrchatAgentCommands)
    .set({ status: "claimed", claimedAt: now })
    .where(
      and(
        eq(vrchatAgentCommands.userId, userId),
        or(
          eq(vrchatAgentCommands.status, "pending"),
          and(eq(vrchatAgentCommands.status, "claimed"), lt(vrchatAgentCommands.claimedAt, staleBefore)),
        ),
      ),
    )
    .returning();

  claimed.sort((a, b) => a.id - b.id);
  res.json({
    commands: claimed.map((c) => ({ id: c.id, kind: c.kind, params: c.params ?? null })),
  });
});

// ---------------------------------------------------------------------------
// Staff control-panel endpoints (Discord session + ADMIN/FIXER)
// ---------------------------------------------------------------------------

// GET /vrchat/status — the requesting staffer's agent meta, latest reported
// status snapshot, and recent command history.
router.get("/vrchat/status", ...staffOnly, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const [agent] = await db.select().from(vrchatAgents).where(eq(vrchatAgents.userId, userId));
  const recent = await db
    .select()
    .from(vrchatAgentCommands)
    .where(eq(vrchatAgentCommands.userId, userId))
    .orderBy(desc(vrchatAgentCommands.id))
    .limit(20);

  const online = !!agent?.lastSeenAt && Date.now() - agent.lastSeenAt.getTime() < AGENT_ONLINE_WINDOW_MS;

  res.json({
    agent: {
      exists: !!agent,
      online,
      tokenIssued: !!agent?.tokenHash,
      revoked: !!agent?.revokedAt,
      lastSeenAt: agent?.lastSeenAt?.toISOString() ?? null,
      statusAt: agent?.statusAt?.toISOString() ?? null,
      label: agent?.label ?? null,
    },
    status: (agent?.status as Record<string, unknown> | null) ?? null,
    commands: recent.map((c) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      error: c.error ?? null,
      createdAt: c.createdAt.toISOString(),
      completedAt: c.completedAt?.toISOString() ?? null,
    })),
  });
});

// POST /vrchat/commands — queue a command for the staffer's own agent.
router.post("/vrchat/commands", ...staffOnly, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { kind, params } = (req.body ?? {}) as { kind?: unknown; params?: Record<string, unknown> };
  if (!isVrchatCommandKind(kind)) {
    res.status(400).json({ error: "invalid_kind" });
    return;
  }
  const [row] = await db
    .insert(vrchatAgentCommands)
    .values({ userId, kind, params: params ?? null, createdById: userId })
    .returning();
  res.status(201).json({ id: row.id, kind: row.kind, status: row.status });
});

// POST /vrchat/agent/revoke — kill the staffer's current agent token. The next
// poll from that agent gets a 401 and it tells the user to re-download.
router.post("/vrchat/agent/revoke", ...staffOnly, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  await db
    .update(vrchatAgents)
    .set({ tokenHash: null, revokedAt: new Date() })
    .where(eq(vrchatAgents.userId, userId));
  res.json({ ok: true });
});

// POST /vrchat/agent/download — mint a fresh token (superseding any prior one)
// and return the personalized agent script as a text body. The portal fetches
// this on an explicit click and saves it as a file client-side; kept as POST so
// a link prefetch can't silently rotate a working agent's token.
router.post("/vrchat/agent/download", ...staffOnly, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { token, hash } = mintAgentToken();
  const now = new Date();
  await db
    .insert(vrchatAgents)
    .values({ userId, tokenHash: hash, tokenIssuedAt: now, revokedAt: null })
    .onConflictDoUpdate({
      target: vrchatAgents.userId,
      set: { tokenHash: hash, tokenIssuedAt: now, revokedAt: null },
    });

  const zip = buildZip(buildAgentBundle(publicApiBase(), token));
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="psychosis_agent.zip"');
  res.send(zip);
});

// ---------------------------------------------------------------------------
// Member-facing live instance browser
// ---------------------------------------------------------------------------

// GET /vrchat/instances — the currently-open NCRP group instances, served from
// the poller's cache so members never hit the VRChat API directly. Available to
// any signed-in, verified member (no staff role required).
router.get("/vrchat/instances", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const instances = await getCachedInstances();
  res.json({ instances, configured: vrchatCredsConfigured() });
});

// POST /vrchat/instances/refresh — staff-only manual poll. Useful for verifying
// the integration on demand without waiting for the cron tick.
router.post("/vrchat/instances/refresh", ...staffOnly, async (_req: Request, res: Response): Promise<void> => {
  if (!vrchatCredsConfigured()) {
    res.status(400).json({ error: "vrchat_not_configured" });
    return;
  }
  try {
    const count = await pollGroupInstances();
    res.json({ ok: true, count });
  } catch (err) {
    res.status(502).json({ error: "vrchat_poll_failed", message: err instanceof Error ? err.message : "poll failed" });
  }
});

export default router;
