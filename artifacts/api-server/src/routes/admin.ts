import { Router, type IRouter, json as expressJson } from "express";
import { eq, desc, sql, and, gte, type SQL } from "drizzle-orm";
import {
  db, users, characters, walletTransactions, jobRuns, activityEvents, botConfig,
  characterStatus, housing, catalogRent,
  characterUpdates, inventoryItems, inventoryEvents,
  storeEmployees, stores, ripperdocs, ripperdocEmployees,
  housingRequests, traumaTeamCalls, missionLog,
  customRequests, saleOffers, missionApplications, missionAssignments,
  pendingCharacterEdits, shopOpens, characterSheets, diceRolls,
  botActorAttendance, botAttendanceLog, botBalanceHistory, botCyberwareStatus,
  botCyberwareWeeklyRuns, botLastPayment, botPaymentLabels, botRentRuns,
  botStoreInventory, botTicketIndex, botMissionLog, botBusinessOpenLog,
  botPlayerInventory,
} from "@workspace/db";
import { isNull, or, ilike, count, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import { fetchGuildMemberRolesViaBot, fetchGuildMemberRoleIdsViaBot, fetchDiscordUser, searchGuildMembers, searchGuildChannels, hasRole, fetchThreadOpMessage, imageAttachmentsOf, listGuildMembersWithRole, addGuildMemberRole, grantDeadCharacterRole, NPC_ROLE_ID, VERIFIED_18_ROLE_ID, RIPPERDOC_ROLE_ID, RIPPERDOC_ROLE_MARKER, applyRoleIdGrants, externalWritesAllowed, type ThreadAttachment } from "../lib/discord";
import { resolveOrProvisionUser } from "../lib/userProvision";
import { ObjectStorageService } from "../lib/objectStorage";
import { patchBalance, getBalance } from "../lib/unbelievaboat";
import { runJob, deriveCyberwareBand, weeksSinceLastCheckup, CYBERWARE_MAX_STREAK, householdEffectiveCheckupDate } from "../lib/jobs";
import { recordAudit } from "../lib/audit";
import { auditLog, classifyWalletCategory } from "@workspace/db";
import { parseCwp, cwpForItem } from "../lib/cyberware";
import { getLiveModeState, LIVE_MODE_KEYS, LIVE_SYSTEMS, type LiveSystem } from "../lib/liveMode";
import { isLoginRestricted, LOGIN_RESTRICTED_KEY } from "../lib/siteAccess";
import { isVrchatCalendarSyncEnabled, VRCHAT_SYNC_FLAG } from "../lib/eventsService";
import { scanVrchatChannel } from "../lib/vrchatLinks";
import { getEconomyMode, reconcileOneUser, recordSettledWalletMovement, applyWalletDelta } from "../lib/economy";

const router: IRouter = Router();

// Most /admin routes are ADMIN-only, but the character listing + owner
// assign/clear endpoints are also exposed to FIXER (the in-fiction canon
// enforcer role). Auth is required for everything under /admin.
//
// IMPORTANT: we scope to "/admin" so this router does not intercept
// requests that fall through to sibling routers mounted after it
// (e.g. /storage/*, /housing/*). Express applies `router.use(mw)` to
// every request the sub-router sees, regardless of whether any local
// route matches — without the path scope, this would return 401 for
// every unauthenticated call on the entire API.
router.use("/admin", requireAuth);
const adminOnly = requireRole("ADMIN");
const adminOrFixer = requireAnyRole(["ADMIN", "FIXER"]);

// Provisioning a `users` stub for a Discord member who has never signed in lives
// in lib/userProvision so the actor-payment paths can share it. Staff can assign
// a character to ANYONE in the guild; if the target has no `users` row yet we
// mint one keyed on their Discord id, which their first login then adopts.
const resolveOrProvisionOwner = resolveOrProvisionUser;

router.get("/admin/users", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(users).orderBy(desc(users.lastSeenAt));
  res.json(
    rows.map((u) => ({
      id: u.id,
      discordId: u.discordId,
      username: u.username,
      globalName: u.globalName,
      avatarUrl: u.avatarUrl,
      roles: u.roles,
      isAdmin: hasRole(u.roles, "ADMIN"),
      isFixer: hasRole(u.roles, "FIXER"),
      isTrialFixer: hasRole(u.roles, "TRIAL_FIXER"),
      isCsApprover: hasRole(u.roles, "CS_APPROVER"),
      isRipperdoc: hasRole(u.roles, "RIPPERDOC"),
      isStoreOwner: hasRole(u.roles, "STORE_OWNER"),
      cyberpsychoAccess: u.cyberpsychoAccess,
      lastSeenAt: u.lastSeenAt,
      rolesSyncedAt: u.rolesSyncedAt,
    })),
  );
});

// Search the entire Discord guild for a member to assign as a character owner —
// including members who have never signed in (and so have no `users` row).
// Each result carries `hasAccount` so the UI can hint who is already a portal
// user; assignment provisions a stub `users` row for those who aren't (see
// resolveOrProvisionOwner), which their first login then adopts.
router.get("/admin/discord/members", adminOrFixer, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json([]);
    return;
  }
  const members = await searchGuildMembers(q, 25);
  if (members === null) {
    res.status(502).json({ error: "Discord member search is unavailable right now" });
    return;
  }
  const ids = members.map((m) => m.id);
  const existing = ids.length
    ? await db.select({ id: users.id }).from(users).where(inArray(users.id, ids))
    : [];
  const accountIds = new Set(existing.map((u) => u.id));
  res.json(
    members.map((m) => ({
      id: m.id,
      username: m.username,
      globalName: m.globalName,
      avatarUrl: m.avatarUrl,
      hasAccount: accountIds.has(m.id),
    })),
  );
});

// Search the guild's text channels by name so staff can reference a channel
// (#name) in a review discussion. Channels are cached server-side, so an empty
// query returns the full list (capped) — typing "#" shows channels immediately.
router.get("/admin/discord/channels", adminOrFixer, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const channels = await searchGuildChannels(q, 25);
  if (channels === null) {
    res.status(502).json({ error: "Discord channel search is unavailable right now" });
    return;
  }
  res.json(channels.map((c) => ({ id: c.id, name: c.name })));
});

// Read-only scan that reconciles who holds the self-service Discord "NPC" role
// against the portal's user accounts. Powers the admin "NPC Role Scan" card so
// staff can confirm the "Become an NPC" CTA hides for everyone who already has
// the role. Never mutates Discord or the DB.
router.get("/admin/npc-scan", adminOnly, async (_req, res): Promise<void> => {
  const scan = await listGuildMembersWithRole(NPC_ROLE_ID);
  if (scan === null) {
    res.status(502).json({
      determined: false,
      error: "Could not reach Discord to scan guild members. Try again shortly.",
    });
    return;
  }
  const { holders, truncated } = scan;
  const holderIds = new Set(holders.map((h) => h.id));
  const rows = await db.select().from(users);
  const websiteDiscordIds = new Set(rows.map((u) => u.discordId));

  const websiteNpcUsers = rows
    .filter((u) => holderIds.has(u.discordId))
    .map((u) => ({
      id: u.id,
      discordId: u.discordId,
      username: u.username,
      globalName: u.globalName,
      avatarUrl: u.avatarUrl,
    }))
    .sort((a, b) =>
      (a.globalName ?? a.username).localeCompare(b.globalName ?? b.username),
    );

  // NPC-role holders in Discord with no portal account (informational only).
  const guildOnlyUsers = holders
    .filter((h) => !websiteDiscordIds.has(h.id))
    .map((h) => ({
      discordId: h.id,
      username: h.username,
      globalName: h.globalName,
      avatarUrl: h.avatarUrl,
    }));

  res.json({
    determined: true,
    truncated,
    scannedAt: new Date().toISOString(),
    roleId: NPC_ROLE_ID,
    guildNpcCount: holders.length,
    websiteNpcCount: websiteNpcUsers.length,
    websiteNpcUsers,
    guildOnlyCount: guildOnlyUsers.length,
    guildOnlyUsers,
  });
});

router.get("/admin/users/:userId", adminOnly, async (req, res): Promise<void> => {
  const id = String(req.params.userId);
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const chars = await db.select().from(characters).where(eq(characters.ownerId, id));
  res.json({
    id: u.id,
    discordId: u.discordId,
    username: u.username,
    globalName: u.globalName,
    avatarUrl: u.avatarUrl,
    roles: u.roles,
    isAdmin: hasRole(u.roles, "ADMIN"),
    isFixer: hasRole(u.roles, "FIXER"),
    isTrialFixer: hasRole(u.roles, "TRIAL_FIXER"),
    isCsApprover: hasRole(u.roles, "CS_APPROVER"),
    isRipperdoc: hasRole(u.roles, "RIPPERDOC"),
    isStoreOwner: hasRole(u.roles, "STORE_OWNER"),
    cyberpsychoAccess: u.cyberpsychoAccess,
    lastSeenAt: u.lastSeenAt,
    rolesSyncedAt: u.rolesSyncedAt,
    characters: chars,
  });
});

// Bulk-hydrate users from Discord. Walks every users row, calls the Discord
// API by discordId, and overwrites username / globalName / avatarUrl when
// Discord returns a profile. Targets rows whose `username` is still the
// `user_<last6>` placeholder the prod-DB importer inserted, but `force=true`
// re-hydrates everyone. Returns counts so the UI can show what happened.
router.post("/admin/users/hydrate", adminOnly, async (req, res): Promise<void> => {
  const force = Boolean((req.body ?? {}).force);
  const rows = await db.select().from(users);
  const targets = force
    ? rows
    : rows.filter((u) => /^user_[A-Za-z0-9]+$/.test(u.username));
  let updated = 0;
  let missing = 0;
  for (const u of targets) {
    const profile = await fetchDiscordUser(u.discordId);
    if (!profile) {
      missing++;
      continue;
    }
    await db
      .update(users)
      .set({
        username: profile.username,
        globalName: profile.globalName,
        avatarUrl: profile.avatarUrl,
      })
      .where(eq(users.id, u.id));
    updated++;
  }
  res.json({ scanned: targets.length, updated, missing });
});

// Grant or revoke per-user access to the CyberPsycho control panel. Fixers and
// admins always have access via role; this flag hands the tool to specific
// non-staff users without touching Discord roles (and role_sync can't wipe it).
router.post("/admin/users/:userId/cyberpsycho-access", adminOnly, async (req, res): Promise<void> => {
  const id = String(req.params.userId);
  const enabled = (req.body ?? {}).enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(users).set({ cyberpsychoAccess: enabled }).where(eq(users.id, id));
  await recordAudit({
    req,
    category: "admin",
    action: enabled ? "cyberpsycho_access.grant" : "cyberpsycho_access.revoke",
    targetType: "user",
    targetId: id,
    message: `${enabled ? "Granted" : "Revoked"} CyberPsycho access for ${u.username}`,
    before: { cyberpsychoAccess: u.cyberpsychoAccess },
    after: { cyberpsychoAccess: enabled },
  });
  res.json({ id, cyberpsychoAccess: enabled });
});

router.post("/admin/users/:userId/roles", adminOnly, async (req, res): Promise<void> => {
  const id = String(req.params.userId);
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rawRoles = await fetchGuildMemberRolesViaBot(u.discordId);
  // Re-derive the age-verification flag from the raw role ids in the same sweep
  // so an admin re-syncing a member also refreshes their gate status. Only flip
  // when the bot lookup succeeded (non-null) to avoid clearing it on an outage.
  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  // Map id-gated grants (e.g. Trial Fixer → "fixer") onto the stored names.
  const roles = roleIds === null ? rawRoles : applyRoleIdGrants(rawRoles, roleIds);
  const verified18 =
    roleIds === null ? u.verified18 : roleIds.includes(VERIFIED_18_ROLE_ID);
  await db
    .update(users)
    .set({ roles, verified18, rolesSyncedAt: new Date() })
    .where(eq(users.id, id));
  res.json({ roles, verified18, rolesSyncedAt: new Date() });
});

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

// Manually create a character from the admin UI. Bypasses the player sheet
// → review → approve pipeline: an admin types the details directly, so
// the row lands APPROVED and active immediately. Owner is optional (leave it
// blank to create an unclaimed character and assign it later). Portrait URLs
// are already-uploaded object-storage paths from the presigned-URL flow.
const CHARACTER_KINDS = new Set(["pc", "npc"]);
const LIFE_STATUSES = new Set(["active", "dead", "missing", "loa", "retired"]);

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
    const t = b.traumaTeamTier.trim().toLowerCase();
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
  // floor((now-D)/1w)+1, so "exactly week N" = now - (N-1) weeks.
  const floorWeeks = await checkupResetFloorWeeks();
  let checkupDate = now;
  if (floorWeeks >= 1) {
    const floorDate = new Date(now.getTime() - (floorWeeks - 1) * 7 * 86400000);
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
      const mirrorWeeks = Math.max(0, weeksSinceLastCheckup(checkupDate, now) - 1);
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

  res.json({
    characterId: c.id,
    characterName: c.name,
    kind: c.kind,
    cyberwareLevel: c.cyberwareLevel,
    band,
    usedCwp,
    createdAt: c.createdAt?.toISOString() ?? null,
    lastCheckupAt: c.lastCheckupAt?.toISOString() ?? null,
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
  });
});

