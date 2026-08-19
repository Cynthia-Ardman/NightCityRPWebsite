import type { IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import {
  db, users, characters, walletTransactions, activityEvents, botConfig,
  inventoryItems, inventoryEvents,
  stores, ripperdocs, saleOffers,
  botCyberwareStatus,
} from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { hasRole, grantDeadCharacterRole } from "../../lib/discord";
import { recordAudit } from "../../lib/audit";
import { auditLog, classifyWalletCategory } from "@workspace/db";
import { deriveCyberwareBand, weeksSinceLastCheckup, CYBERWARE_MAX_STREAK, CHECKUP_WEEK_GRACE_MS, householdEffectiveCheckupDate, nextWeeklyRunDate } from "../../lib/jobs";
import { parseCwp, cwpForItem } from "../../lib/cyberware";
import { batchSlotClashError, loadCyberwareSlotByName } from "../../lib/cyberwareSlots";
import { normalizeName } from "../../lib/strings";
import { adminOrFixer, resolveOrProvisionOwner } from "./shared";

// Manually create a character from the admin UI. Bypasses the player sheet
// → review → approve pipeline: an admin types the details directly, so
// the row lands APPROVED and active immediately. Owner is optional (leave it
// blank to create an unclaimed character and assign it later). Portrait URLs
// are already-uploaded object-storage paths from the presigned-URL flow.
const CHARACTER_KINDS = new Set(["pc", "npc"]);
const LIFE_STATUSES = new Set(["active", "dead", "missing", "loa", "retired"]);

// Ripperdoc checkup. Records a checkup, resets the missed-checkup streak
// to zero, and optionally re-bands the character's cyberwareLevel
// (none|medium|high|extreme) which drives the weekly meds formula.
// Authorized for ADMIN or RIPPERDOC — staff still cover for clinics with
// no on-call doc, but a doc can run their own clinic without needing
// admin tokens.
const CYBERWARE_LEVELS = new Set(["none", "medium", "high", "extreme"]);

// TEMPORARY event/amnesty mode: when bot_config.checkup_reset_floor_weeks is a
// positive number N, a checkup no longer resets the meds streak to week 1 —
// instead it caps it at week N. Concretely the recorded checkup date becomes
// max(character's current effective date, now - (N-1) weeks), so:
//   - someone on week 5+ drops to exactly week N (e.g. 4), and
//   - someone already at or below week N keeps their current date untouched
//     (a checkup never moves the effective date BACKWARD — see
//     .agents/memory/checkup-streak-creation-floor.md).
// Missing key / 0 / non-numeric = normal behavior (full reset to now).
// Admins flip this in the System Flags UI; delete the key to end the event.
export const CHECKUP_FLOOR_KEY = "checkup_reset_floor_weeks";

async function checkupResetFloorWeeks(): Promise<number> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, CHECKUP_FLOOR_KEY));
    const n = typeof row?.value === "number" ? row.value : Number(row?.value);
    if (!Number.isFinite(n) || n < 1) return 0;
    return Math.min(Math.floor(n), CYBERWARE_MAX_STREAK);
  } catch {
    // Fail-safe: on a read error, behave normally (full reset).
    return 0;
  }
}

