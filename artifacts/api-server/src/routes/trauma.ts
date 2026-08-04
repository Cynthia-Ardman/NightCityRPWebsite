import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, characters } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import {
  fetchGuildMemberRoleIdsViaBot,
  listGuildMembersWithRole,
  sendDirectMessage,
  externalWritesAllowed,
} from "../lib/discord";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// --- Trauma Team subscription tiers -----------------------------------------
// Exact Discord role ids for the four paid subscription tiers. Ordered highest
// first so a member holding several tier roles is reported at their best tier.
export const TRAUMA_TIER_ROLES: ReadonlyArray<{ id: string; tier: string }> = [
  { id: "1380008302653739028", tier: "Diamond" },
  { id: "1380008269409423370", tier: "Platinum" },
  { id: "1380008235292950578", tier: "Gold" },
  { id: "1380008115574931556", tier: "Silver" },
];

// Discord role held by Trauma Team responders — every holder gets the DM.
export const TRAUMA_TEAM_ROLE_ID = "1348661300334563328";

// A call blasts a DM to every responder, so throttle repeat calls per user.
// In-memory is fine: a restart clearing the window only risks one extra page,
// and calls are rare, human-initiated events.
const CALL_COOLDOWN_MS = 5 * 60 * 1000;
const lastCallAt = new Map<string, number>();

function bestTier(roleIds: string[]): string | null {
  for (const t of TRAUMA_TIER_ROLES) if (roleIds.includes(t.id)) return t.tier;
  return null;
}

// GET /trauma/status — is the signed-in user a Trauma Team subscriber, and at
// which tier? `determined:false` means the Discord lookup failed, so the
// dashboard should hide the button rather than guessing.
router.get("/trauma/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const roleIds = await fetchGuildMemberRoleIdsViaBot(req.user!.discordId);
  if (roleIds === null) {
    res.json({ eligible: false, tier: null, determined: false });
    return;
  }
  const tier = bestTier(roleIds);
  res.json({ eligible: tier !== null, tier, determined: true });
});

// POST /trauma/call { characterId } — DM every Trauma Team responder that this
// subscriber's character needs immediate extraction. Eligibility is re-checked
// server-side against live Discord role ids (never trust the client), and the
// character must belong to the caller.
router.post("/trauma/call", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const u = req.user!;
  const characterId = Number((req.body ?? {}).characterId);
  if (!Number.isInteger(characterId) || characterId <= 0) {
    res.status(400).json({ error: "characterId is required." });
    return;
  }

  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  if (roleIds === null) {
    res.status(502).json({ error: "Could not verify your Trauma Team subscription. Try again shortly." });
    return;
  }
  const tier = bestTier(roleIds);
  if (!tier) {
    res.status(403).json({ error: "You need an active Trauma Team subscription to call Trauma Team." });
    return;
  }

  const [ch] = await db
    .select({ id: characters.id, name: characters.name, ownerId: characters.ownerId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, u.id)));
  if (!ch) {
    res.status(404).json({ error: "Character not found (or not yours)." });
    return;
  }

  const prev = lastCallAt.get(u.id) ?? 0;
  const now = Date.now();
  if (now - prev < CALL_COOLDOWN_MS) {
    const waitS = Math.ceil((CALL_COOLDOWN_MS - (now - prev)) / 1000);
    res.status(429).json({ error: `Trauma Team was already called. Wait ${waitS}s before calling again.` });
    return;
  }
  lastCallAt.set(u.id, now);

  const scan = await listGuildMembersWithRole(TRAUMA_TEAM_ROLE_ID);
  if (scan === null) {
    lastCallAt.delete(u.id); // don't burn the cooldown on a failed call
    res.status(502).json({ error: "Could not reach Discord to page Trauma Team. Try again shortly." });
    return;
  }
  if (scan.holders.length === 0) {
    lastCallAt.delete(u.id);
    res.status(502).json({ error: "No Trauma Team responders found on Discord." });
    return;
  }

  const message = [
    `\u{1F6A8} **TRAUMA TEAM CALL** \u{1F6A8}`,
    `**${ch.name}** (<@${u.discordId}>) is requesting Trauma Team to their location **immediately**.`,
    `Subscription: **Trauma Team ${tier}**`,
  ].join("\n");

  const simulated = !externalWritesAllowed();
  let notified = 0;
  // Sequential on purpose: DM-channel creation is rate-limit sensitive and the
  // responder list is small; a failed DM (closed DMs) is a non-fatal miss.
  for (const m of scan.holders) {
    const id = await sendDirectMessage(m.id, message);
    if (id) notified++;
  }

  void recordAudit({
    req,
    category: "character",
    action: "trauma_call",
    actorId: u.id,
    targetType: "character",
    targetId: ch.id,
    message: `Trauma Team called for ${ch.name} (${tier}) — paged ${notified}/${scan.holders.length} responders${simulated ? " [simulated]" : ""}`,
  });
  logger.info({ userId: u.id, characterId: ch.id, tier, responders: scan.holders.length, notified, simulated }, "trauma team called");

  res.json({ ok: true, tier, responders: scan.holders.length, notified, simulated });
});

export default router;
