import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { db, users, characters, vrchatLinks, storeEmployees, ripperdocEmployees } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  buildAuthUrl,
  exchangeCode,
  fetchUser,
  fetchGuildMemberRoles,
  fetchGuildMemberRolesDetailed,
  fetchGuildMemberRoleIdsViaBot,
  VERIFIED_18_ROLE_ID,
  applyRoleIdGrants,
  addGuildMemberRole,
  removeGuildMemberRole,
  NPC_ROLE_ID,
  RULES_ROLE_ID,
  NOTIFICATION_ROLES,
  type NotificationRoleKey,
  avatarUrl,
  hasRole,
  DiscordConfigError,
  DiscordUpstreamError,
} from "../lib/discord";
import { requireAuth } from "../middlewares/auth";
import { isLoginRestricted, isLockdownExempt } from "../lib/siteAccess";
import { recordAudit } from "../lib/audit";
import { recordLogin } from "../lib/siteActivity";

const router: IRouter = Router();

router.get("/auth/discord/login", (req, res): void => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(buildAuthUrl(state, req.hostname));
});

function loginErrorRedirect(reason: string, detail?: string): string {
  const params = new URLSearchParams({ reason });
  if (detail) params.set("detail", detail);
  return `/login/error?${params.toString()}`;
}