router.post("/admin/wallet/adjust", adminOnly, async (req, res): Promise<void> => {
  const { characterId, amount, memo, reason } = req.body ?? {};
  // The portal sends `reason`; older callers may send `memo`. Accept either.
  const note =
    typeof memo === "string" && memo.trim()
      ? memo.trim()
      : typeof reason === "string" && reason.trim()
        ? reason.trim()
        : null;
  if (!characterId || typeof amount !== "number") {
    res.status(400).json({ error: "characterId and amount required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (!c.ownerId) {
    res.status(400).json({ error: "Character has no owner (unclaimed)" });
    return;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
  if (!owner) {
    res.status(404).json({ error: "Character owner not found" });
    return;
  }
  // UB is authoritative — do not write a local ledger entry unless UB write succeeds.
  const ubResult = await patchBalance(owner.discordId, { cash: amount, reason: note ?? "Admin adjustment" });
  if (!ubResult) {
    res.status(502).json({ error: "Wallet provider unavailable or rejected adjustment" });
    return;
  }
  // Record the settled movement through the shared bridge so the website wallet
  // balance (users.walletBalance) advances immediately instead of drifting until
  // the next reconcile. Optional client idempotencyKey dedupes accidental
  // double-submits of the same adjustment.
  const idempotencyKey =
    typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim()
      ? `admin_adjust:${req.body.idempotencyKey.trim().slice(0, 80)}`
      : null;
  await recordSettledWalletMovement({
    userId: owner.id,
    amount,
    ubTotalAfter: ubResult.total,
    source: "admin",
    kind: "admin",
    memo: note,
    characterId,
    counterpartyName: req.user!.username,
    idempotencyKey,
  });
  await recordAudit({
    req,
    category: "wallet",
    action: "admin_adjust",
    targetType: "character",
    targetId: characterId,
    message: `${req.user!.username} adjusted ${c.name} by ${amount >= 0 ? "+" : ""}${amount}`,
    after: { amount, memo: note, ownerDiscordId: owner.discordId },
  });
  res.json({ success: true });
});

// Staff money sink: burn eddies from any character by "paying Night City Bot".
// A debit-only movement (no counterparty account credited) recorded with kind
// "sink" so it reads clearly in the ledger. Requires the character to have the
// cash on hand — for forcible removal beyond balance, use /admin/wallet/adjust.
router.post("/admin/wallet/sink", adminOnly, async (req, res): Promise<void> => {
  const { characterId, amount, memo } = req.body ?? {};
  const note = typeof memo === "string" && memo.trim() ? memo.trim() : null;
  if (!characterId || typeof amount !== "number" || amount <= 0) {
    res.status(400).json({ error: "characterId and positive amount required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (!c.ownerId) {
    res.status(400).json({ error: "Character has no owner (unclaimed)" });
    return;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
  if (!owner) {
    res.status(404).json({ error: "Character owner not found" });
    return;
  }
  const sinkKey =
    typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim()
      ? `sink:${req.body.idempotencyKey.trim().slice(0, 80)}`
      : null;
  if (sinkKey) {
    const [done] = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.idempotencyKey, sinkKey), eq(walletTransactions.syncStatus, "synced")));
    if (done) {
      const cur = await getBalance(owner.discordId);
      res.json({
        characterId,
        balance: cur?.total ?? 0,
        cash: cur?.cash ?? 0,
        bank: cur?.bank ?? 0,
        source: cur?.source ?? "unbelievaboat",
      });
      return;
    }
  }
  const bal = await getBalance(owner.discordId);
  if (!bal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (bal.cash < amount) {
    if (bal.total >= amount) {
      res.status(400).json({
        error: `Not enough cash on hand. ${c.name} has ${bal.cash.toLocaleString()} €$ in cash — withdraw from bank first, or use Manual Wallet Adjustment to force-remove.`,
      });
      return;
    }
    res.status(400).json({ error: "Insufficient funds" });
    return;
  }
  const debited = await patchBalance(owner.discordId, {
    cash: -amount,
    reason: note ?? "Paid Night City Bot",
  });
  if (!debited) {
    res.status(502).json({ error: "Wallet provider rejected debit" });
    return;
  }
  await recordSettledWalletMovement({
    userId: owner.id,
    amount: -amount,
    ubTotalAfter: debited.total,
    source: "admin",
    kind: "sink",
    memo: note,
    characterId,
    counterpartyName: "Night City Bot",
    idempotencyKey: sinkKey,
  });
  await recordAudit({
    req,
    category: "wallet",
    action: "sink",
    targetType: "character",
    targetId: characterId,
    message: `${req.user!.username} burned ${amount} from ${c.name} (paid Night City Bot)`,
    after: { characterId, amount, memo: note, ownerDiscordId: owner.discordId },
  });
  const ub = await getBalance(owner.discordId);
  res.json({
    characterId,
    balance: ub?.total ?? 0,
    cash: ub?.cash ?? 0,
    bank: ub?.bank ?? 0,
    source: ub?.source ?? "unbelievaboat",
  });
});

router.get("/admin/jobs", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);
  res.json(rows);
});

router.post("/admin/jobs/run", adminOnly, async (req, res): Promise<void> => {
  const job = String(req.body?.job ?? "");
  if (!["cyberware_humanity", "monthly_rent", "role_sync", "eviction_sweep", "discord_event_sync", "main_session_backfill", "mission_thread_backfill"].includes(job)) {
    res.status(400).json({ error: "Unknown job" });
    return;
  }
  const result = await runJob(job as "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep" | "discord_event_sync" | "main_session_backfill" | "mission_thread_backfill");
  res.json(result);
});

router.get("/admin/activity", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(100);
  res.json(rows);
});

// New unified audit log feed (separate from /admin/audit which still reads the
// legacy player-facing activity_events). Supports category/action/actor
// filters and a since cursor.
router.get("/admin/audit-log", adminOnly, async (req, res): Promise<void> => {
  const category = req.query.category ? String(req.query.category) : null;
  const actions = req.query.action
    ? String(req.query.action)
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  const actorId = req.query.actorId ? String(req.query.actorId) : null;
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const limit = Math.min(500, parseInt(String(req.query.limit ?? "200"), 10) || 200);
  const conds: SQL[] = [
    category && category !== "all" ? eq(auditLog.category, category) : null,
    actions.length === 1 ? eq(auditLog.action, actions[0]) : actions.length > 1 ? inArray(auditLog.action, actions) : null,
    actorId ? eq(auditLog.actorId, actorId) : null,
    since && !isNaN(since.getTime()) ? gte(auditLog.createdAt, since) : null,
  ].filter((c): c is SQL => c !== null);
  const rows = conds.length
    ? await db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.createdAt)).limit(limit)
    : await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
  res.json(rows);
});

router.get("/admin/audit", adminOnly, async (req, res): Promise<void> => {
  const kind = req.query.kind ? String(req.query.kind) : null;
  const actorId = req.query.actorId ? String(req.query.actorId) : null;
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const limit = Math.min(500, parseInt(String(req.query.limit ?? "100"), 10) || 100);
  const conds = [
    kind ? eq(activityEvents.kind, kind) : null,
    actorId ? eq(activityEvents.actorId, actorId) : null,
    since && !isNaN(since.getTime()) ? gte(activityEvents.createdAt, since) : null,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = conds.length
    ? await db.select().from(activityEvents).where(and(...conds)).orderBy(desc(activityEvents.createdAt)).limit(limit)
    : await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(limit);
  res.json(rows);
});

router.get("/admin/bot-config", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(botConfig).orderBy(botConfig.key);
  res.json(rows);
});

router.put("/admin/bot-config/:key", adminOnly, async (req, res): Promise<void> => {
  const key = String(req.params.key);
  if (!key) {
    res.status(400).json({ error: "key required" });
    return;
  }
  const { value } = req.body ?? {};
  if (value === undefined) {
    res.status(400).json({ error: "value required" });
    return;
  }
  const [row] = await db
    .insert(botConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: botConfig.key, set: { value, updatedAt: new Date() } })
    .returning();
  await db.insert(activityEvents).values({
    kind: "bot_config_set",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} updated bot_config.${key}`,
  });
  res.json(row);
});

router.delete("/admin/bot-config/:key", adminOnly, async (req, res): Promise<void> => {
  const key = String(req.params.key);
  await db.delete(botConfig).where(eq(botConfig.key, key));
  await db.insert(activityEvents).values({
    kind: "bot_config_delete",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} removed bot_config.${key}`,
  });
  res.sendStatus(204);
});

// ─── Site-wide Test/Live switchboard ──────────────────────────────────────
// A system performs live effects only when the master switch AND that system's
// own switch are both Live. Defaults are Test (off) everywhere.
router.get("/admin/live-mode", adminOnly, async (_req, res): Promise<void> => {
  res.json(await getLiveModeState());
});

router.put("/admin/live-mode", adminOnly, async (req, res): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fields: Array<{ name: "master" | LiveSystem; key: string }> = [
    { name: "master", key: LIVE_MODE_KEYS.master },
    ...LIVE_SYSTEMS.map((s) => ({ name: s, key: LIVE_MODE_KEYS[s] })),
  ];
  const changed: string[] = [];
  for (const f of fields) {
    if (typeof b[f.name] !== "boolean") continue;
    const value = b[f.name] as boolean;
    await db
      .insert(botConfig)
      .values({ key: f.key, value: value as never })
      .onConflictDoUpdate({ target: botConfig.key, set: { value: value as never, updatedAt: new Date() } });
    changed.push(`${f.name}=${value ? "LIVE" : "TEST"}`);
  }
  if (changed.length > 0) {
    await recordAudit({
      req,
      category: "admin",
      action: "live_mode.change",
      targetType: "config",
      targetId: "live_mode",
      message: `Live-mode switches updated: ${changed.join(", ")}`,
      after: b,
    });
  }
  res.json(await getLiveModeState());
});

// ─── Staff-only login lockdown ────────────────────────────────────────────
// When ON, only ADMIN / FIXER (incl. coordinator) / ARCHIVIST may sign in or
// use the portal; every other member is blocked at login and on every gated
// route. Defaults OFF.
router.get("/admin/site-access", adminOnly, async (_req, res): Promise<void> => {
  res.json({ loginRestricted: await isLoginRestricted() });
});

router.put("/admin/site-access", adminOnly, async (req, res): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.loginRestricted !== "boolean") {
    res.status(400).json({ error: "loginRestricted (boolean) required" });
    return;
  }
  const loginRestricted = b.loginRestricted;
  await db
    .insert(botConfig)
    .values({ key: LOGIN_RESTRICTED_KEY, value: loginRestricted as never })
    .onConflictDoUpdate({
      target: botConfig.key,
      set: { value: loginRestricted as never, updatedAt: new Date() },
    });
  await recordAudit({
    req,
    category: "admin",
    action: "site_access.change",
    targetType: "config",
    targetId: LOGIN_RESTRICTED_KEY,
    message: `Login restriction ${loginRestricted ? "ENABLED (staff only)" : "DISABLED"}`,
    after: { loginRestricted },
  });
  res.json({ loginRestricted });
});

// ─── VRChat group-calendar mirror kill-switch ─────────────────────────────
// When ON, qualifying website events (Main Sessions + social) are cross-posted
// to the NCRP VRChat group calendar. Independent of the Test/Live switchboard
// and additionally gated by the deployment write-gate + VRChat creds; defaults
// OFF so a fresh environment never touches the VRChat API until opted in.
router.get("/admin/vrchat-calendar-sync", adminOnly, async (_req, res): Promise<void> => {
  res.json({ enabled: await isVrchatCalendarSyncEnabled() });
});

router.put("/admin/vrchat-calendar-sync", adminOnly, async (req, res): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) required" });
    return;
  }
  const enabled = b.enabled;
  await db
    .insert(botConfig)
    .values({ key: VRCHAT_SYNC_FLAG, value: enabled as never })
    .onConflictDoUpdate({
      target: botConfig.key,
      set: { value: enabled as never, updatedAt: new Date() },
    });
  await recordAudit({
    req,
    category: "admin",
    action: "vrchat_calendar_sync.change",
    targetType: "config",
    targetId: VRCHAT_SYNC_FLAG,
    message: `VRChat calendar sync ${enabled ? "ENABLED" : "DISABLED"}`,
    after: { enabled },
  });
  res.json({ enabled });
});

// Re-scrape the VRChat username channel and refresh Discord<->VRChat links.
// Read-only on Discord (no live mutation), so not gated by the Test/Live
// switches — it only refreshes our local link table.
router.post("/admin/vrchat-links/scan", adminOnly, async (req, res): Promise<void> => {
  try {
    const result = await scanVrchatChannel();
    await recordAudit({
      req,
      category: "admin",
      action: "vrchat_links.scan",
      targetType: "config",
      targetId: "vrchat_links",
      message: `VRChat link scan: ${result.linkedPlayers} players linked from ${result.scannedMessages} messages`,
      after: result,
    });
    res.json(result);
  } catch (err) {
    req.log?.error?.({ err }, "vrchat link scan failed");
    res.status(502).json({ error: err instanceof Error ? err.message : "VRChat scan failed" });
  }
});