export function registerCharacters(router: IRouter): void {
  router.get("/admin/characters", adminOrFixer, async (_req, res): Promise<void> => {
    const rows = await db
      .select({
        id: characters.id,
        ownerId: characters.ownerId,
        name: characters.name,
        kind: characters.kind,
        archetype: characters.archetype,
        approved: characters.approved,
        archived: characters.archived,
        claimed: characters.claimed,
        lifeStatus: characters.lifeStatus,
        legacyDiscordUsername: characters.legacyDiscordUsername,
        importedFromChannelName: characters.importedFromChannelName,
        createdAt: characters.createdAt,
        ownerName: users.username,
      })
      .from(characters)
      .leftJoin(users, eq(users.id, characters.ownerId))
      .orderBy(desc(characters.createdAt));
    res.json(rows);
  });

  router.post("/admin/characters", adminOrFixer, async (req, res): Promise<void> => {
    const b = (req.body ?? {}) as {
      name?: unknown;
      kind?: unknown;
      ownerId?: unknown;
      archetype?: unknown;
      background?: unknown;
      portraitUrls?: unknown;
      statsImageUrls?: unknown;
      lifeStatus?: unknown;
      traumaTeamTier?: unknown;
      xanaduGold?: unknown;
      sheetData?: unknown;
      cyberware?: unknown;
    };

    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const kind = typeof b.kind === "string" ? b.kind : "pc";
    if (!CHARACTER_KINDS.has(kind)) {
      res.status(400).json({ error: "kind must be 'pc' or 'npc'" });
      return;
    }
    const lifeStatus = typeof b.lifeStatus === "string" ? b.lifeStatus : "active";
    if (!LIFE_STATUSES.has(lifeStatus)) {
      res.status(400).json({ error: "invalid lifeStatus" });
      return;
    }
    const portraitUrls = Array.isArray(b.portraitUrls)
      ? b.portraitUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    const statsImageUrls = Array.isArray(b.statsImageUrls)
      ? b.statsImageUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    const archetype = typeof b.archetype === "string" && b.archetype.trim() ? b.archetype.trim() : null;
    const background = typeof b.background === "string" && b.background.trim() ? b.background.trim() : null;

    // Trauma Team subscription tier — optional, validated against the same set the
    // edit dialog / autobiller use. Empty string or null clears it.
    const TRAUMA_TIERS = new Set(["silver", "gold", "platinum", "diamond", "corporate"]);
    let traumaTeamTier: string | null = null;
    if (typeof b.traumaTeamTier === "string" && b.traumaTeamTier.trim()) {
      const t = normalizeName(b.traumaTeamTier);
      if (!TRAUMA_TIERS.has(t)) {
        res.status(400).json({ error: `traumaTeamTier must be one of: ${[...TRAUMA_TIERS].join(", ")}` });
        return;
      }
      traumaTeamTier = t;
    }
    const xanaduGold = b.xanaduGold === true;

    // sheetData carries the on-profile preamble + labeled sections (parity with
    // the edit dialog). Keep only the recognised shape so junk can't be stored.
    let sheetData: { preamble?: string; sections?: Record<string, string> } | null = null;
    if (b.sheetData && typeof b.sheetData === "object") {
      const sd = b.sheetData as Record<string, unknown>;
      const preamble = typeof sd.preamble === "string" ? sd.preamble : "";
      const sections: Record<string, string> = {};
      if (sd.sections && typeof sd.sections === "object") {
        for (const [k, v] of Object.entries(sd.sections as Record<string, unknown>)) {
          if (k.trim() && typeof v === "string") sections[k] = v;
        }
      }
      if (preamble.trim() || Object.keys(sections).length > 0) {
        sheetData = { preamble, sections };
      }
    }

    // Cyberware rows are materialised as inventory_items (category "cyberware")
    // using the same "CWP <n> · <notes> · slot: <x>" note convention the sheet
    // seeder uses, so band derivation + per-slot grouping work identically.
    const cyberRows: Array<{ name: string; notes: string }> = [];
    if (Array.isArray(b.cyberware)) {
      for (const raw of b.cyberware) {
        const cw = (raw ?? {}) as Record<string, unknown>;
        const cwName = String(cw.name ?? "").trim() || String(cw.slot ?? "").trim();
        if (!cwName) continue;
        const points = Number(cw.points) || 0;
        const slot = String(cw.slot ?? "").trim();
        const userNotes = String(cw.notes ?? "").trim();
        const parts = [`CWP ${points}`];
        if (userNotes) parts.push(userNotes);
        if (slot) parts.push(`slot: ${slot}`);
        cyberRows.push({ name: cwName, notes: parts.join(" · ") });
      }
    }
    // One-per-capped-slot guard across the seeded set (PCs only — staff manage
    // NPC chrome freely). Every row here is INSTALLED (carries "CWP n"), and the
    // per-item install guard never sees sibling rows of the same batch.
    if (kind !== "npc" && cyberRows.length > 1) {
      const clash = batchSlotClashError(cyberRows, await loadCyberwareSlotByName());
      if (clash) {
        res.status(409).json({ error: clash });
        return;
      }
    }

    let ownerId: string | null = null;
    let owner: typeof users.$inferSelect | undefined;
    if (typeof b.ownerId === "string" && b.ownerId.trim()) {
      ownerId = b.ownerId.trim();
      const resolved = await resolveOrProvisionOwner(ownerId);
      if (!resolved) {
        res.status(404).json({ error: "Owner (user) not found" });
        return;
      }
      owner = resolved;
    }

    const created = await db.transaction(async (tx) => {
      // A manually created, already-approved PC must not reset the owner's
      // household meds streak — inherit the household's current effective
      // checkup date (see householdEffectiveCheckupDate in lib/jobs.ts).
      const inheritedCheckupAt =
        kind === "pc" && ownerId ? await householdEffectiveCheckupDate(tx, ownerId) : null;
      const [row] = await tx
        .insert(characters)
        .values({
          name,
          kind,
          ownerId,
          claimed: ownerId !== null,
          ...(inheritedCheckupAt ? { lastCheckupAt: inheritedCheckupAt } : {}),
          archetype,
          background,
          portraitUrls,
          statsImageUrls,
          // Keep the legacy single-portrait column in sync with the first image so
          // older read paths that still read portraitUrl show something.
          portraitUrl: portraitUrls[0] ?? null,
          approved: true,
          lifeStatus,
          traumaTeamTier,
          xanaduGold,
          sheetData,
        })
        .returning();

      if (cyberRows.length > 0) {
        const inserted = await tx
          .insert(inventoryItems)
          .values(
            cyberRows.map((r) => ({
              characterId: row.id,
              ownerId,
              name: r.name,
              category: "cyberware",
              quantity: 1,
              notes: r.notes,
              equipped: true,
            })),
          )
          .returning({ instanceUuid: inventoryItems.instanceUuid, name: inventoryItems.name });

        await tx.insert(inventoryEvents).values(
          inserted.map((it) => ({
            instanceUuid: it.instanceUuid,
            kind: "created" as const,
            toCharacterId: row.id,
            itemName: it.name,
            quantity: 1,
            reason: "Seeded from admin character creation",
          })),
        );
      }

      return row;
    });

    await recordAudit({
      req,
      category: "admin",
      action: "character.create",
      targetType: "character",
      targetId: String(created.id),
      message: `Manually created ${kind.toUpperCase()} "${name}"${owner ? ` for ${owner.username}` : " (unclaimed)"}`,
      after: { id: created.id, name, kind, ownerId, lifeStatus },
    });
    await db.insert(activityEvents).values({
      kind: "character_created",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} manually created ${name}${owner ? ` for ${owner.username}` : ""}`,
    });

    // A PC created directly in the "dead" state still earns its owner the Dead
    // Character role (afterlife-drinks access). Fire-and-forget + idempotent;
    // the hourly role_sync backfill covers any miss.
    if (kind === "pc" && lifeStatus === "dead") {
      grantDeadCharacterRole(ownerId, name, "created dead (admin)");
    }

    res.status(201).json(created);
  });

  // Assign or reassign the ownerId of an imported character. Used by the
  // admin/fixer UI to claim an unclaimed sheet for a player who returned to
  // the server under a different account.
  router.put("/admin/characters/:id/owner", adminOrFixer, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { ownerId } = (req.body ?? {}) as { ownerId?: string };
    if (!ownerId) {
      res.status(400).json({ error: "ownerId required" });
      return;
    }
    const [c] = await db.select().from(characters).where(eq(characters.id, id));
    if (!c) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    const u = await resolveOrProvisionOwner(ownerId);
    if (!u) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    // Joining a household must not reset the new owner's meds streak: if this
    // PC has never had a checkup, inherit the household's current effective
    // checkup date (see householdEffectiveCheckupDate in lib/jobs.ts). Safe in
    // both directions — the stamped date is the household max over the OTHER
    // billable PCs, so the household week never moves backward or forward
    // except to undo the reset this fresh row would otherwise cause.
    const inheritedCheckupAt =
      c.kind === "pc" && c.approved && !c.lastCheckupAt
        ? await householdEffectiveCheckupDate(db, ownerId, c.id)
        : null;
    const [updated] = await db
      .update(characters)
      .set({
        ownerId,
        claimed: true,
        ...(inheritedCheckupAt ? { lastCheckupAt: inheritedCheckupAt } : {}),
      })
      .where(eq(characters.id, id))
      .returning();
    await db.insert(activityEvents).values({
      kind: "character_claimed",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} assigned ${c.name} to ${u.username}`,
    });
    await recordAudit({
      req,
      category: "character",
      action: "owner_assign",
      targetType: "character",
      targetId: id,
      message: `Assigned ${c.name} to ${u.username}`,
      before: { ownerId: c.ownerId },
      after: { ownerId, claimed: true },
    });
    res.json(updated);
  });

  router.delete("/admin/characters/:id/owner", adminOrFixer, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [c] = await db.select().from(characters).where(eq(characters.id, id));
    if (!c) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [updated] = await db
      .update(characters)
      .set({ ownerId: null, claimed: false })
      .where(eq(characters.id, id))
      .returning();
    await db.insert(activityEvents).values({
      kind: "character_unclaimed",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} cleared ownership of ${c.name}`,
    });
    await recordAudit({
      req,
      category: "character",
      action: "owner_clear",
      targetType: "character",
      targetId: id,
      message: `Cleared ownership of ${c.name}`,
      before: { ownerId: c.ownerId },
      after: { ownerId: null, claimed: false },
    });
    res.json(updated);
  });

  router.post("/admin/characters/:id/checkup", requireAuth, async (req, res): Promise<void> => {
    const u = req.user!;
    if (!hasRole(u.roles ?? [], "ADMIN") && !hasRole(u.roles ?? [], "RIPPERDOC")) {
      res.status(403).json({ error: "Admin or ripperdoc role required" });
      return;
    }
    const id = parseInt(String(req.params.id), 10);
    const [c] = await db.select().from(characters).where(eq(characters.id, id));
    if (!c) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Optional re-band. If provided, must be a known level. Falsy/undefined
    // means "leave the existing level alone" — a checkup without re-banding
    // is the common case for already-classified players.
    const rawLevel = typeof req.body?.cyberwareLevel === "string"
      ? req.body.cyberwareLevel.toLowerCase().trim()
      : "";
    if (rawLevel && !CYBERWARE_LEVELS.has(rawLevel)) {
      res.status(400).json({ error: `cyberwareLevel must be one of: ${[...CYBERWARE_LEVELS].join(", ")}` });
      return;
    }
    const now = new Date();
    // Temporary floor mode (see CHECKUP_FLOOR_KEY above): cap the reset at week
    // N instead of clearing it. weeksSinceLastCheckup() maps a date D to
    // floor((runAt-D)/1w)+1, so "exactly week N at the next billing run" =
    // nextRun - (N-1) weeks.
    const floorWeeks = await checkupResetFloorWeeks();
    let checkupDate = now;
    if (floorWeeks >= 1) {
      // Anchor the cap against the NEXT weekly billing run, not "now". Billing
      // (the cyberware_humanity cron) and the dashboard projection both compute
      // weeksSinceLastCheckup AT the next Monday 05:00 UTC tick — so a date set
      // to "week N as of now" reads as week N+1 by the time the bill lands
      // (e.g. a Sunday checkup under floor 4 was billed at week 5 the next
      // morning). date = nextRun - (N-1) weeks - grace makes the run itself
      // week N exactly (weeksSinceLastCheckup subtracts CHECKUP_WEEK_GRACE_MS
      // before flooring, so the anchor must pre-add it back). Clamp to `now`
      // so N=1 (or a run inside the window) never stamps a future checkup date.
      const anchored = nextWeeklyRunDate(now).getTime() - (floorWeeks - 1) * 7 * 86400000 - CHECKUP_WEEK_GRACE_MS;
      const floorDate = new Date(Math.min(anchored, now.getTime()));
      // Effective date mirrors billing exactly: lastCheckupAt when set, else
      // createdAt (the implicit initial checkup). Do NOT max() with createdAt —
      // billing derives weeks from lastCheckupAt whenever present, and the floor
      // must cap relative to the same date the player is actually billed on.
      const effective = c.lastCheckupAt ?? c.createdAt ?? null;
      checkupDate = effective && effective.getTime() > floorDate.getTime() ? effective : floorDate;
    }
    const floorApplied = floorWeeks >= 1 && checkupDate.getTime() !== now.getTime();
    const patch: Record<string, unknown> = { lastCheckupAt: checkupDate, checkupStreak: 0 };
    if (rawLevel) patch.cyberwareLevel = rawLevel;
    const [updated] = await db
      .update(characters)
      .set(patch)
      .where(eq(characters.id, id))
      .returning();
    // Mirror the checkup into the per-user bot_cyberware_status table — the
    // dashboard's UPCOMING_BILLS card reads from there first, since checkups
    // are a per-USER concept (one ripperdoc visit resets the streak for every
    // character that user owns, regardless of which character was examined).
    // Without this, a fresh checkup would show in characters.lastCheckupAt
    // but the dashboard would still report the old stale streak from the
    // legacy mirror. Owner can be null on orphan characters — skip the mirror
    // write if so; the character-level reset above is still applied.
    if (updated.ownerId) {
      const [owner] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, updated.ownerId))
        .limit(1);
      if (owner?.discordId) {
        // Mirror weeks: 0 for a normal full reset; under floor mode, the capped
        // week count minus 1 (the mirror historically stores "completed weeks",
        // matching weeks:0 for a just-now checkup where weeksSince = 1).
        // Evaluate at the next billing run — the same instant billing uses —
        // so a floor-capped checkup mirrors exactly N-1, not a drifting value.
        const mirrorWeeks = Math.max(0, weeksSinceLastCheckup(checkupDate, nextWeeklyRunDate(now)) - 1);
        await db
          .insert(botCyberwareStatus)
          .values({ userId: owner.discordId, weeks: mirrorWeeks, lastProcessed: now, updatedAt: now })
          .onConflictDoUpdate({
            target: botCyberwareStatus.userId,
            set: { weeks: mirrorWeeks, lastProcessed: now, updatedAt: now },
          });
      }
    }
    const floorNote = floorApplied ? ` [floor: capped at week ${floorWeeks}]` : "";
    const levelNote = (rawLevel ? ` (level: ${rawLevel})` : "") + floorNote;
    await db.insert(activityEvents).values({
      kind: "checkup",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} recorded a ripperdoc checkup for ${c.name}${levelNote}`,
    });
    await recordAudit({
      req,
      category: "character",
      action: "checkup",
      targetType: "character",
      targetId: id,
      message: `Ripperdoc checkup for ${c.name}${levelNote}`,
      before: { cyberwareLevel: c.cyberwareLevel, checkupStreak: c.checkupStreak },
      after: { cyberwareLevel: updated.cyberwareLevel, checkupStreak: updated.checkupStreak },
    });
    res.json({
      characterId: updated.id,
      lastCheckupAt: updated.lastCheckupAt?.toISOString() ?? null,
      checkupStreak: updated.checkupStreak,
      cyberwareLevel: updated.cyberwareLevel,
    });
  });

  // Consolidated medical record for the Ripperdoc Console. Role-gated to
  // RIPPERDOC/ADMIN (mirrors the checkup endpoint above) so a doc can pull up
  // ANY patient — the owner-scoped /characters/:id read endpoints would 404 for
  // other players' characters. Returns the derived cyberpsychosis band (NOT the
  // stale legacy `cyberwareLevel` column, which is "none" for almost everyone),
  // installed chrome, checkup history (from the audit log), and meds/cyberware
  // payment history (wallet rows in the "cyberware" category).
  router.get("/admin/characters/:id/medical", requireAuth, async (req, res): Promise<void> => {
    const u = req.user!;
    if (!hasRole(u.roles ?? [], "ADMIN") && !hasRole(u.roles ?? [], "RIPPERDOC")) {
      res.status(403).json({ error: "Admin or ripperdoc role required" });
      return;
    }
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [c] = await db.select().from(characters).where(eq(characters.id, id));
    if (!c) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Installed chrome: cyberware category AND a CWP install tag — matches the
    // clinic capacity endpoint so the console's view stays consistent with the
    // install/remove flow. Untagged chrome contributes 0 CWP and isn't installed.
    const cyberRows = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.characterId, id), eq(inventoryItems.category, "cyberware")));
    const installedRows = cyberRows.filter((it) => parseCwp(it.notes) != null);
    const usedCwp = installedRows.reduce((sum, it) => sum + cwpForItem(it), 0);
    // NPCs are exempt from cyberpsychosis banding; everyone else derives from CWP.
    const band = c.kind === "npc" ? "exempt" : deriveCyberwareBand(usedCwp).level;

    // Checkup history lives in the audit log (no dedicated table — the checkup
    // endpoint only resets lastCheckupAt and writes an audit row per visit).
    const checkupRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "character"),
          eq(auditLog.targetId, String(id)),
          eq(auditLog.action, "checkup"),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(100);

    // Meds + cyberware payment history: character-scoped wallet rows whose
    // category resolves to "cyberware" (weekly meds bill, install/removal fees).
    const txnRows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.characterId, id))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(200);
    const medsPayments = txnRows
      .map((r) => ({ row: r, category: r.category ?? classifyWalletCategory(r.kind, r.memo) }))
      .filter((x) => x.category === "cyberware")
      .map(({ row, category }) => ({
        id: row.id,
        amount: row.amount,
        kind: row.kind,
        memo: row.memo,
        category,
        createdAt: row.createdAt?.toISOString() ?? null,
      }));

    // Paid bills: every APPROVED sale offer this character was billed for —
    // service bills, purchases, installs, removals — with the venue it came
    // from. status="approved" is the terminal paid state (money already moved).
    const billRows = await db
      .select({
        id: saleOffers.id,
        offerType: saleOffers.offerType,
        itemName: saleOffers.itemName,
        itemCategory: saleOffers.itemCategory,
        quantity: saleOffers.quantity,
        totalPrice: saleOffers.totalPrice,
        memo: saleOffers.memo,
        decidedAt: saleOffers.decidedAt,
        createdAt: saleOffers.createdAt,
        kind: saleOffers.kind,
        storeName: stores.name,
        ripperdocName: ripperdocs.name,
      })
      .from(saleOffers)
      .leftJoin(stores, eq(saleOffers.storeId, stores.id))
      .leftJoin(ripperdocs, eq(saleOffers.ripperdocId, ripperdocs.id))
      .where(and(eq(saleOffers.buyerCharacterId, id), eq(saleOffers.status, "approved")))
      .orderBy(desc(saleOffers.decidedAt), desc(saleOffers.createdAt))
      .limit(200);
    const bills = billRows.map((b) => ({
      id: b.id,
      offerType: b.offerType,
      description: b.itemName,
      category: b.itemCategory,
      quantity: b.quantity,
      amount: b.totalPrice,
      memo: b.memo,
      venueName: b.storeName ?? b.ripperdocName ?? null,
      venueKind: b.kind,
      paidAt: (b.decidedAt ?? b.createdAt)?.toISOString() ?? null,
    }));

    res.json({
      characterId: c.id,
      characterName: c.name,
      kind: c.kind,
      cyberwareLevel: c.cyberwareLevel,
      band,
      usedCwp,
      createdAt: c.createdAt?.toISOString() ?? null,
      lastCheckupAt: c.lastCheckupAt?.toISOString() ?? null,
      // Real most-recent VISIT (newest audit checkup row). Diverges from
      // lastCheckupAt while the checkup-reset-floor event backdates the
      // billing-effective date; the console shows this one to the doc.
      lastCheckupActualAt:
        checkupRows[0]?.createdAt?.toISOString() ?? c.lastCheckupAt?.toISOString() ?? null,
      checkupStreak: c.checkupStreak,
      installed: installedRows.map((it) => ({
        id: it.id,
        name: it.name,
        quantity: it.quantity,
        notes: it.notes,
        cwp: cwpForItem(it),
      })),
      checkups: checkupRows.map((a) => ({
        id: a.id,
        message: a.message,
        actorName: a.actorName,
        createdAt: a.createdAt?.toISOString() ?? null,
        level:
          a.afterJson && typeof a.afterJson === "object" && "cyberwareLevel" in a.afterJson
            ? (a.afterJson as { cyberwareLevel?: string | null }).cyberwareLevel ?? null
            : null,
      })),
      medsPayments,
      bills,
    });
  });
}