router.get("/auth/discord/callback", async (req, res): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code || !state || state !== req.session.oauthState) {
    res.redirect(loginErrorRedirect("state"));
    return;
  }
  req.session.oauthState = undefined;
  try {
    const token = await exchangeCode(code, req.hostname);
    const discordUser = await fetchUser(token.access_token);
    const { names: rawRoles, ids: roleIds } = await fetchGuildMemberRolesDetailed(
      token.access_token,
      discordUser.id,
    );
    const id = discordUser.id;
    const [existing] = await db.select().from(users).where(eq(users.id, id));
    // The user-token guild-member fetch returns an EMPTY result on a transient
    // Discord error (rate-limit / network / scope hiccup), which is
    // indistinguishable from "this member genuinely has no roles". Adopting that
    // empty result unconditionally would wipe a known member's roles — e.g.
    // strip FIXER so they log in and aren't recognized as a fixer — until the
    // next hourly sync. So only adopt the freshly-fetched roles when the read
    // actually returned something; otherwise keep the roles we already have. The
    // role_sync cron does a DEFINITE bulk read and reconciles genuine role
    // losses / guild departures. Mirrors the cron's conservative per-user
    // fallback. See memory: role-derived-flag-sync.
    const sawDiscordRoles = rawRoles.length > 0 || roleIds.length > 0;
    // Map id-gated grants (e.g. Trial Fixer → "trial-fixer") onto the stored
    // names so every downstream hasRole(..., "FIXER") check honors them.
    const roles = sawDiscordRoles
      ? applyRoleIdGrants(rawRoles, roleIds)
      : existing?.roles ?? [];
    const verified18 = sawDiscordRoles
      ? roleIds.includes(VERIFIED_18_ROLE_ID)
      : existing?.verified18 ?? false;
    // Staff-only lockdown: when an admin has restricted login, only ADMIN /
    // FIXER (incl. coordinator) / ARCHIVIST may sign in. Everyone else is turned
    // away here — BEFORE any session is created — so a restricted player never
    // even gets a cookie. The middleware (requireSiteAccess) mirrors this for
    // members who were already logged in when the switch was flipped.
    if (!isLockdownExempt(roles) && (await isLoginRestricted())) {
      res.redirect(loginErrorRedirect("restricted"));
      return;
    }
    const expiresAt = new Date(Date.now() + token.expires_in * 1000);
    const av = avatarUrl(discordUser.id, discordUser.avatar);
    if (existing) {
      await db
        .update(users)
        .set({
          username: discordUser.username,
          globalName: discordUser.global_name ?? null,
          avatarUrl: av,
          roles,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          tokenExpiresAt: expiresAt,
          rolesSyncedAt: new Date(),
          verified18,
          lastSeenAt: new Date(),
          loginCount: sql`${users.loginCount} + 1`,
        })
        .where(eq(users.id, id));
    } else {
      await db.insert(users).values({
        id,
        discordId: id,
        username: discordUser.username,
        globalName: discordUser.global_name ?? null,
        avatarUrl: av,
        roles,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiresAt: expiresAt,
        rolesSyncedAt: new Date(),
        verified18,
        loginCount: 1,
      });
    }
    void recordLogin(id);
    // Back-fill ownership for any imported characters whose legacy Discord
    // *username* (the globally-unique handle, not the mutable display
    // name) matches this user. We deliberately do NOT match on
    // global_name because global_name is user-editable and non-unique —
    // matching on it would let anyone set a colliding display name and
    // steal orphaned characters.
    //
    // The legacy handles predate Discord's 2023 username migration, so they
    // drift from the current handle by punctuation only (e.g. "ghosted_stoner"
    // -> "ghosted_stoner.", "Vinnybot<3" -> "vinnybot", "_sliss"/"Sliss_" ->
    // "sliss"). We therefore match on a normalized key: lowercase, strip
    // "<3"-style emoticons, then strip all non-alphanumerics — on BOTH sides.
    // Only touch rows that are still NULL — never clobber an admin-assigned
    // ownerId. See memory: importer-upsert-idempotency, nullable-owner-guards,
    // auto-claim-legacy-username.
    try {
      const handleKey = (discordUser.username ?? "")
        .toLowerCase()
        .replace(/<+3+/g, "")
        .replace(/[^a-z0-9]/g, "");
      // Guard against trivial keys collapsing onto the wrong owner.
      if (handleKey.length >= 3) {
        // Uniqueness gate: refuse to auto-claim when more than one user
        // collapses to this normalized key. Otherwise a normalized-handle
        // collision (e.g. "john.doe" vs "johndoe") would let whoever logs in
        // first steal another account's orphaned characters. The logging-in
        // user was already upserted above, so a unique key returns count 1.
        const collisions = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(
            sql`regexp_replace(regexp_replace(lower(${users.username}), '<+3+', '', 'g'), '[^a-z0-9]', '', 'g') = ${handleKey}`,
          );
        if ((collisions[0]?.n ?? 0) === 1) {
          await db
            .update(characters)
            .set({ ownerId: id, claimed: true })
            .where(
              and(
                isNull(characters.ownerId),
                sql`regexp_replace(regexp_replace(lower(${characters.legacyDiscordUsername}), '<+3+', '', 'g'), '[^a-z0-9]', '', 'g') = ${handleKey}`,
              ),
            );
        } else {
          req.log.warn(
            { handleKey, userId: id },
            "auto-claim skipped: normalized username collision",
          );
        }
      }
    } catch (claimErr) {
      req.log.warn({ err: claimErr }, "auto-claim by legacy username failed");
    }
    req.session.userId = id;
    await recordAudit({
      req,
      category: "auth",
      action: existing ? "login" : "login_first",
      actorId: id,
      actorName: discordUser.username,
      targetType: "user",
      targetId: id,
      message: `${discordUser.username} signed in via Discord`,
    });
    res.redirect("/");
  } catch (err) {
    req.log.error({ err }, "Discord OAuth callback failed");
    if (err instanceof DiscordConfigError) {
      res.redirect(loginErrorRedirect("config", err.message));
      return;
    }
    if (err instanceof DiscordUpstreamError) {
      res.redirect(loginErrorRedirect("upstream", String(err.status)));
      return;
    }
    res.redirect(loginErrorRedirect("unknown"));
  }
});