router.get("/admin/stats", adminOnly, async (_req, res): Promise<void> => {
  const [{ count: userCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const [{ count: charCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(characters);
  res.json({ userCount, charCount });
});

// ─── Economy sync dashboard ───────────────────────────────────────────────
// Surface players whose website wallet has drifted from their live UB balance
// (or whose last sync failed / whose UB balance can't be fetched) so an admin
// can investigate and trigger a safe per-user re-sync.
router.get("/admin/economy/out-of-sync", adminOnly, async (_req, res): Promise<void> => {
  const mode = await getEconomyMode();
  const rows = await db.select().from(users);
  const entries = [];
  for (const u of rows) {
    const ub = await getBalance(u.discordId);
    const ubBalance = ub ? ub.total : null;
    const diff = ubBalance === null ? null : ubBalance - u.walletBalance;
    const drift = diff !== null && diff !== 0;
    const failed = u.lastSyncStatus === "failed";
    const unreachable = ubBalance === null;
    if (!drift && !failed && !unreachable) continue;
    entries.push({
      userId: u.id,
      discordId: u.discordId,
      username: u.username,
      globalName: u.globalName,
      walletBalance: u.walletBalance,
      ubBalance,
      lastSyncedUbBalance: u.lastSyncedUbBalance,
      diff,
      lastSyncedAt: u.lastSyncedAt,
      lastSyncStatus: u.lastSyncStatus,
      lastSyncError: u.lastSyncError,
    });
  }
  res.json({ mode, entries });
});

router.post("/admin/economy/retry/:userId", adminOnly, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) {
    res.status(404).json({ error: "Unknown user" });
    return;
  }
  const result = await reconcileOneUser(userId);
  if (result.status === "disabled") {
    res.status(409).json({ ok: false, status: "disabled", balance: result.balance, error: "The economy system is currently disabled." });
    return;
  }
  await recordAudit({
    req,
    category: "wallet",
    action: "economy_retry",
    targetType: "user",
    targetId: userId,
    message: `${req.user!.username} re-synced ${u.username}'s wallet (status: ${result.status}, delta: ${result.delta >= 0 ? "+" : ""}${result.delta})`,
    after: { status: result.status, delta: result.delta, balance: result.balance },
  });
  res.json({ ok: result.ok, status: result.status, balance: result.balance, error: result.error ?? null });
});

// ─── NPC maintenance: dev → prod data sync ────────────────────────────────
// Production DB writes go through the running app (Replit's executeSql is
// read-only against prod, and migration scripts aren't allowed). Dev → prod
// data sync therefore uses an export/import pair:
//   1) Admin in dev calls GET /admin/maintenance/npc-export → JSON dump.
//   2) Admin in prod calls POST /admin/maintenance/npc-import with that JSON.
// Idempotent upsert keyed on (kind='npc', name). Admin-assigned ownerId is
// preserved on rerun via COALESCE so this is safe to import multiple times.
// Portrait URLs continue to resolve in prod because dev and prod share the
// same DEFAULT_OBJECT_STORAGE_BUCKET_ID.
router.get("/admin/maintenance/npc-export", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.kind, "npc"))
    .orderBy(characters.name);
  res.setHeader("content-disposition", `attachment; filename="ncrp-npcs-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    count: rows.length,
    npcs: rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      archetype: r.archetype,
      lifeStatus: r.lifeStatus,
      approved: r.approved,
      claimed: r.claimed,
      legacyDiscordUsername: r.legacyDiscordUsername,
      background: r.background,
      portraitUrl: r.portraitUrl,
      portraitUrls: r.portraitUrls,
      statsImageUrls: r.statsImageUrls,
      importedFromThreadId: r.importedFromThreadId,
      importedFromChannelName: r.importedFromChannelName,
      sheetData: r.sheetData,
      // ownerId intentionally OMITTED — owner assignments are environment-
      // local (a dev test owner won't exist in prod). Prod assignments must
      // be made via the existing /admin/characters/:id/owner endpoint.
    })),
  });
});

interface NpcExportRow {
  name: string;
  kind?: string;
  archetype?: string | null;
  lifeStatus?: string | null;
  approved?: boolean | null;
  claimed?: boolean | null;
  legacyDiscordUsername?: string | null;
  background?: string | null;
  portraitUrl?: string | null;
  portraitUrls?: string[] | null;
  statsImageUrls?: string[] | null;
  importedFromThreadId?: string | null;
  importedFromChannelName?: string | null;
  sheetData?: unknown;
}

router.post(
  "/admin/maintenance/npc-import",
  adminOnly,
  expressJson({ limit: "20mb" }),
  async (req, res): Promise<void> => {
    const body = req.body as { npcs?: NpcExportRow[] } | null;
    if (!body || !Array.isArray(body.npcs)) {
      res.status(400).json({ error: "Body must be { npcs: [...] }" });
      return;
    }
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors: Array<{ name: string; error: string }> = [];

    for (const npc of body.npcs) {
      if (!npc || typeof npc.name !== "string" || !npc.name.trim()) {
        skipped++;
        continue;
      }
      try {
        // Match the dev-to-prod character resolver: imported_from_thread_id
        // is the actual UNIQUE key on `characters`. If we look up only by
        // (kind,name) and the name has drifted (smart quotes, retitle),
        // we'll try to re-insert and either 500 on the unique index, or
        // (if the NPC arrived via a different code path with NULL
        // thread_id) silently create a half-populated duplicate.
        let existing: Array<{ id: number }> = [];
        if (npc.importedFromThreadId) {
          existing = await db
            .select({ id: characters.id })
            .from(characters)
            .where(eq(characters.importedFromThreadId, npc.importedFromThreadId))
            .limit(1);
        }
        if (existing.length === 0) {
          existing = await db
            .select({ id: characters.id })
            .from(characters)
            .where(and(eq(characters.kind, "npc"), eq(characters.name, npc.name)))
            .limit(1);
        }
        if (existing.length === 0) {
          await db.insert(characters).values({
            name: npc.name,
            kind: "npc",
            ownerId: null,
            archetype: npc.archetype ?? null,
            lifeStatus: npc.lifeStatus ?? "active",
            approved: npc.approved ?? true,
            claimed: npc.claimed ?? false,
            legacyDiscordUsername: npc.legacyDiscordUsername ?? null,
            background: npc.background ?? null,
            portraitUrl: npc.portraitUrl ?? null,
            portraitUrls: npc.portraitUrls ?? [],
            statsImageUrls: npc.statsImageUrls ?? [],
            importedFromThreadId: npc.importedFromThreadId ?? null,
            importedFromChannelName: npc.importedFromChannelName ?? null,
            sheetData: (npc.sheetData ?? null) as never,
          });
          inserted++;
        } else {
          // Preserve admin-assigned ownerId (never touched here). For other
          // fields, an explicit value in the export wins; otherwise keep what
          // prod already has, so admins editing in prod don't get clobbered.
          // approved/claimed are preserve-first too (previously they were always
          // overwritten with ?? true / ?? false, clobbering prod admin decisions
          // whenever the export omitted them).
          const updateSet: Record<string, unknown> = {};
          if (npc.approved != null) updateSet.approved = npc.approved;
          if (npc.claimed != null) updateSet.claimed = npc.claimed;
          if (npc.archetype != null) updateSet.archetype = npc.archetype;
          if (npc.lifeStatus != null) updateSet.lifeStatus = npc.lifeStatus;
          if (npc.legacyDiscordUsername != null) updateSet.legacyDiscordUsername = npc.legacyDiscordUsername;
          if (npc.background != null) updateSet.background = npc.background;
          if (npc.portraitUrl != null) updateSet.portraitUrl = npc.portraitUrl;
          if (Array.isArray(npc.portraitUrls) && npc.portraitUrls.length > 0) updateSet.portraitUrls = npc.portraitUrls;
          if (Array.isArray(npc.statsImageUrls) && npc.statsImageUrls.length > 0) updateSet.statsImageUrls = npc.statsImageUrls;
          if (npc.importedFromThreadId != null) updateSet.importedFromThreadId = npc.importedFromThreadId;
          if (npc.importedFromChannelName != null) updateSet.importedFromChannelName = npc.importedFromChannelName;
          if (npc.sheetData != null) updateSet.sheetData = npc.sheetData as never;
          if (Object.keys(updateSet).length > 0) {
            await db.update(characters).set(updateSet).where(eq(characters.id, existing[0].id));
          }
          updated++;
        }
      } catch (err) {
        errors.push({ name: npc.name, error: (err as Error).message });
      }
    }

    await recordAudit({
      req,
      category: "admin",
      action: "npc_import",
      message: `NPC import: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${errors.length} errors`,
      after: { inserted, updated, skipped, errors: errors.length },
    });
    res.json({ inserted, updated, skipped, errors });
  },
);

// ---------------------------------------------------------------------------
// One-time dev->prod full migration. Imports characters (NPCs + PCs),
// character_status, housing leases, and catalog_rent in one shot. Idempotent:
// safe to re-run. Characters are matched by (kind, name); status/housing
// rows reference their character by (character_kind, character_name) instead
// of numeric id (serial ids differ between databases). catalog_rent is keyed
// on name. Admin-edited prod values for an existing character are preserved.
// ---------------------------------------------------------------------------
interface FullImportChar extends NpcExportRow {
  ownerId?: string | null;
  discordChannelId?: string | null;
  lifestyleTierId?: number | null;
  traumaTeamTier?: string | null;
  xanaduGold?: boolean | null;
  cyberwareLevel?: string | null;
  appliedTags?: string[] | null;
  archived?: boolean | null;
  // snake_case aliases (the export uses pg row_to_json naming)
  owner_id?: string | null;
  legacy_discord_username?: string | null;
  portrait_url?: string | null;
  portrait_urls?: string[] | null;
  stats_image_urls?: string[] | null;
  sheet_data?: unknown;
  imported_from_thread_id?: string | null;
  imported_from_channel_name?: string | null;
  discord_channel_id?: string | null;
  applied_tags?: string[] | null;
  life_status?: string | null;
  lifestyle_tier_id?: number | null;
  trauma_team_tier?: string | null;
  xanadu_gold?: boolean | null;
  cyberware_level?: string | null;
}
interface FullImportStatus {
  character_kind?: string;
  character_name?: string;
  loa?: boolean | null;
  loa_returns_at?: string | null;
  attending?: boolean | null;
  open_shop?: boolean | null;
  status_message?: string | null;
}
interface FullImportHousing {
  character_kind?: string;
  character_name?: string;
  address?: string;
  monthly_rent?: number | null;
  kind?: string | null;
  paid_through?: string | null;
  delinquent_since?: string | null;
  notes?: string | null;
}
interface FullImportRent {
  name?: string;
  district?: string | null;
  tier?: string | null;
  monthly_rent?: number | null;
  description?: string | null;
}
interface FullImportBody {
  characters?: FullImportChar[];
  character_status?: FullImportStatus[];
  housing?: FullImportHousing[];
  catalog_rent?: FullImportRent[];
}

// Pull the export's value preferring snake_case keys (from row_to_json dumps)
// then camelCase, then default. Lets the same endpoint accept either shape.
function pick<T>(
  obj: Record<string, unknown>,
  snake: string,
  camel: string,
  fallback: T,
): T {
  const s = obj[snake];
  if (s !== undefined && s !== null) return s as T;
  const c = obj[camel];
  if (c !== undefined && c !== null) return c as T;
  return fallback;
}

router.post(
  "/admin/maintenance/full-import",
  adminOnly,
  expressJson({ limit: "50mb" }),
  async (req, res): Promise<void> => {
    const body = req.body as FullImportBody | null;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Body must be JSON object" });
      return;
    }
    const result = {
      characters: { inserted: 0, updated: 0, skipped: 0, errors: [] as Array<{ name: string; error: string }> },
      character_status: { inserted: 0, skipped: 0, errors: [] as Array<{ name: string; error: string }> },
      housing: { inserted: 0, skipped: 0, errors: [] as Array<{ address: string; error: string }> },
      catalog_rent: { inserted: 0, skipped: 0, errors: [] as Array<{ name: string; error: string }> },
    };

    // ---- 1) catalog_rent (insert by name if missing) -----------------------
    for (const r of body.catalog_rent ?? []) {
      const name = r.name?.trim();
      if (!name) { result.catalog_rent.skipped++; continue; }
      try {
        const existing = await db
          .select({ id: catalogRent.id })
          .from(catalogRent)
          .where(eq(catalogRent.name, name))
          .limit(1);
        if (existing.length === 0) {
          await db.insert(catalogRent).values({
            name,
            district: r.district ?? null,
            tier: r.tier ?? null,
            monthlyRent: r.monthly_rent ?? 0,
            description: r.description ?? null,
          });
          result.catalog_rent.inserted++;
        } else {
          result.catalog_rent.skipped++;
        }
      } catch (err) {
        result.catalog_rent.errors.push({ name, error: (err as Error).message });
      }
    }

    // Track every dev row → prod id we resolve in this pass, keyed by the
    // DEV-side `${kind}|${name.toLowerCase()}`. Downstream loops (status,
    // housing, …) look up by dev name; without this map, any case where
    // prod's stored name differs from dev's (smart quotes, retitle) would
    // cascade as "character not found in prod" even though the row was
    // successfully resolved by imported_from_thread_id above.
    const idByDevName = new Map<string, number>();

    // ---- 2) characters (upsert by imported_from_thread_id first, then kind+name)
    // Why thread-id first: `characters_imported_thread_idx` is a UNIQUE index
    // on imported_from_thread_id. Prod may already have a row imported via
    // the normal Discord-thread workflow under a slightly different name
    // (smart quotes, whitespace, post-import retitle). Looking up by
    // (kind,name) misses, we try to insert, and the unique index 500s the
    // row — then every downstream (character_status, housing, …) cascades
    // as "character not found in prod". Resolving by thread-id first makes
    // the importer truly idempotent against the actual unique key.
    for (const raw of body.characters ?? []) {
      const r = raw as unknown as Record<string, unknown>;
      const name = (raw.name as string | undefined)?.trim();
      const kind = (raw.kind as string | undefined) ?? "npc";
      const threadId = pick<string | null>(r, "imported_from_thread_id", "importedFromThreadId", null);
      if (!name) { result.characters.skipped++; continue; }
      try {
        let existing: Array<{ id: number }> = [];
        if (threadId) {
          existing = await db
            .select({ id: characters.id })
            .from(characters)
            .where(eq(characters.importedFromThreadId, threadId))
            .limit(1);
        }
        if (existing.length === 0) {
          existing = await db
            .select({ id: characters.id })
            .from(characters)
            .where(and(eq(characters.kind, kind), eq(characters.name, name)))
            .limit(1);
        }
        const values = {
          name,
          kind,
          ownerId: pick<string | null>(r, "owner_id", "ownerId", null),
          archetype: pick<string | null>(r, "archetype", "archetype", null),
          background: pick<string | null>(r, "background", "background", null),
          portraitUrl: pick<string | null>(r, "portrait_url", "portraitUrl", null),
          discordChannelId: pick<string | null>(r, "discord_channel_id", "discordChannelId", null),
          approved: pick<boolean>(r, "approved", "approved", true),
          claimed: pick<boolean>(r, "claimed", "claimed", false),
          legacyDiscordUsername: pick<string | null>(r, "legacy_discord_username", "legacyDiscordUsername", null),
          portraitUrls: pick<string[]>(r, "portrait_urls", "portraitUrls", []),
          statsImageUrls: pick<string[]>(r, "stats_image_urls", "statsImageUrls", []),
          sheetData: pick<unknown>(r, "sheet_data", "sheetData", null) as never,
          importedFromThreadId: pick<string | null>(r, "imported_from_thread_id", "importedFromThreadId", null),
          importedFromChannelName: pick<string | null>(r, "imported_from_channel_name", "importedFromChannelName", null),
          appliedTags: pick<string[]>(r, "applied_tags", "appliedTags", []),
          lifeStatus: pick<string>(r, "life_status", "lifeStatus", "active"),
          lifestyleTierId: pick<number | null>(r, "lifestyle_tier_id", "lifestyleTierId", null),
          traumaTeamTier: pick<string | null>(r, "trauma_team_tier", "traumaTeamTier", null),
          xanaduGold: pick<boolean>(r, "xanadu_gold", "xanaduGold", false),
          cyberwareLevel: pick<string>(r, "cyberware_level", "cyberwareLevel", "none"),
          archived: pick<boolean>(r, "archived", "archived", false),
        };
        if (existing.length === 0) {
          // Owner FK safety: only carry ownerId across if that Discord user
          // already exists in prod (users.id IS the Discord snowflake — global,
          // so it CAN match — but a PC's owner may not have logged into prod
          // yet, in which case the FK would 500 the whole row). Drop to null
          // and let the existing claim/assign flow attach the owner later.
          let safeOwnerId: string | null = null;
          if (values.ownerId) {
            const u = await db.select({ id: users.id }).from(users).where(eq(users.id, values.ownerId)).limit(1);
            if (u.length > 0) safeOwnerId = values.ownerId;
          }
          const ins = await db.insert(characters).values({ ...values, ownerId: safeOwnerId }).returning({ id: characters.id });
          if (ins[0]) idByDevName.set(`${kind}|${name.toLowerCase()}`, ins[0].id);
          result.characters.inserted++;
        } else {
          idByDevName.set(`${kind}|${name.toLowerCase()}`, existing[0].id);
          // PRESERVE-FIRST: never overwrite prod-side state on rerun. This
          // endpoint is a one-shot importer — admin edits made in prod after
          // the first import are sacred. We only fill *missing/empty* fields
          // (so a row imported headless can later get sheet/portrait data
          // backfilled), and we never touch ownerId, approved, claimed,
          // archived, lifeStatus, xanaduGold, lifestyleTierId — those are
          // admin-managed in prod.
          //   Memory: importer-upsert-idempotency, nullable-owner-guards.
          const prod = await db
            .select()
            .from(characters)
            .where(eq(characters.id, existing[0].id))
            .limit(1);
          const cur = prod[0];
          const updateSet: Record<string, unknown> = {};
          const fillIfEmpty = (k: keyof typeof cur, v: unknown) => {
            const curVal = cur[k];
            const isEmpty =
              curVal == null ||
              (typeof curVal === "string" && curVal.trim() === "") ||
              (Array.isArray(curVal) && curVal.length === 0);
            if (isEmpty && v != null && !(Array.isArray(v) && v.length === 0)) {
              updateSet[k] = v;
            }
          };
          fillIfEmpty("archetype", values.archetype);
          fillIfEmpty("background", values.background);
          fillIfEmpty("portraitUrl", values.portraitUrl);
          fillIfEmpty("discordChannelId", values.discordChannelId);
          fillIfEmpty("legacyDiscordUsername", values.legacyDiscordUsername);
          fillIfEmpty("portraitUrls", values.portraitUrls);
          fillIfEmpty("statsImageUrls", values.statsImageUrls);
          fillIfEmpty("appliedTags", values.appliedTags);
          fillIfEmpty("sheetData", values.sheetData);
          fillIfEmpty("importedFromThreadId", values.importedFromThreadId);
          fillIfEmpty("importedFromChannelName", values.importedFromChannelName);
          fillIfEmpty("traumaTeamTier", values.traumaTeamTier);
          fillIfEmpty("cyberwareLevel", values.cyberwareLevel === "none" ? null : values.cyberwareLevel);
          if (Object.keys(updateSet).length > 0) {
            await db.update(characters).set(updateSet).where(eq(characters.id, existing[0].id));
            result.characters.updated++;
          } else {
            result.characters.skipped++;
          }
        }
      } catch (err) {
        result.characters.errors.push({ name: name ?? "(unknown)", error: (err as Error).message });
      }
    }

    // Build prod-side (kind|name) -> id map for the linked tables. The
    // dev-name map above takes priority — it covers rows resolved via
    // imported_from_thread_id where prod's stored name differs from dev's.
    const allRows = await db
      .select({ id: characters.id, kind: characters.kind, name: characters.name })
      .from(characters);
    const idByName = new Map<string, number>();
    for (const r of allRows) idByName.set(`${r.kind}|${r.name.toLowerCase()}`, r.id);
    const lookup = (kind?: string, name?: string): number | undefined => {
      if (!kind || !name) return undefined;
      const key = `${kind}|${name.toLowerCase()}`;
      return idByDevName.get(key) ?? idByName.get(key);
    };

    // ---- 3) character_status (upsert by character_id) ----------------------
    for (const s of body.character_status ?? []) {
      const cid = lookup(s.character_kind, s.character_name);
      if (!cid) {
        result.character_status.skipped++;
        result.character_status.errors.push({ name: `${s.character_kind}/${s.character_name}`, error: "character not found in prod" });
        continue;
      }
      try {
        const existing = await db
          .select({ characterId: characterStatus.characterId })
          .from(characterStatus)
          .where(eq(characterStatus.characterId, cid))
          .limit(1);
        if (existing.length === 0) {
          await db.insert(characterStatus).values({
            characterId: cid,
            loa: s.loa ?? false,
            loaReturnsAt: s.loa_returns_at ? new Date(s.loa_returns_at) : null,
            attending: s.attending ?? false,
            openShop: s.open_shop ?? false,
            statusMessage: s.status_message ?? null,
          });
          result.character_status.inserted++;
        } else {
          result.character_status.skipped++;
        }
      } catch (err) {
        result.character_status.errors.push({ name: `${s.character_kind}/${s.character_name}`, error: (err as Error).message });
      }
    }

    // ---- 4) housing (insert; key uniqueness = char+address) ----------------
    for (const h of body.housing ?? []) {
      const cid = lookup(h.character_kind, h.character_name);
      const addr = h.address?.trim();
      if (!cid || !addr) {
        result.housing.skipped++;
        if (addr) result.housing.errors.push({ address: addr, error: cid ? "missing address" : "character not found in prod" });
        continue;
      }
      try {
        // Idempotent: skip if this character already has a lease at that address.
        const existing = await db
          .select({ id: housing.id })
          .from(housing)
          .where(and(eq(housing.characterId, cid), eq(housing.address, addr)))
          .limit(1);
        if (existing.length > 0) { result.housing.skipped++; continue; }
        await db.insert(housing).values({
          characterId: cid,
          address: addr,
          monthlyRent: h.monthly_rent ?? 0,
          kind: h.kind ?? "residential",
          paidThrough: h.paid_through ? new Date(h.paid_through) : null,
          delinquentSince: h.delinquent_since ? new Date(h.delinquent_since) : null,
          notes: h.notes ?? null,
        });
        result.housing.inserted++;
      } catch (err) {
        result.housing.errors.push({ address: addr, error: (err as Error).message });
      }
    }

    await recordAudit({
      req,
      category: "admin",
      action: "full_import",
      message: `Full migration import: chars +${result.characters.inserted}/~${result.characters.updated}, status +${result.character_status.inserted}, housing +${result.housing.inserted}, rent +${result.catalog_rent.inserted}`,
      after: {
        characters: { inserted: result.characters.inserted, updated: result.characters.updated, errors: result.characters.errors.length },
        character_status: { inserted: result.character_status.inserted, errors: result.character_status.errors.length },
        housing: { inserted: result.housing.inserted, errors: result.housing.errors.length },
        catalog_rent: { inserted: result.catalog_rent.inserted, errors: result.catalog_rent.errors.length },
      },
    });
    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// Bot DB import. Mirrors 13 tables from the legacy Discord-bot Replit DB
// (rent/cyberware/transactions/attendance/...) into the `bot_*` tables.
// Idempotent: each table uses its natural dedup key (bot_id where present,
// composite unique elsewhere). Big payloads inserted in 500-row chunks.
//   Body shape: { tables: { actor_attendance: [...], ... } }
// ---------------------------------------------------------------------------
interface BotImportBody {
  tables?: Record<string, Array<Record<string, unknown>>>;
}

// Insert rows in chunks so very large payloads (2,672 tickets, 1,777
// attendance rows) don't blow past pg's per-statement parameter limit.
// Uses RETURNING (any column) so `inserted` is the TRUE number of new rows —
// onConflictDoNothing skips don't show up in returning, so rerun counts go
// to zero. `chunkFailures` records full-chunk errors separately so the UI
// doesn't conflate a 500-row chunk crash with per-row failures.
async function chunkedInsert<T extends PgTable>(
  table: T,
  rows: Array<Record<string, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conflict: (q: any) => any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  returningCol: any,
): Promise<{ received: number; inserted: number; chunkFailures: number; lastError?: string }> {
  let inserted = 0;
  let chunkFailures = 0;
  let lastError: string | undefined;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q = (db.insert(table) as any).values(slice);
      const ret = await conflict(q).returning({ k: returningCol });
      inserted += Array.isArray(ret) ? ret.length : 0;
    } catch (e) {
      chunkFailures += 1;
      lastError = (e as Error).message;
    }
  }
  return { received: rows.length, inserted, chunkFailures, lastError };
}

function parseTs(v: unknown): Date | null {
  if (!v) return null;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
function asInt(v: unknown, dflt = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return dflt;
}
function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return String(v);
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

router.post(
  "/admin/maintenance/bot-import",
  adminOnly,
  expressJson({ limit: "50mb" }),
  async (req, res): Promise<void> => {
    const body = req.body as BotImportBody | null;
    if (!body?.tables || typeof body.tables !== "object") {
      res.status(400).json({ error: "Body must be { tables: { ... } }" });
      return;
    }
    const t = body.tables;
    // Validate every present table value is actually an array — protects
    // against malformed uploads (object/string/null) that would otherwise
    // 500 inside the .map() call below.
    for (const [k, v] of Object.entries(t)) {
      if (!Array.isArray(v)) {
        res.status(400).json({ error: `tables.${k} must be an array, got ${typeof v}` });
        return;
      }
    }

    type TableResult = { received: number; inserted: number; skippedInvalid: number; chunkFailures: number; note?: string };
    const out: Record<string, TableResult> = {};
    const skip = (name: string) => { out[name] = { received: 0, inserted: 0, skippedInvalid: 0, chunkFailures: 0, note: "not present in upload" }; };

    // Helper: take a mapped + filtered list and return both the kept rows
    // and the count of input rows that were dropped (missing required dedup
    // fields). Strict idempotency rule: rows missing a dedup key are SKIPPED,
    // never inserted with a fabricated value — fabrication breaks rerun.
    function split<R>(input: unknown[], map: (r: Record<string, unknown>) => R | null): { rows: R[]; skippedInvalid: number } {
      const rows: R[] = [];
      let skippedInvalid = 0;
      for (const raw of input) {
        const r = map(raw as Record<string, unknown>);
        if (r == null) skippedInvalid++; else rows.push(r);
      }
      return { rows, skippedInvalid };
    }

    // 1) actor_attendance — dedup by bot_id (must be present)
    if (t.actor_attendance) {
      const { rows, skippedInvalid } = split(t.actor_attendance, (r) => {
        const botId = asInt(r.bot_id, 0); if (!botId) return null;
        const userId = asStr(r.user_id); if (!userId) return null;
        const actedAt = parseTs(r.acted_at); if (!actedAt) return null;
        return {
          botId, userId, username: asStr(r.username),
          missionId: asStr(r.mission_id), missionName: asStr(r.mission_name),
          fixerId: asStr(r.fixer_id), fixerUsername: asStr(r.fixer_username),
          payAmount: asInt(r.pay_amount, 0), actedAt,
        };
      });
      const res = await chunkedInsert(botActorAttendance, rows, (q) => q.onConflictDoNothing({ target: botActorAttendance.botId }), botActorAttendance.id);
      out.actor_attendance = { received: t.actor_attendance.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("actor_attendance");

    // 2) attendance_log — dedup by (user, ts); skip if ts missing
    if (t.attendance_log) {
      const { rows, skippedInvalid } = split(t.attendance_log, (r) => {
        const userId = asStr(r.user_id); const loggedAt = parseTs(r.logged_at);
        if (!userId || !loggedAt) return null;
        return { userId, loggedAt };
      });
      const res = await chunkedInsert(botAttendanceLog, rows, (q) => q.onConflictDoNothing({ target: [botAttendanceLog.userId, botAttendanceLog.loggedAt] }), botAttendanceLog.id);
      out.attendance_log = { received: t.attendance_log.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("attendance_log");

    // 3) balance_history — dedup by bot_id (must be present)
    if (t.balance_history) {
      const { rows, skippedInvalid } = split(t.balance_history, (r) => {
        const botId = asInt(r.bot_id, 0); if (!botId) return null;
        const userId = asStr(r.user_id); if (!userId) return null;
        const ts = parseTs(r.ts); if (!ts) return null;
        return { botId, userId, ts, cashDelta: asInt(r.cash_delta, 0), bankDelta: asInt(r.bank_delta, 0), reason: asStr(r.reason) };
      });
      const res = await chunkedInsert(botBalanceHistory, rows, (q) => q.onConflictDoNothing({ target: botBalanceHistory.botId }), botBalanceHistory.id);
      out.balance_history = { received: t.balance_history.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("balance_history");

    // 4) cyberware_status — PK user_id, upsert (latest wins)
    if (t.cyberware_status) {
      const { rows, skippedInvalid } = split(t.cyberware_status, (r) => {
        const userId = asStr(r.user_id); if (!userId) return null;
        return { userId, weeks: asInt(r.weeks, 0), lastProcessed: parseTs(r.last_processed), updatedAt: parseTs(r.updated_at) };
      });
      const res = await chunkedInsert(botCyberwareStatus, rows, (q) => q.onConflictDoUpdate({
        target: botCyberwareStatus.userId,
        set: { weeks: sql`excluded.weeks`, lastProcessed: sql`excluded.last_processed`, updatedAt: sql`excluded.updated_at` },
      }), botCyberwareStatus.userId);
      out.cyberware_status = { received: t.cyberware_status.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("cyberware_status");

    // 5) cyberware_weekly_runs — dedup by bot_id
    if (t.cyberware_weekly_runs) {
      const { rows, skippedInvalid } = split(t.cyberware_weekly_runs, (r) => {
        const botId = asInt(r.bot_id, 0); if (!botId) return null;
        const runAt = parseTs(r.run_at); if (!runAt) return null;
        return { botId, runAt, checkupIds: asArr(r.checkup_ids), paidIds: asArr(r.paid_ids), unpaidIds: asArr(r.unpaid_ids) };
      });
      const res = await chunkedInsert(botCyberwareWeeklyRuns, rows, (q) => q.onConflictDoNothing({ target: botCyberwareWeeklyRuns.botId }), botCyberwareWeeklyRuns.id);
      out.cyberware_weekly_runs = { received: t.cyberware_weekly_runs.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("cyberware_weekly_runs");

    // 6) last_payment — PK user_id, upsert
    if (t.last_payment) {
      const { rows, skippedInvalid } = split(t.last_payment, (r) => {
        const userId = asStr(r.user_id); if (!userId) return null;
        return { userId, summary: asStr(r.summary), updatedAt: parseTs(r.updated_at) };
      });
      const res = await chunkedInsert(botLastPayment, rows, (q) => q.onConflictDoUpdate({
        target: botLastPayment.userId,
        set: { summary: sql`excluded.summary`, updatedAt: sql`excluded.updated_at` },
      }), botLastPayment.userId);
      out.last_payment = { received: t.last_payment.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("last_payment");

    // 7) payment_labels — composite (user, label, ts); skip if ts missing
    if (t.payment_labels) {
      const { rows, skippedInvalid } = split(t.payment_labels, (r) => {
        const userId = asStr(r.user_id); const label = asStr(r.label); const recordedAt = parseTs(r.recorded_at);
        if (!userId || !label || !recordedAt) return null;
        return { userId, label, recordedAt };
      });
      const res = await chunkedInsert(botPaymentLabels, rows, (q) => q.onConflictDoNothing({ target: [botPaymentLabels.userId, botPaymentLabels.label, botPaymentLabels.recordedAt] }), botPaymentLabels.id);
      out.payment_labels = { received: t.payment_labels.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("payment_labels");

    // 8) rent_runs — dedup by bot_id
    if (t.rent_runs) {
      const { rows, skippedInvalid } = split(t.rent_runs, (r) => {
        const botId = asInt(r.bot_id, 0); if (!botId) return null;
        const runAt = parseTs(r.run_at); if (!runAt) return null;
        return { botId, runAt, initiatedBy: asStr(r.initiated_by) };
      });
      const res = await chunkedInsert(botRentRuns, rows, (q) => q.onConflictDoNothing({ target: botRentRuns.botId }), botRentRuns.id);
      out.rent_runs = { received: t.rent_runs.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("rent_runs");

    // 9) store_inventory — dedup by bot_id
    if (t.store_inventory) {
      const { rows, skippedInvalid } = split(t.store_inventory, (r) => {
        const botId = asInt(r.bot_id, 0); if (!botId) return null;
        const storeId = asStr(r.store_id); if (!storeId) return null;
        return {
          botId, storeId, lotId: asStr(r.lot_id), gunName: asStr(r.gun_name), gunLevel: asStr(r.gun_level),
          unitCost: asInt(r.unit_cost, 0), qty: asInt(r.qty, 0), itemIds: asArr(r.item_ids),
          restriction: asStr(r.restriction), weaponType: asStr(r.weapon_type), gunCategory: asStr(r.gun_category),
          createdAt: parseTs(r.created_at),
        };
      });
      const res = await chunkedInsert(botStoreInventory, rows, (q) => q.onConflictDoNothing({ target: botStoreInventory.botId }), botStoreInventory.id);
      out.store_inventory = { received: t.store_inventory.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("store_inventory");

    // 10) ticket_index — PK message_id, upsert
    if (t.ticket_index) {
      const { rows, skippedInvalid } = split(t.ticket_index, (r) => {
        const messageId = asStr(r.message_id); if (!messageId) return null;
        return { messageId, url: asStr(r.url), ts: parseTs(r.ts), title: asStr(r.title), body: asStr(r.body) };
      });
      const res = await chunkedInsert(botTicketIndex, rows, (q) => q.onConflictDoUpdate({
        target: botTicketIndex.messageId,
        set: { url: sql`excluded.url`, ts: sql`excluded.ts`, title: sql`excluded.title`, body: sql`excluded.body` },
      }), botTicketIndex.messageId);
      out.ticket_index = { received: t.ticket_index.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("ticket_index");

    // 11) mission_log — PK user_id, upsert
    if (t.mission_log) {
      const { rows, skippedInvalid } = split(t.mission_log, (r) => {
        const userId = asStr(r.user_id); if (!userId) return null;
        return {
          userId, username: asStr(r.username), missionCount: asInt(r.mission_count, 0),
          missionDates: asArr(r.mission_dates), missionTitles: asArr(r.mission_titles), updatedAt: parseTs(r.updated_at),
        };
      });
      const res = await chunkedInsert(botMissionLog, rows, (q) => q.onConflictDoUpdate({
        target: botMissionLog.userId,
        set: {
          username: sql`excluded.username`, missionCount: sql`excluded.mission_count`,
          missionDates: sql`excluded.mission_dates`, missionTitles: sql`excluded.mission_titles`,
          updatedAt: sql`excluded.updated_at`,
        },
      }), botMissionLog.userId);
      out.mission_log = { received: t.mission_log.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("mission_log");

    // 12) business_open_log — composite (user, ts); skip if ts missing
    if (t.business_open_log) {
      const { rows, skippedInvalid } = split(t.business_open_log, (r) => {
        const userId = asStr(r.user_id); const openedAt = parseTs(r.opened_at);
        if (!userId || !openedAt) return null;
        return { userId, openedAt };
      });
      const res = await chunkedInsert(botBusinessOpenLog, rows, (q) => q.onConflictDoNothing({ target: [botBusinessOpenLog.userId, botBusinessOpenLog.openedAt] }), botBusinessOpenLog.id);
      out.business_open_log = { received: t.business_open_log.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("business_open_log");

    // 13) player_inventory — PK item_id, upsert
    if (t.player_inventory) {
      const { rows, skippedInvalid } = split(t.player_inventory, (r) => {
        const itemId = asStr(r.item_id); if (!itemId) return null;
        return {
          itemId, ownerId: asStr(r.owner_id), characterId: asStr(r.character_id),
          characterName: asStr(r.character_name), itemType: asStr(r.item_type), name: asStr(r.name),
          restriction: asStr(r.restriction), description: asStr(r.description),
          pricePaid: r.price_paid == null ? null : asInt(r.price_paid, 0),
          sellerId: asStr(r.seller_id), sellerName: asStr(r.seller_name),
          acquiredAt: parseTs(r.acquired_at), createdAt: parseTs(r.created_at),
          powerLevel: asStr(r.power_level), weaponSubtype: asStr(r.weapon_subtype),
          cwp: asStr(r.cwp), slot: asStr(r.slot), weaponType: asStr(r.weapon_type),
        };
      });
      const res = await chunkedInsert(botPlayerInventory, rows, (q) => q.onConflictDoUpdate({
        target: botPlayerInventory.itemId,
        set: {
          ownerId: sql`excluded.owner_id`, characterId: sql`excluded.character_id`,
          characterName: sql`excluded.character_name`, itemType: sql`excluded.item_type`,
          name: sql`excluded.name`, restriction: sql`excluded.restriction`,
          description: sql`excluded.description`, pricePaid: sql`excluded.price_paid`,
          sellerId: sql`excluded.seller_id`, sellerName: sql`excluded.seller_name`,
          acquiredAt: sql`excluded.acquired_at`, powerLevel: sql`excluded.power_level`,
          weaponSubtype: sql`excluded.weapon_subtype`, cwp: sql`excluded.cwp`,
          slot: sql`excluded.slot`, weaponType: sql`excluded.weapon_type`,
        },
      }), botPlayerInventory.itemId);
      out.player_inventory = { received: t.player_inventory.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
    } else skip("player_inventory");

    const totalIn = Object.values(out).reduce((s, x) => s + x.inserted, 0);
    const totalInvalid = Object.values(out).reduce((s, x) => s + x.skippedInvalid, 0);
    const totalChunkFail = Object.values(out).reduce((s, x) => s + x.chunkFailures, 0);
    await recordAudit({
      req,
      category: "admin",
      action: "bot_import",
      message: `Bot DB import: +${totalIn} new rows across ${Object.keys(out).length} tables, ${totalInvalid} invalid, ${totalChunkFail} chunk failures`,
      after: out,
    });
    res.json({ totals: { inserted: totalIn, skippedInvalid: totalInvalid, chunkFailures: totalChunkFail }, tables: out });
  },
);

// ---------------------------------------------------------------------------
// Duplicate-character cleanup. The dev-to-prod and npc-import flows used to
// match only on (kind,name) before the imported_from_thread_id resolver was
// added, so name drift (smart quotes, manual renames) could spawn a second
// row with an empty sheet. These endpoints let an admin REVIEW the duplicate
// groups first, then MANUALLY pick which row to keep — the merge is opt-in
// per pair because guessing wrong throws away inventory/wallet history.
// ---------------------------------------------------------------------------

router.get(
  "/admin/maintenance/duplicate-characters",
  adminOnly,
  async (_req, res): Promise<void> => {
    // Group by (kind, lower(trim(name))). Two characters with the same
    // name+kind are almost always the import artifact described above —
    // a real "two NPCs named John Smith" case is vanishingly rare in
    // this fiction and the admin can just decline to merge.
    const rows = await db
      .select({
        id: characters.id,
        name: characters.name,
        kind: characters.kind,
        ownerId: characters.ownerId,
        ownerName: users.username,
        archetype: characters.archetype,
        portraitUrl: characters.portraitUrl,
        portraitCount: sql<number>`coalesce(array_length(${characters.portraitUrls}, 1), 0)`,
        hasSheetData: sql<boolean>`${characters.sheetData} is not null`,
        importedFromThreadId: characters.importedFromThreadId,
        legacyDiscordUsername: characters.legacyDiscordUsername,
        approved: characters.approved,
        archived: characters.archived,
        lifeStatus: characters.lifeStatus,
        createdAt: characters.createdAt,
      })
      .from(characters)
      .leftJoin(users, eq(users.id, characters.ownerId))
      .orderBy(characters.name, desc(characters.createdAt));

    type Row = (typeof rows)[number];
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      // Normalize aggressively: import flows leave trailing tags like
      // " (NPC)" / "(PC)", smart-quote drift, double spaces, and case
      // mismatches on stop-words ("Alias" vs "alias"). Without this,
      // "Alex Graves (alias: Drew Camden)" and
      // "Alex Graves (Alias: Drew Camden) (NPC)" hash to different
      // keys and the admin never sees the pair.
      const key = `${r.kind}::${normalizeNameForDupes(r.name)}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const dupes = Array.from(groups.entries())
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => ({
        key,
        kind: list[0].kind,
        name: list[0].name,
        count: list.length,
        // Suggest the row with the richest data as the "keeper": prefer
        // ones with sheet_data, then with a portrait, then with an
        // owner, then the oldest row (most likely to have inventory
        // history). This is only a hint — the admin picks manually.
        suggestedKeepId: pickSuggestedKeep(list),
        rows: list,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ groupCount: dupes.length, totalDuplicateRows: dupes.reduce((s, g) => s + g.count, 0), groups: dupes });
  },
);

