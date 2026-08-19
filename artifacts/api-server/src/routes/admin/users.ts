import type { IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, users, characters } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  fetchGuildMemberRolesViaBot,
  fetchGuildMemberRoleIdsViaBot,
  fetchDiscordUser,
  searchGuildMembers,
  searchGuildChannels,
  hasRole,
  listGuildMembersWithRole,
  applyRoleIdGrants,
  NPC_ROLE_ID,
  VERIFIED_18_ROLE_ID,
} from "../../lib/discord";
import { recordAudit } from "../../lib/audit";
import { adminOnly, adminOrFixer } from "./shared";

export function registerUsers(router: IRouter): void {
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
}