router.post("/auth/logout", (req, res): void => {
  const uid = req.session.userId;
  if (uid) {
    void recordAudit({ req, category: "auth", action: "logout", actorId: uid, targetType: "user", targetId: uid, message: "User logged out" });
  }
  req.session.destroy((err) => {
    if (err) {
      req.log.error({ err }, "Session destroy failed during logout");
      const detail = err instanceof Error ? err.name : "session_destroy";
      const params = new URLSearchParams({ reason: "session", detail });
      res.redirect(`/logout/error?${params.toString()}`);
      return;
    }
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

// Dev/test-only login. The real auth path is Discord OAuth, which the automated
// browser-test harness cannot drive. This lets a test seed a user (with roles)
// and then establish a real session as that user to exercise role-gated UI.
// Double-gated: hard-disabled in production (deployments run NODE_ENV=production)
// AND requires the explicit opt-in flag ENABLE_TEST_AUTH=true, so it can never
// be reached accidentally in a non-prod shared deployment.
const TEST_AUTH_ENABLED =
  process.env.NODE_ENV !== "production" && process.env.ENABLE_TEST_AUTH === "true";

// The harness only ever impersonates its own deterministic, namespaced fixtures.
// Restricting to this prefix keeps the backdoor from impersonating real members
// even within a non-prod environment where it is enabled.
const TEST_AUTH_USER_PREFIX = "e2e-";

router.post("/auth/test-login", async (req, res): Promise<void> => {
  if (!TEST_AUTH_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const userId = typeof req.body?.userId === "string" ? req.body.userId : undefined;
  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  if (!userId.startsWith(TEST_AUTH_USER_PREFIX)) {
    res.status(403).json({ error: `test-login is restricted to ${TEST_AUTH_USER_PREFIX}* users` });
    return;
  }
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  req.session.userId = u.id;
  res.json({ ok: true, id: u.id });
});

// Dismiss the first-run onboarding banner for the current user. Idempotent —
// once dismissed the banner never returns regardless of the login count.
router.post("/auth/onboarding/dismiss", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  await db
    .update(users)
    .set({ onboardingBannerDismissed: true })
    .where(eq(users.id, u.id));
  void recordAudit({
    req,
    category: "auth",
    action: "onboarding_dismiss",
    actorId: u.id,
    actorName: u.username,
    targetType: "user",
    targetId: u.id,
    message: `${u.username} dismissed the onboarding banner`,
  });
  res.json({ ok: true });
});

// Accept the server rules from the first-run rules splash. Persists the
// `rulesAccepted` flag (so the blocking gate never reappears) and grants the
// "rules read" Discord role. Idempotent — calling it again is a harmless no-op.
// The role grant is best-effort: it only fires on the real deployment (gated by
// externalWritesAllowed inside addGuildMemberRole), and a failed/suppressed grant
// must NOT block the user, so we always persist the flag and report the grant
// outcome separately.
router.post("/auth/accept-rules", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  if (!u.rulesAccepted) {
    await db.update(users).set({ rulesAccepted: true }).where(eq(users.id, u.id));
    void recordAudit({
      req,
      category: "auth",
      action: "rules_accepted",
      actorId: u.id,
      actorName: u.username,
      targetType: "user",
      targetId: u.id,
      message: `${u.username} accepted the server rules`,
    });
  }
  const grant = await addGuildMemberRole(
    u.discordId,
    RULES_ROLE_ID,
    "Accepted the server rules on the portal first-run splash",
  );
  res.json({ ok: true, roleGranted: grant.ok });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const [link] = await db
    .select()
    .from(vrchatLinks)
    .where(eq(vrchatLinks.discordId, u.discordId));
  // Data-derived venue-employment flags. Unlike the role-derived STORE_OWNER /
  // RIPPERDOC flags, an employee may hold no special Discord role, so the nav
  // gate for the management pages must come from actual employment rows (any of
  // the user's characters being on staff at a store / clinic).
  const [storeEmp] = await db
    .select({ id: storeEmployees.id })
    .from(storeEmployees)
    .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
    .where(eq(characters.ownerId, u.id))
    .limit(1);
  const [ripperdocEmp] = await db
    .select({ id: ripperdocEmployees.id })
    .from(ripperdocEmployees)
    .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
    .where(eq(characters.ownerId, u.id))
    .limit(1);
  res.json({
    id: u.id,
    discordId: u.discordId,
    username: u.username,
    globalName: u.globalName,
    avatarUrl: u.avatarUrl,
    roles: u.roles,
    verified18: u.verified18,
    loginCount: u.loginCount,
    onboardingBannerDismissed: u.onboardingBannerDismissed,
    notificationPromptDismissed: u.notificationPromptDismissed,
    rulesAccepted: u.rulesAccepted,
    // Account-level text-size preference ("default" | "lg" | "xl"), or null if
    // never set from any device. The SPA hydrates its localStorage copy from
    // this so the choice follows the account across browsers.
    textScale: u.textScale ?? null,
    isAdmin: hasRole(u.roles, "ADMIN"),
    isFixer: hasRole(u.roles, "FIXER"),
    // Display-only: true when this user holds the narrow Trial Fixer tier
    // (derived from the Trial Fixer role id, not its name). Trial fixers are NOT
    // full fixers — they can author missions but are gated out of every other
    // fixer tool, so `isFixer` is false for them once roles are resolved.
    isTrialFixer: hasRole(u.roles, "TRIAL_FIXER"),
    isCoordinator: hasRole(u.roles, "COORDINATOR"),
    isArchivist: hasRole(u.roles, "ARCHIVIST"),
    isCsApprover: hasRole(u.roles, "CS_APPROVER"),
    isRipperdoc: hasRole(u.roles, "RIPPERDOC"),
    // NCPD flags (id-derived markers, see applyRoleIdGrants). A Commissioner is
    // always also an officer for gating purposes, so isNcpd covers both.
    isNcpd: hasRole(u.roles, "NCPD") || hasRole(u.roles, "NCPD_COMMISSIONER"),
    isNcpdCommissioner: hasRole(u.roles, "NCPD_COMMISSIONER"),
    isStoreOwner: hasRole(u.roles, "STORE_OWNER"),
    // Data-derived: true when any of the user's characters is on staff at a
    // store / ripperdoc clinic. Drives the management nav links so employees
    // (who may hold no owner role) can reach the venues they work at.
    isStoreEmployee: !!storeEmp,
    // True when this user may open the CyberPsycho control panel: staff always,
    // or a per-user grant an admin flipped on from the user management screen.
    canCyberpsycho:
      hasRole(u.roles, "ADMIN") || hasRole(u.roles, "FIXER") || u.cyberpsychoAccess,
    isRipperdocEmployee: !!ripperdocEmp,
    // Staff-only lockdown state. When true, only ADMIN / FIXER / ARCHIVIST may
    // use the portal; the SPA shows a maintenance screen to everyone else.
    loginRestricted: await isLoginRestricted(),
    vrchat: link
      ? { vrchatUserId: link.vrchatUserId, vrchatUsername: link.vrchatUsername, vrchatUrl: link.vrchatUrl }
      : null,
  });
});

// Whether the current user already holds the self-service NPC Discord role.
// Read-only Discord lookups are not gated, so this works in every environment.
// We check the RAW role id (not a resolved name) so the answer is exact.
// `determined` distinguishes "we know they don't have it" (determined:true,
// hasRole:false) from "the lookup failed, so we can't tell" (determined:false).
// Callers use this so the dashboard CTA only appears when we POSITIVELY know
// the user lacks the role, rather than during a transient Discord outage.
router.get("/auth/npc-role", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  if (roleIds === null) {
    res.json({ hasRole: false, determined: false });
    return;
  }
  res.json({ hasRole: roleIds.includes(NPC_ROLE_ID), determined: true });
});

// Grant the NPC Discord role to the current user. A portal user's id IS their
// Discord snowflake, so the grant targets the signed-in member. Idempotent: if
// they already have the role we report success without calling Discord. The
// actual write is gated behind externalWritesAllowed() (in addGuildMemberRole),
// so on the test site this returns a clear error rather than silently failing.
router.post("/auth/npc-role", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  if (roleIds && roleIds.includes(NPC_ROLE_ID)) {
    res.json({ ok: true, hasRole: true });
    return;
  }
  const result = await addGuildMemberRole(u.discordId, NPC_ROLE_ID);
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  void recordAudit({
    req,
    category: "auth",
    action: "npc_role_grant",
    actorId: u.id,
    actorName: u.username,
    targetType: "user",
    targetId: u.id,
    message: `${u.username} self-granted the NPC role`,
  });
  res.json({ ok: true, hasRole: true });
});

// Remove the NPC Discord role from the current user (step down from NPC). Mirror
// of the grant route. Idempotent: if they don't have the role we report success
// without calling Discord. The actual write is gated behind externalWritesAllowed()
// (in removeGuildMemberRole), so on the test site this returns a clear error
// rather than silently failing.
router.delete("/auth/npc-role", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  if (roleIds && !roleIds.includes(NPC_ROLE_ID)) {
    res.json({ ok: true, hasRole: false });
    return;
  }
  const result = await removeGuildMemberRole(u.discordId, NPC_ROLE_ID);
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  void recordAudit({
    req,
    category: "auth",
    action: "npc_role_remove",
    actorId: u.id,
    actorName: u.username,
    targetType: "user",
    targetId: u.id,
    message: `${u.username} self-removed the NPC role`,
  });
  res.json({ ok: true, hasRole: false });
});