function normalizeNameForDupes(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'") // smart quotes -> '
    .replace(/\s*\((?:npc|pc)\)\s*$/i, "")      // trailing kind tag
    .replace(/\s+/g, " ")
    .trim();
}

function pickSuggestedKeep<T extends {
  id: number;
  hasSheetData: boolean;
  portraitUrl: string | null;
  ownerId: string | null;
  createdAt: Date | string;
}>(list: T[]): number {
  const score = (r: T) =>
    (r.hasSheetData ? 8 : 0) +
    (r.portraitUrl ? 4 : 0) +
    (r.ownerId ? 2 : 0);
  let best = list[0];
  for (const r of list) {
    const sb = score(best);
    const sr = score(r);
    if (sr > sb) best = r;
    else if (sr === sb && new Date(r.createdAt) < new Date(best.createdAt)) best = r;
  }
  return best.id;
}

// ─── RipperDoc role backfill ──────────────────────────────────────────────
// One-time (re-runnable, idempotent) grant of the "RipperDoc" Discord role to
// every existing ripper doc, combining two signals (deduplicated):
//   • characters whose archetype OR sheet occupation says "ripperdoc" (or the
//     sheet's ripperDoc flag is set), and
//   • anyone who owns or works at a ripperdoc clinic on the portal.
// users.id IS the Discord snowflake, so we grant straight on owner_id. Discord
// writes are gated by externalWritesAllowed() (deployment only), so this is
// meant to be run from the published app. dryRun=true returns the target set
// without touching Discord. On a successful grant we also set the website
// "ripperdoc" role immediately; the hourly role_sync reconciles it both ways
// via the id-pinned applyRoleIdGrants.
router.post(
  "/admin/maintenance/ripperdoc-backfill",
  adminOnly,
  async (req, res): Promise<void> => {
    const dryRun = (req.body as { dryRun?: boolean } | null)?.dryRun === true;
    // `ripper ?-?doc` matches ripperdoc / ripper doc / ripper-doc but NOT the
    // false-positive "stripper" that a bare "ripper" would catch.
    const RX = "ripper ?-?doc";
    const result = await db.execute(sql`
      WITH targets AS (
        SELECT DISTINCT c.owner_id AS user_id, 'sheet'::text AS source
        FROM characters c
        WHERE c.owner_id IS NOT NULL
          AND (lower(coalesce(c.archetype, '')) ~ ${RX}
               OR lower(coalesce(c.sheet_data->>'occupation', '')) ~ ${RX}
               OR c.sheet_data->>'ripperDoc' = 'true')
        UNION
        SELECT DISTINCT r.owner_id, 'clinic_owner'
        FROM ripperdocs r WHERE r.owner_id IS NOT NULL
        UNION
        SELECT DISTINCT c.owner_id, 'clinic_owner'
        FROM ripperdocs r JOIN characters c ON c.id = r.owner_character_id
        WHERE c.owner_id IS NOT NULL
        UNION
        SELECT DISTINCT c.owner_id, 'clinic_employee'
        FROM ripperdoc_employees e JOIN characters c ON c.id = e.character_id
        WHERE c.owner_id IS NOT NULL
      )
      SELECT t.user_id,
             u.username,
             string_agg(DISTINCT t.source, ',' ORDER BY t.source) AS sources
      FROM targets t
      LEFT JOIN users u ON u.id = t.user_id
      GROUP BY t.user_id, u.username
      ORDER BY u.username NULLS LAST
    `);
    const targets = ((result.rows ?? []) as Array<{
      user_id: string;
      username: string | null;
      sources: string;
    }>).map((t) => ({ userId: String(t.user_id), username: t.username, sources: t.sources }));

    // Only ever attempt the grant on real Discord snowflakes (17–20 digits).
    // Anything else is a legacy/non-Discord id we can't grant a role to.
    const isSnowflake = (id: string) => /^\d{17,20}$/.test(id);
    const grantable = targets.filter((t) => isSnowflake(t.userId));
    const skipped = targets.filter((t) => !isSnowflake(t.userId));

    if (dryRun) {
      res.json({
        dryRun: true,
        count: targets.length,
        grantable: grantable.length,
        skipped: skipped.length,
        externalWritesAllowed: externalWritesAllowed(),
        targets,
      });
      return;
    }

    let granted = 0;
    let failed = 0;
    const failures: Array<{ userId: string; username: string | null; error: string }> = [];
    for (const t of grantable) {
      const r = await addGuildMemberRole(t.userId, RIPPERDOC_ROLE_ID, "RipperDoc backfill");
      if (r.ok) {
        granted++;
        // Reflect on the website right away (no waiting for the hourly sync).
        await db.execute(sql`
          UPDATE users
          SET roles = array_append(coalesce(roles, '{}'::text[]), ${RIPPERDOC_ROLE_MARKER})
          WHERE id = ${t.userId}
            AND NOT (${RIPPERDOC_ROLE_MARKER} = ANY(coalesce(roles, '{}'::text[])))
        `);
      } else {
        failed++;
        failures.push({ userId: t.userId, username: t.username, error: r.error });
      }
    }

    await recordAudit({
      req,
      category: "admin",
      action: "ripperdoc_backfill",
      targetType: "role",
      targetId: RIPPERDOC_ROLE_ID,
      message: `RipperDoc backfill — granted ${granted}, failed ${failed}, skipped ${skipped.length} of ${targets.length} targets`,
    });

    res.json({
      count: targets.length,
      granted,
      failed,
      skipped: skipped.length,
      externalWritesAllowed: externalWritesAllowed(),
      failures: failures.slice(0, 50),
    });
  },
);

router.post(
  "/admin/maintenance/merge-character",
  adminOnly,
  expressJson({ limit: "1mb" }),
  async (req, res): Promise<void> => {
    const body = req.body as { keepId?: number; dropId?: number; dryRun?: boolean } | null;
    const keepId = Number(body?.keepId);
    const dropId = Number(body?.dropId);
    if (!Number.isInteger(keepId) || !Number.isInteger(dropId) || keepId === dropId) {
      res.status(400).json({ error: "Body must be { keepId: int, dropId: int } with distinct ids" });
      return;
    }

    const [keep] = await db.select().from(characters).where(eq(characters.id, keepId));
    const [drop] = await db.select().from(characters).where(eq(characters.id, dropId));
    if (!keep || !drop) {
      res.status(404).json({ error: "keepId or dropId not found" });
      return;
    }
    if (keep.kind !== drop.kind) {
      res.status(400).json({ error: `Refusing to merge across kinds (keep=${keep.kind}, drop=${drop.kind})` });
      return;
    }

    // Count what we'd touch so the admin gets a clear before/after picture.
    // Done outside the txn so a dryRun is cheap and doesn't lock rows.
    const counts = await collectChildCounts(dropId);
    if (body?.dryRun) {
      res.json({
        dryRun: true,
        keep: summarizeForMerge(keep),
        drop: summarizeForMerge(drop),
        wouldRepoint: counts,
        wouldFillFields: diffFieldsForFill(keep, drop),
      });
      return;
    }

    // Real merge. Transaction so a mid-flight failure leaves the drop row
    // (and its FK children) intact rather than half-repointed.
    const result = await db.transaction(async (tx) => {
      // 1. Backfill empty/null fields on the keeper from the drop. We only
      //    fill where the keeper is empty — never overwrite live admin data.
      const updateSet: Record<string, unknown> = {};
      if (!keep.archetype && drop.archetype) updateSet.archetype = drop.archetype;
      if (!keep.background && drop.background) updateSet.background = drop.background;
      if (!keep.portraitUrl && drop.portraitUrl) updateSet.portraitUrl = drop.portraitUrl;
      if ((keep.portraitUrls?.length ?? 0) === 0 && (drop.portraitUrls?.length ?? 0) > 0) updateSet.portraitUrls = drop.portraitUrls;
      if ((keep.statsImageUrls?.length ?? 0) === 0 && (drop.statsImageUrls?.length ?? 0) > 0) updateSet.statsImageUrls = drop.statsImageUrls;
      if (!keep.sheetData && drop.sheetData) updateSet.sheetData = drop.sheetData as never;
      if (!keep.importedFromThreadId && drop.importedFromThreadId) updateSet.importedFromThreadId = drop.importedFromThreadId;
      if (!keep.importedFromChannelName && drop.importedFromChannelName) updateSet.importedFromChannelName = drop.importedFromChannelName;
      if ((keep.appliedTags?.length ?? 0) === 0 && (drop.appliedTags?.length ?? 0) > 0) updateSet.appliedTags = drop.appliedTags;
      if (!keep.legacyDiscordUsername && drop.legacyDiscordUsername) updateSet.legacyDiscordUsername = drop.legacyDiscordUsername;
      if (!keep.ownerId && drop.ownerId) updateSet.ownerId = drop.ownerId;
      if (!keep.discordChannelId && drop.discordChannelId) updateSet.discordChannelId = drop.discordChannelId;
      // The thread_id index is unique — if BOTH rows have a value we have
      // to clear drop's first (the delete at the end would also handle it,
      // but UPDATE...RETURNING below would also work; clearing keeps the
      // order obvious).
      if (drop.importedFromThreadId && keep.importedFromThreadId && drop.importedFromThreadId !== keep.importedFromThreadId) {
        await tx.update(characters).set({ importedFromThreadId: null }).where(eq(characters.id, dropId));
      }
      if (Object.keys(updateSet).length > 0) {
        await tx.update(characters).set(updateSet).where(eq(characters.id, keepId));
      }

      // 2. Repoint child rows on tables WITHOUT a unique constraint that
      //    would collide. Straight UPDATEs.
      const repoint: Record<string, number> = {};
      repoint.character_updates = (await tx.update(characterUpdates).set({ characterId: keepId }).where(eq(characterUpdates.characterId, dropId)).returning({ id: characterUpdates.id })).length;
      repoint.inventory_items = (await tx.update(inventoryItems).set({ characterId: keepId }).where(eq(inventoryItems.characterId, dropId)).returning({ id: inventoryItems.id })).length;
      repoint.store_employees = (await tx.update(storeEmployees).set({ characterId: keepId }).where(eq(storeEmployees.characterId, dropId)).returning({ id: storeEmployees.id })).length;
      repoint.ripperdoc_employees = (await tx.update(ripperdocEmployees).set({ characterId: keepId }).where(eq(ripperdocEmployees.characterId, dropId)).returning({ id: ripperdocEmployees.id })).length;
      repoint.housing = (await tx.update(housing).set({ characterId: keepId }).where(eq(housing.characterId, dropId)).returning({ id: housing.id })).length;
      repoint.housing_requests = (await tx.update(housingRequests).set({ characterId: keepId }).where(eq(housingRequests.characterId, dropId)).returning({ id: housingRequests.id })).length;
      repoint.trauma_team_calls = (await tx.update(traumaTeamCalls).set({ characterId: keepId }).where(eq(traumaTeamCalls.characterId, dropId)).returning({ id: traumaTeamCalls.id })).length;
      repoint.mission_log = (await tx.update(missionLog).set({ characterId: keepId }).where(eq(missionLog.characterId, dropId)).returning({ id: missionLog.id })).length;
      repoint.wallet_transactions = (await tx.update(walletTransactions).set({ characterId: keepId }).where(eq(walletTransactions.characterId, dropId)).returning({ id: walletTransactions.id })).length;
      repoint.wallet_counterparty = (await tx.update(walletTransactions).set({ counterpartyCharacterId: keepId }).where(eq(walletTransactions.counterpartyCharacterId, dropId)).returning({ id: walletTransactions.id })).length;
      repoint.inventory_events_from = (await tx.update(inventoryEvents).set({ fromCharacterId: keepId }).where(eq(inventoryEvents.fromCharacterId, dropId)).returning({ id: inventoryEvents.id })).length;
      repoint.inventory_events_to = (await tx.update(inventoryEvents).set({ toCharacterId: keepId }).where(eq(inventoryEvents.toCharacterId, dropId)).returning({ id: inventoryEvents.id })).length;
      repoint.stores_owner = (await tx.update(stores).set({ ownerCharacterId: keepId }).where(eq(stores.ownerCharacterId, dropId)).returning({ id: stores.id })).length;
      repoint.ripperdocs_owner = (await tx.update(ripperdocs).set({ ownerCharacterId: keepId }).where(eq(ripperdocs.ownerCharacterId, dropId)).returning({ id: ripperdocs.id })).length;
      repoint.character_sheets = (await tx.update(characterSheets).set({ characterId: keepId }).where(eq(characterSheets.characterId, dropId)).returning({ id: characterSheets.id })).length;
      repoint.dice_rolls = (await tx.update(diceRolls).set({ characterId: keepId }).where(eq(diceRolls.characterId, dropId)).returning({ id: diceRolls.id })).length;
      // These cascade-delete on character removal with no unique-on-characterId
      // constraint, so a plain repoint preserves them (previously they were
      // silently destroyed when the drop row was deleted below).
      repoint.custom_requests = (await tx.update(customRequests).set({ characterId: keepId }).where(eq(customRequests.characterId, dropId)).returning({ id: customRequests.id })).length;
      repoint.sale_offers = (await tx.update(saleOffers).set({ buyerCharacterId: keepId }).where(eq(saleOffers.buyerCharacterId, dropId)).returning({ id: saleOffers.id })).length;
      // sellerCharacterId is a plain column (no FK, no cascade), so seller-side
      // offers survive the drop's deletion but would dangle on the deleted id.
      // Repoint them too. No unique on sellerCharacterId, so this can't collide.
      repoint.sale_offers_seller = (await tx.update(saleOffers).set({ sellerCharacterId: keepId }).where(eq(saleOffers.sellerCharacterId, dropId)).returning({ id: saleOffers.id })).length;
      // mission_assignments.characterId is ON DELETE SET NULL (row survives but
      // loses its character link); repoint to preserve who was assigned. The
      // UNIQUE is on (missionId, userId) so changing characterId can't collide.
      repoint.mission_assignments = (await tx.update(missionAssignments).set({ characterId: keepId }).where(eq(missionAssignments.characterId, dropId)).returning({ id: missionAssignments.id })).length;
      // mission_applications: UNIQUE (missionId, characterId). Drop the drop's
      // application on missions the keeper already applied to, then repoint the
      // rest so the txn can't 23505 mid-merge.
      await tx.execute(sql`delete from mission_applications d
        where d.character_id = ${dropId}
          and exists (select 1 from mission_applications k where k.character_id = ${keepId} and k.mission_id = d.mission_id)`);
      repoint.mission_applications = (await tx.update(missionApplications).set({ characterId: keepId }).where(eq(missionApplications.characterId, dropId)).returning({ id: missionApplications.id })).length;

      // 3. Tables with a UNIQUE constraint on characterId: handle
      //    collisions explicitly so the txn doesn't 23505 mid-merge.
      // character_status: PK is characterId, so the keeper either has
      // one or doesn't.
      const [keepStatus] = await tx.select().from(characterStatus).where(eq(characterStatus.characterId, keepId));
      if (!keepStatus) {
        await tx.update(characterStatus).set({ characterId: keepId }).where(eq(characterStatus.characterId, dropId));
        repoint.character_status_moved = 1;
      } else {
        await tx.delete(characterStatus).where(eq(characterStatus.characterId, dropId));
        repoint.character_status_dropped = 1;
      }

      // shop_opens: UNIQUE (characterId, openedOn). Delete the drop's
      // opens on days the keeper already opened, then repoint the rest.
      await tx.execute(sql`delete from shop_opens d
        where d.character_id = ${dropId}
          and exists (select 1 from shop_opens k where k.character_id = ${keepId} and k.opened_on = d.opened_on)`);
      repoint.shop_opens = (await tx.update(shopOpens).set({ characterId: keepId }).where(eq(shopOpens.characterId, dropId)).returning({ id: shopOpens.id })).length;

      // pending_character_edits: UNIQUE (characterId WHERE status='pending').
      // If both have a pending edit, drop's pending edit becomes
      // 'superseded' so reviewers don't see two competing diffs.
      await tx.execute(sql`update pending_character_edits set status='superseded'
        where character_id = ${dropId} and status='pending'
          and exists (select 1 from pending_character_edits k where k.character_id = ${keepId} and k.status='pending')`);
      repoint.pending_edits = (await tx.update(pendingCharacterEdits).set({ characterId: keepId }).where(eq(pendingCharacterEdits.characterId, dropId)).returning({ id: pendingCharacterEdits.id })).length;

      // 4. Drop row should now have zero remaining child references. Any
      //    remaining cascade-on-delete children get nuked, which is the
      //    point — if we missed a table the data is gone.
      await tx.delete(characters).where(eq(characters.id, dropId));

      return { keepId, dropId, fieldsFilled: Object.keys(updateSet), repointed: repoint };
    });

    await recordAudit({
      req,
      category: "admin",
      action: "merge_character",
      targetType: "character",
      targetId: String(keepId),
      message: `Merged character #${dropId} (${drop.name}) into #${keepId} (${keep.name})`,
      before: { drop: summarizeForMerge(drop), keep: summarizeForMerge(keep) },
      after: result,
    });
    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// Account merge — fold a DROP user (e.g. a compromised/duplicate Discord
// account) into a KEEP user. KEEP is the surviving login: it keeps its identity,
// roles and tokens. Everything the DROP user owns or is referenced by is
// repointed to KEEP, the DROP user's eddies are transferred ON UnbelievaBoat
// into KEEP, and the DROP `users` row is finally deleted.
//
// Why a dedicated tool: `users.id` IS the Discord snowflake and the login key,
// so a hacked account can't simply be "renamed". 50+ tables reference users.id;
// most repoint cleanly, but a handful carry UNIQUE / PK constraints on the user
// column that would 23505 on a naive UPDATE — those rows are de-duplicated
// (drop's conflicting row deleted) before the repoint. The wallet is special:
// the balance is mirrored to UnbelievaBoat keyed by Discord id and the reconcile
// cron would revert a plain DB copy, so the eddies are moved via applyWalletDelta
// (debit drop's UB account, credit keep's) which updates UB + ledger + balance +
// the reconcile baseline in lockstep, idempotently.
// ---------------------------------------------------------------------------

// [table, column] for user-id references that can be repointed with a plain
// UPDATE — there is no UNIQUE/PK on the column so two rows for the same user
// never collide. DB (snake_case) names; driven through a raw UPDATE so we don't
// have to import ~50 table objects.
const ACCOUNT_PLAIN_USER_COLS: ReadonlyArray<readonly [string, string]> = [
  ["characters", "owner_id"],
  ["character_updates", "author_id"],
  ["inventory_items", "owner_id"],
  ["wallet_transactions", "user_id"],
  ["stores", "owner_id"],
  ["ripperdocs", "owner_id"],
  ["fixer_npcs", "fixer_id"],
  ["character_sheets", "owner_id"],
  ["character_sheets", "overridden_by"],
  ["character_sheets", "closed_by"],
  ["dice_rolls", "user_id"],
  ["catalog_districts", "created_by_id"],
  ["character_tag_options", "created_by_id"],
  ["housing_requests", "requested_by_id"],
  ["housing_requests", "reviewed_by_id"],
  ["custom_requests", "requested_by_id"],
  ["custom_requests", "reviewed_by_id"],
  ["custom_requests", "overridden_by"],
  ["custom_requests", "closed_by"],
  ["sale_offers", "buyer_user_id"],
  ["sale_offers", "created_by_id"],
  ["mission_log", "fixer_id"],
  ["missions", "fixer_id"],
  ["missions", "completed_by"],
  ["mission_applications", "user_id"],
  ["mission_applications", "reviewed_by"],
  ["events", "created_by_id"],
  ["wholesaler_orders", "fixer_id"],
  ["pending_character_edits", "submitted_by"],
  ["pending_character_edits", "overridden_by"],
  ["pending_character_edits", "closed_by"],
  ["review_comments", "author_id"],
  ["lore_entries", "created_by_id"],
  ["lore_entries", "updated_by_id"],
  ["lore_pending_edits", "submitted_by"],
  ["lore_pending_edits", "decided_by_id"],
  ["lore_pending_edits", "overridden_by"],
  ["lore_pending_edits", "closed_by"],
  ["lore_import_drafts", "decided_by_id"],
  ["guidebook_pages", "created_by_id"],
  ["guidebook_pages", "updated_by_id"],
  ["guidebook_pending_edits", "submitted_by"],
  ["guidebook_pending_edits", "decided_by_id"],
  ["breach_puzzles", "created_by"],
  ["breach_puzzles", "assigned_user_id"],
  ["breach_practice_clears", "user_id"],
  ["vrchat_agent_commands", "user_id"],
  ["vrchat_agent_commands", "created_by_id"],
];

function summarizeUserForMerge(u: typeof users.$inferSelect): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    globalName: u.globalName,
    roles: u.roles,
    walletBalance: u.walletBalance,
    lastSyncedUbBalance: u.lastSyncedUbBalance,
    defaultAvailability: u.defaultAvailability != null,
    availabilityTimezone: u.availabilityTimezone,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
  };
}