// ---- Notification ("ping") roles ----
// A single endpoint pair covering all three self-service Discord roles (NPC,
// Social RP, Main Session) instead of three copy-pasted route trios. Semantics
// are identical to /auth/npc-role: read-only lookups via the bot are not gated
// (so they work everywhere), `determined` distinguishes "we know the state"
// from "the Discord lookup failed", and the actual grant/remove writes are
// gated behind externalWritesAllowed() (in add/removeGuildMemberRole), so on
// the test site a toggle returns a clear error rather than silently failing.

// Snapshot of which of the three notification roles the caller currently holds.
router.get("/auth/notification-roles", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  if (roleIds === null) {
    res.json({
      determined: false,
      roles: Object.fromEntries(NOTIFICATION_ROLES.map((r) => [r.key, false])),
    });
    return;
  }
  res.json({
    determined: true,
    roles: Object.fromEntries(
      NOTIFICATION_ROLES.map((r) => [r.key, roleIds.includes(r.roleId)]),
    ),
  });
});

// Enable/disable one notification role for the caller. Body: { role, enabled }.
// Idempotent: if the member is already in the desired state we report success
// without calling Discord. On a successful change we audit-log it. Returns the
// full refreshed snapshot so the UI never drifts from Discord's real state.
router.post("/auth/notification-roles", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const role = typeof req.body?.role === "string" ? req.body.role : undefined;
  const enabled = req.body?.enabled;
  const def = NOTIFICATION_ROLES.find((r) => r.key === role);
  if (!def || typeof enabled !== "boolean") {
    res.status(400).json({ error: "role (npc|social_rp|main_session) and boolean enabled are required" });
    return;
  }
  const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
  const has = roleIds ? roleIds.includes(def.roleId) : false;

  // Already in the desired state — skip the Discord write (idempotent). Only
  // short-circuit when we could actually read the member; if the lookup failed
  // (roleIds === null) fall through so the write attempt surfaces a real result.
  if (roleIds !== null && has === enabled) {
    res.json({
      ok: true,
      determined: true,
      roles: Object.fromEntries(
        NOTIFICATION_ROLES.map((r) => [r.key, roleIds.includes(r.roleId)]),
      ),
    });
    return;
  }

  const reason = `Self-service ${def.label} role ${enabled ? "granted" : "removed"} via portal`;
  const result = enabled
    ? await addGuildMemberRole(u.discordId, def.roleId, reason)
    : await removeGuildMemberRole(u.discordId, def.roleId, reason);
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }

  const key = def.key as NotificationRoleKey;
  void recordAudit({
    req,
    category: "auth",
    action: enabled ? "notification_role_grant" : "notification_role_remove",
    actorId: u.id,
    actorName: u.username,
    targetType: "user",
    targetId: u.id,
    message: `${u.username} ${enabled ? "enabled" : "disabled"} the ${def.label} notification role`,
  });

  // Re-derive the snapshot from the known prior state + the change we just made,
  // so the response reflects the new reality without a second Discord round-trip.
  const after = new Set(roleIds ?? []);
  if (enabled) after.add(def.roleId);
  else after.delete(def.roleId);
  res.json({
    ok: true,
    determined: true,
    roles: Object.fromEntries(
      NOTIFICATION_ROLES.map((r) => [r.key, after.has(r.roleId)]),
    ),
    changed: key,
  });
});

// Save the account-level text-size preference so it follows the user across
// devices. "default" is stored literally (not null) so it can override a
// larger localStorage choice on another device. Idempotent.
router.post("/auth/text-scale", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const scale = (req.body as { scale?: unknown } | undefined)?.scale;
  if (scale !== "default" && scale !== "lg" && scale !== "xl") {
    res.status(400).json({ error: "scale must be one of: default, lg, xl" });
    return;
  }
  await db.update(users).set({ textScale: scale }).where(eq(users.id, u.id));
  res.json({ ok: true, textScale: scale });
});

// Dismiss the dashboard "set your Discord ping preferences" prompt for the
// current user. Idempotent — once dismissed it never returns. Mirrors the
// onboarding-banner dismissal. The Settings toggles remain available regardless.
router.post("/auth/notification-prompt/dismiss", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  await db
    .update(users)
    .set({ notificationPromptDismissed: true })
    .where(eq(users.id, u.id));
  void recordAudit({
    req,
    category: "auth",
    action: "notification_prompt_dismiss",
    actorId: u.id,
    actorName: u.username,
    targetType: "user",
    targetId: u.id,
    message: `${u.username} dismissed the notification-preferences prompt`,
  });
  res.json({ ok: true });
});

export default router;