// A curated set of ownership/meaningful child counts for the dry-run preview.
// The actual merge repoints EVERY user-id column, not only these.
async function collectAccountChildCounts(userId: string): Promise<Record<string, number>> {
  const c = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  return {
    characters: await c(db.select({ n: count() }).from(characters).where(eq(characters.ownerId, userId))),
    stores: await c(db.select({ n: count() }).from(stores).where(eq(stores.ownerId, userId))),
    ripperdocs: await c(db.select({ n: count() }).from(ripperdocs).where(eq(ripperdocs.ownerId, userId))),
    character_sheets: await c(db.select({ n: count() }).from(characterSheets).where(eq(characterSheets.ownerId, userId))),
    inventory_items: await c(db.select({ n: count() }).from(inventoryItems).where(eq(inventoryItems.ownerId, userId))),
    wallet_transactions: await c(db.select({ n: count() }).from(walletTransactions).where(eq(walletTransactions.userId, userId))),
    custom_requests: await c(db.select({ n: count() }).from(customRequests).where(eq(customRequests.requestedById, userId))),
    housing_requests: await c(db.select({ n: count() }).from(housingRequests).where(eq(housingRequests.requestedById, userId))),
    mission_assignments: await c(db.select({ n: count() }).from(missionAssignments).where(eq(missionAssignments.userId, userId))),
    mission_applications: await c(db.select({ n: count() }).from(missionApplications).where(eq(missionApplications.userId, userId))),
    sale_offers_as_buyer: await c(db.select({ n: count() }).from(saleOffers).where(eq(saleOffers.buyerUserId, userId))),
  };
}

router.post(
  "/admin/maintenance/merge-account",
  adminOnly,
  expressJson({ limit: "256kb" }),
  async (req, res) => {
    const body = req.body as { keepId?: unknown; dropId?: unknown; dryRun?: unknown } | null;
    const keepId = typeof body?.keepId === "string" ? body.keepId.trim() : "";
    const dropId = typeof body?.dropId === "string" ? body.dropId.trim() : "";
    const dryRun = body?.dryRun === true;

    if (!keepId || !dropId) {
      res.status(400).json({ error: "Both keepId and dropId are required." });
      return;
    }
    if (keepId === dropId) {
      res.status(400).json({ error: "keepId and dropId must be different." });
      return;
    }

    const [keep] = await db.select().from(users).where(eq(users.id, keepId));
    const [drop] = await db.select().from(users).where(eq(users.id, dropId));
    if (!keep) {
      res.status(404).json({ error: `Keep user ${keepId} not found.` });
      return;
    }
    if (!drop) {
      res.status(404).json({ error: `Drop user ${dropId} not found.` });
      return;
    }

    const transferAmount = drop.walletBalance ?? 0;
    const fieldsToFill: string[] = [];
    if (keep.defaultAvailability == null && drop.defaultAvailability != null) fieldsToFill.push("defaultAvailability");
    if (!keep.availabilityTimezone && drop.availabilityTimezone) fieldsToFill.push("availabilityTimezone");

    if (dryRun) {
      // Surface live UB balances too so the operator can confirm the website
      // mirror (transferAmount) matches the real eddies before committing.
      const [keepUb, dropUb] = await Promise.all([
        getBalance(keep.id, { allowStale: true }),
        getBalance(drop.id, { allowStale: true }),
      ]);
      res.json({
        dryRun: true,
        keep: summarizeUserForMerge(keep),
        drop: summarizeUserForMerge(drop),
        wouldTransferEddies: transferAmount,
        economyMode: await getEconomyMode(),
        liveUbBalance: { keep: keepUb?.total ?? null, drop: dropUb?.total ?? null },
        wouldFillFields: fieldsToFill,
        wouldRepoint: await collectAccountChildCounts(dropId),
      });
      return;
    }

    // --- Phase A: repoint every user-id reference drop -> keep ----------------
    // Done in one transaction. Collision tables (unique/PK on the user column)
    // delete drop's conflicting rows first, then repoint the rest. Historical
    // wallet_transactions are repointed here, BEFORE the balance transfer, so the
    // transfer's own debit row (created next, on drop) stays with drop and is
    // cascade-deleted with it — keeping keep's wallet history clean.
    const repointed: Record<string, number> = {};
    await db.transaction(async (tx) => {
      const repoint = async (table: string, col: string): Promise<number> => {
        const r = await tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(col)} = ${keepId} where ${sql.identifier(col)} = ${dropId}`,
        );
        return r.rowCount ?? 0;
      };

      for (const [table, col] of ACCOUNT_PLAIN_USER_COLS) {
        const n = await repoint(table, col);
        if (n > 0) repointed[`${table}.${col}`] = n;
      }

      // Collision tables: delete drop's rows that would violate a UNIQUE/PK with
      // an existing keep row, then repoint the survivors. Equality (not NOT
      // DISTINCT FROM) on nullable sibling cols matches unique-index NULL
      // semantics (NULLs are distinct, so they never collide).
      await tx.execute(sql`delete from income_command_uses d where d.user_id = ${dropId} and exists (select 1 from income_command_uses k where k.user_id = ${keepId} and k.command = d.command)`);
      repointed["income_command_uses.user_id"] = (await tx.execute(sql`update income_command_uses set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from mission_assignments d where d.user_id = ${dropId} and exists (select 1 from mission_assignments k where k.user_id = ${keepId} and k.mission_id = d.mission_id)`);
      repointed["mission_assignments.user_id"] = (await tx.execute(sql`update mission_assignments set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from mission_actor_payments d where d.user_id = ${dropId} and d.payment_status = 'paid' and exists (select 1 from mission_actor_payments k where k.user_id = ${keepId} and k.payment_status = 'paid' and k.mission_id = d.mission_id)`);
      await tx.execute(sql`delete from mission_actor_payments d where d.user_id = ${dropId} and d.payment_status = 'paid' and d.event_id is not null and exists (select 1 from mission_actor_payments k where k.user_id = ${keepId} and k.payment_status = 'paid' and k.event_id = d.event_id)`);
      repointed["mission_actor_payments.user_id"] = (await tx.execute(sql`update mission_actor_payments set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from mission_npc_signups d where d.user_id = ${dropId} and d.state = 'signed_up' and exists (select 1 from mission_npc_signups k where k.user_id = ${keepId} and k.state = 'signed_up' and k.mission_id = d.mission_id)`);
      repointed["mission_npc_signups.user_id"] = (await tx.execute(sql`update mission_npc_signups set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from event_npc_signups d where d.user_id = ${dropId} and d.state = 'signed_up' and exists (select 1 from event_npc_signups k where k.user_id = ${keepId} and k.state = 'signed_up' and k.event_id = d.event_id)`);
      repointed["event_npc_signups.user_id"] = (await tx.execute(sql`update event_npc_signups set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from pending_edit_approvals d where d.voter_id = ${dropId} and exists (select 1 from pending_edit_approvals k where k.voter_id = ${keepId} and k.edit_id = d.edit_id)`);
      repointed["pending_edit_approvals.voter_id"] = (await tx.execute(sql`update pending_edit_approvals set voter_id = ${keepId} where voter_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from review_votes d where d.voter_id = ${dropId} and exists (select 1 from review_votes k where k.voter_id = ${keepId} and k.subject_type = d.subject_type and k.subject_id = d.subject_id)`);
      repointed["review_votes.voter_id"] = (await tx.execute(sql`update review_votes set voter_id = ${keepId} where voter_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from review_seen d where d.user_id = ${dropId} and exists (select 1 from review_seen k where k.user_id = ${keepId} and k.subject_type = d.subject_type and k.subject_id = d.subject_id)`);
      repointed["review_seen.user_id"] = (await tx.execute(sql`update review_seen set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from attendance_claims d where d.user_id = ${dropId} and exists (select 1 from attendance_claims k where k.user_id = ${keepId} and k.week_start = d.week_start)`);
      repointed["attendance_claims.user_id"] = (await tx.execute(sql`update attendance_claims set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from breach_practice_stats d where d.user_id = ${dropId} and exists (select 1 from breach_practice_stats k where k.user_id = ${keepId} and k.difficulty = d.difficulty)`);
      repointed["breach_practice_stats.user_id"] = (await tx.execute(sql`update breach_practice_stats set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      await tx.execute(sql`delete from vrchat_agents d where d.user_id = ${dropId} and exists (select 1 from vrchat_agents k where k.user_id = ${keepId})`);
      repointed["vrchat_agents.user_id"] = (await tx.execute(sql`update vrchat_agents set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

      // Drop zero-count entries so the response only lists what actually moved.
      for (const key of Object.keys(repointed)) if (repointed[key] === 0) delete repointed[key];

      // Backfill only portable, non-identity fields onto keep where it's empty.
      const fill: Partial<typeof users.$inferInsert> = {};
      if (keep.defaultAvailability == null && drop.defaultAvailability != null) fill.defaultAvailability = drop.defaultAvailability;
      if (!keep.availabilityTimezone && drop.availabilityTimezone) fill.availabilityTimezone = drop.availabilityTimezone;
      if (Object.keys(fill).length > 0) {
        await tx.update(users).set(fill).where(eq(users.id, keepId));
      }
    });

    // --- Phase B: transfer eddies on UnbelievaBoat (idempotent) --------------
    // applyWalletDelta makes the external UB call + writes the ledger/balance +
    // advances the reconcile baseline, so it can't be inside the DB transaction.
    // Stable idempotency keys make the whole merge safe to re-run after a partial
    // failure. We MUST NOT delete the drop row unless the money actually moved.
    //
    // CRITICAL for reruns: do NOT gate on the *current* drop balance. If a prior
    // run debited drop (balance now 0) but the credit failed, recomputing the
    // amount from drop.walletBalance would skip Phase B and delete drop with the
    // eddies stranded. Instead, if a debit ledger row already exists for this
    // merge, trust ITS amount as the authoritative plan so the credit always
    // gets retried (applyWalletDelta de-dupes the debit leg by key).
    const debitKey = `account-merge:${dropId}->${keepId}:out`;
    const creditKey = `account-merge:${dropId}->${keepId}:in`;
    const [priorDebit] = await db
      .select({ amount: walletTransactions.amount })
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, debitKey));
    const plannedAmount = priorDebit ? Math.abs(priorDebit.amount) : transferAmount;

    let walletTransfer: Record<string, unknown> = { amount: 0, skipped: true };
    if (plannedAmount > 0) {
      const debit = await applyWalletDelta({
        userId: dropId,
        discordId: drop.id,
        amount: -plannedAmount,
        source: "admin",
        kind: "account_merge_out",
        reason: `Account merge: transfer to ${keepId}`,
        memo: `Account merge: eddies moved to user ${keepId}`,
        idempotencyKey: debitKey,
      });
      if (!debit.ok || (debit.status !== "synced" && debit.status !== "duplicate")) {
        res.status(409).json({
          error: `Eddies debit from the drop account did not complete (status=${debit.status}). Nothing was deleted. The economy must be LIVE (enabled) for the transfer to run; child rows were already repointed and re-running the merge will retry safely.`,
          repointed,
          walletTransfer: { debit },
        });
        return;
      }
      const credit = await applyWalletDelta({
        userId: keepId,
        discordId: keep.id,
        amount: plannedAmount,
        source: "admin",
        kind: "account_merge_in",
        reason: `Account merge: transfer from ${dropId}`,
        memo: `Account merge: eddies received from user ${dropId}`,
        idempotencyKey: creditKey,
      });
      if (!credit.ok || (credit.status !== "synced" && credit.status !== "duplicate")) {
        res.status(409).json({
          error: `Eddies were debited from the drop account but the credit to the keep account did not complete (status=${credit.status}). Nothing was deleted — re-run the merge to retry; the debit will not repeat.`,
          repointed,
          walletTransfer: { debit, credit },
        });
        return;
      }
      walletTransfer = { amount: plannedAmount, debit: debit.status, credit: credit.status };
    }

    // --- Phase C: delete the drop user row -----------------------------------
    // All non-cascade references were repointed in Phase A; the only remaining
    // child rows are cascade FKs (e.g. the Phase-B debit ledger row) which the
    // delete cleans up. This is the point of no return.
    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, dropId));
    });

    const result = {
      keepId,
      dropId,
      fieldsFilled: fieldsToFill,
      repointed,
      walletTransfer,
    };

    await recordAudit({
      req,
      category: "admin",
      action: "merge_account",
      targetType: "user",
      targetId: keepId,
      message: `Merged account ${dropId} (${drop.username ?? "?"}) into ${keepId} (${keep.username ?? "?"}); transferred €${plannedAmount.toLocaleString()}`,
      before: { drop: summarizeUserForMerge(drop), keep: summarizeUserForMerge(keep) },
      after: result,
    });

    res.json(result);
  },
);

function summarizeForMerge(c: typeof characters.$inferSelect): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    ownerId: c.ownerId,
    archetype: c.archetype,
    portraitUrl: c.portraitUrl,
    portraitCount: c.portraitUrls?.length ?? 0,
    hasSheetData: c.sheetData != null,
    importedFromThreadId: c.importedFromThreadId,
    legacyDiscordUsername: c.legacyDiscordUsername,
    approved: c.approved,
    archived: c.archived,
    lifeStatus: c.lifeStatus,
    createdAt: c.createdAt,
  };
}

function diffFieldsForFill(keep: typeof characters.$inferSelect, drop: typeof characters.$inferSelect): string[] {
  const fields: string[] = [];
  if (!keep.archetype && drop.archetype) fields.push("archetype");
  if (!keep.background && drop.background) fields.push("background");
  if (!keep.portraitUrl && drop.portraitUrl) fields.push("portraitUrl");
  if ((keep.portraitUrls?.length ?? 0) === 0 && (drop.portraitUrls?.length ?? 0) > 0) fields.push("portraitUrls");
  if ((keep.statsImageUrls?.length ?? 0) === 0 && (drop.statsImageUrls?.length ?? 0) > 0) fields.push("statsImageUrls");
  if (!keep.sheetData && drop.sheetData) fields.push("sheetData");
  if (!keep.importedFromThreadId && drop.importedFromThreadId) fields.push("importedFromThreadId");
  if (!keep.importedFromChannelName && drop.importedFromChannelName) fields.push("importedFromChannelName");
  if ((keep.appliedTags?.length ?? 0) === 0 && (drop.appliedTags?.length ?? 0) > 0) fields.push("appliedTags");
  if (!keep.legacyDiscordUsername && drop.legacyDiscordUsername) fields.push("legacyDiscordUsername");
  if (!keep.ownerId && drop.ownerId) fields.push("ownerId");
  if (!keep.discordChannelId && drop.discordChannelId) fields.push("discordChannelId");
  return fields;
}

async function collectChildCounts(charId: number): Promise<Record<string, number>> {
  const c = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  return {
    character_updates: await c(db.select({ n: count() }).from(characterUpdates).where(eq(characterUpdates.characterId, charId))),
    inventory_items: await c(db.select({ n: count() }).from(inventoryItems).where(eq(inventoryItems.characterId, charId))),
    store_employees: await c(db.select({ n: count() }).from(storeEmployees).where(eq(storeEmployees.characterId, charId))),
    ripperdoc_employees: await c(db.select({ n: count() }).from(ripperdocEmployees).where(eq(ripperdocEmployees.characterId, charId))),
    housing: await c(db.select({ n: count() }).from(housing).where(eq(housing.characterId, charId))),
    housing_requests: await c(db.select({ n: count() }).from(housingRequests).where(eq(housingRequests.characterId, charId))),
    trauma_team_calls: await c(db.select({ n: count() }).from(traumaTeamCalls).where(eq(traumaTeamCalls.characterId, charId))),
    mission_log: await c(db.select({ n: count() }).from(missionLog).where(eq(missionLog.characterId, charId))),
    wallet_transactions: await c(db.select({ n: count() }).from(walletTransactions).where(eq(walletTransactions.characterId, charId))),
    character_sheets: await c(db.select({ n: count() }).from(characterSheets).where(eq(characterSheets.characterId, charId))),
    shop_opens: await c(db.select({ n: count() }).from(shopOpens).where(eq(shopOpens.characterId, charId))),
    pending_edits: await c(db.select({ n: count() }).from(pendingCharacterEdits).where(eq(pendingCharacterEdits.characterId, charId))),
    custom_requests: await c(db.select({ n: count() }).from(customRequests).where(eq(customRequests.characterId, charId))),
    sale_offers: await c(db.select({ n: count() }).from(saleOffers).where(eq(saleOffers.buyerCharacterId, charId))),
    mission_assignments: await c(db.select({ n: count() }).from(missionAssignments).where(eq(missionAssignments.characterId, charId))),
    mission_applications: await c(db.select({ n: count() }).from(missionApplications).where(eq(missionApplications.characterId, charId))),
  };
}

// ---------------------------------------------------------------------------
// Claim-by-username. Unclaimed characters carry `legacyDiscordUsername`
// (the Discord handle the sheet was authored under). When that user later
// logs into the portal we get a `users` row with the same username — this
// endpoint links them. Case-insensitive name match, never overwrites an
// existing ownerId, never matches when the dev row owner is ambiguous
// (>1 users share the legacy username).
// ---------------------------------------------------------------------------

router.get(
  "/admin/maintenance/claim-by-username",
  adminOnly,
  async (_req, res): Promise<void> => {
    const matches = await previewClaimByUsername();
    res.json({
      candidateCount: matches.length,
      ambiguousCount: matches.filter((m) => m.matchedUserIds.length > 1).length,
      matches,
    });
  },
);

router.post(
  "/admin/maintenance/claim-by-username",
  adminOnly,
  expressJson({ limit: "100kb" }),
  async (req, res): Promise<void> => {
    const body = req.body as { dryRun?: boolean } | null;
    const matches = await previewClaimByUsername();
    if (body?.dryRun) {
      res.json({ dryRun: true, candidateCount: matches.length, matches });
      return;
    }
    const applied: Array<{ characterId: number; characterName: string; ownerId: string; matchedUsername: string }> = [];
    const skipped: Array<{ characterId: number; characterName: string; reason: string }> = [];
    for (const m of matches) {
      if (m.matchedUserIds.length !== 1) {
        skipped.push({ characterId: m.characterId, characterName: m.characterName, reason: m.matchedUserIds.length === 0 ? "no_match" : `ambiguous (${m.matchedUserIds.length} users)` });
        continue;
      }
      const ownerId = m.matchedUserIds[0];
      try {
        // Guard on still-unclaimed and check rows affected: if the character was
        // claimed concurrently (or manually) the UPDATE matches 0 rows, so don't
        // falsely report it as linked.
        const updated = await db
          .update(characters)
          .set({ ownerId, claimed: true })
          .where(and(eq(characters.id, m.characterId), isNull(characters.ownerId)))
          .returning({ id: characters.id });
        if (updated.length === 0) {
          skipped.push({ characterId: m.characterId, characterName: m.characterName, reason: "already_claimed" });
        } else {
          applied.push({ characterId: m.characterId, characterName: m.characterName, ownerId, matchedUsername: m.legacyDiscordUsername });
        }
      } catch (err) {
        skipped.push({ characterId: m.characterId, characterName: m.characterName, reason: (err as Error).message });
      }
    }

    await recordAudit({
      req,
      category: "admin",
      action: "claim_by_username",
      message: `Claim-by-username: linked ${applied.length}, skipped ${skipped.length}`,
      after: { applied: applied.length, skipped: skipped.length },
    });
    res.json({ applied, skipped });
  },
);

async function previewClaimByUsername(): Promise<Array<{
  characterId: number;
  characterName: string;
  kind: string;
  legacyDiscordUsername: string;
  matchedUserIds: string[];
  matchedUsernames: string[];
}>> {
  const unclaimed = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      legacyDiscordUsername: characters.legacyDiscordUsername,
    })
    .from(characters)
    .where(and(
      isNull(characters.ownerId),
      sql`${characters.legacyDiscordUsername} is not null`,
      sql`length(trim(${characters.legacyDiscordUsername})) > 0`,
    ));

  if (unclaimed.length === 0) return [];

  // One pass over `users` keyed by lower-cased username for an in-memory
  // join — the user table is small (every logged-in member, hundreds at
  // most) and the row count squared is dwarfed by network roundtrips if
  // we did it per-character.
  const allUsers = await db.select({ id: users.id, username: users.username, globalName: users.globalName }).from(users);
  const byUsername = new Map<string, Array<{ id: string; username: string }>>();
  for (const u of allUsers) {
    for (const handle of [u.username, u.globalName].filter((x): x is string => !!x)) {
      const key = handle.trim().toLowerCase();
      if (!key) continue;
      const list = byUsername.get(key) ?? [];
      list.push({ id: u.id, username: u.username });
      byUsername.set(key, list);
    }
  }

  return unclaimed.map((c) => {
    const key = (c.legacyDiscordUsername ?? "").trim().toLowerCase();
    const hits = byUsername.get(key) ?? [];
    // Dedupe — a single user matched on both username AND globalName
    // shouldn't be counted twice.
    const uniq = new Map<string, string>();
    for (const h of hits) uniq.set(h.id, h.username);
    return {
      characterId: c.id,
      characterName: c.name,
      kind: c.kind,
      legacyDiscordUsername: c.legacyDiscordUsername ?? "",
      matchedUserIds: Array.from(uniq.keys()),
      matchedUsernames: Array.from(uniq.values()),
    };
  });
}

// ---------------------------------------------------------------------------
// Portrait backfill from Discord. Many NPCs (and a long tail of PCs) were
// imported with an `imported_from_thread_id` but no portrait, because the
// original importer only scraped sheet *text* and skipped attachments.
// The OP message of a #character-sheets forum post is almost always the
// portrait image the player posted, so we can recover them after the fact:
//   PREVIEW  → list characters missing a portrait whose thread we can hit,
//              with the attachment filenames Discord still has for them.
//   APPLY    → for each selected character, download the first image
//              attachment, re-host it on object storage, and save it as
//              the primary portrait (also appended to portrait_urls so the
//              gallery picks it up).
// We rehost rather than store cdn.discordapp.com URLs because those URLs
// are signed and expire after ~24h — saving them directly would surface
// broken images within a day.
// ---------------------------------------------------------------------------

interface BackfillCandidate {
  characterId: number;
  characterName: string;
  kind: string;
  threadId: string;
  attachmentCount: number;
  firstAttachment: { filename: string; contentType: string | null; width: number | null; height: number | null } | null;
  reason: string | null; // populated when fetch fails (404, no perms, etc.)
}

async function listPortraitBackfillCandidates(): Promise<BackfillCandidate[]> {
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      threadId: characters.importedFromThreadId,
    })
    .from(characters)
    .where(
      and(
        eq(characters.archived, false),
        isNull(characters.portraitUrl),
        sql`coalesce(array_length(${characters.portraitUrls}, 1), 0) = 0`,
        sql`${characters.importedFromThreadId} is not null`,
      ),
    )
    .orderBy(characters.kind, characters.name);

  // Sequential fetch — Discord rate-limits aggressively (per-route bucket
  // ~5 req/s) and a typical run is dozens, not thousands. Going parallel
  // would just trip the limiter and slow the whole thing down.
  const out: BackfillCandidate[] = [];
  for (const r of rows) {
    if (!r.threadId) continue;
    let attachments: ThreadAttachment[] = [];
    let reason: string | null = null;
    try {
      const msg = await fetchThreadOpMessage(r.threadId);
      if (!msg) {
        reason = "thread inaccessible (deleted, archived w/o perms, or bot kicked)";
      } else {
        attachments = imageAttachmentsOf(msg);
        if (attachments.length === 0) reason = "OP has no image attachments";
      }
    } catch (err) {
      reason = `fetch error: ${(err as Error).message}`;
    }
    out.push({
      characterId: r.id,
      characterName: r.name,
      kind: r.kind,
      threadId: r.threadId,
      attachmentCount: attachments.length,
      firstAttachment: attachments[0]
        ? {
          filename: attachments[0].filename,
          contentType: attachments[0].contentType,
          width: attachments[0].width,
          height: attachments[0].height,
        }
        : null,
      reason,
    });
  }
  return out;
}

router.get(
  "/admin/maintenance/portrait-backfill",
  adminOnly,
  async (_req, res): Promise<void> => {
    const candidates = await listPortraitBackfillCandidates();
    res.json({
      total: candidates.length,
      withAttachment: candidates.filter((c) => c.attachmentCount > 0).length,
      candidates,
    });
  },
);

router.post(
  "/admin/maintenance/portrait-backfill",
  adminOnly,
  async (req, res): Promise<void> => {
    // Body shape: { characterIds?: number[] }. Empty/omitted = apply to every
    // candidate the preview turned up that has at least one attachment.
    const requested = Array.isArray(req.body?.characterIds)
      ? (req.body.characterIds as unknown[]).map(Number).filter((n): n is number => Number.isInteger(n))
      : null;

    const candidates = await listPortraitBackfillCandidates();
    const targets = candidates.filter(
      (c) => c.attachmentCount > 0 && (requested === null || requested.includes(c.characterId)),
    );

    const storage = new ObjectStorageService();
    const applied: Array<{ characterId: number; characterName: string; portraitUrl: string; sourceFilename: string }> = [];
    const skipped: Array<{ characterId: number; characterName: string; reason: string }> = [];

    for (const cand of targets) {
      try {
        const msg = await fetchThreadOpMessage(cand.threadId);
        const first = imageAttachmentsOf(msg)[0];
        if (!first) {
          skipped.push({ characterId: cand.characterId, characterName: cand.characterName, reason: "attachment disappeared between preview and apply" });
          continue;
        }
        // Download from Discord CDN.
        const dl = await fetch(first.url, { signal: AbortSignal.timeout(30_000) });
        if (!dl.ok) {
          skipped.push({ characterId: cand.characterId, characterName: cand.characterName, reason: `cdn download failed: HTTP ${dl.status}` });
          continue;
        }
        const ab = await dl.arrayBuffer();
        const buf = Buffer.from(ab);
        const contentType = first.contentType
          ?? dl.headers.get("content-type")
          ?? "application/octet-stream";
        const path = await storage.uploadBuffer(buf, contentType);

        // Guard against a race: another writer may have set a portrait
        // between preview and apply — don't clobber it.
        const updated = await db
          .update(characters)
          .set({
            portraitUrl: path,
            portraitUrls: sql`array_append(${characters.portraitUrls}, ${path})`,
          })
          .where(
            and(
              eq(characters.id, cand.characterId),
              isNull(characters.portraitUrl),
            ),
          )
          .returning({ id: characters.id });
        if (updated.length === 0) {
          skipped.push({ characterId: cand.characterId, characterName: cand.characterName, reason: "character already has a portrait; left untouched" });
          continue;
        }
        applied.push({
          characterId: cand.characterId,
          characterName: cand.characterName,
          portraitUrl: path,
          sourceFilename: first.filename,
        });
      } catch (err) {
        skipped.push({
          characterId: cand.characterId,
          characterName: cand.characterName,
          reason: `error: ${(err as Error).message}`,
        });
      }
    }

    await recordAudit({
      req,
      category: "character",
      action: "portrait.backfill",
      targetType: "system",
      targetId: "characters",
      after: { applied: applied.length, skipped: skipped.length },
    });

    res.json({ requested: targets.length, applied, skipped });
  },
);

export default router;
