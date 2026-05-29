import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { db, users, characters, vrchatLinks } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  buildAuthUrl,
  exchangeCode,
  fetchUser,
  fetchGuildMemberRoles,
  avatarUrl,
  hasRole,
  DiscordConfigError,
  DiscordUpstreamError,
} from "../lib/discord";
import { requireAuth } from "../middlewares/auth";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/auth/discord/login", (req, res): void => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(buildAuthUrl(state));
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
    const token = await exchangeCode(code);
    const discordUser = await fetchUser(token.access_token);
    const roles = await fetchGuildMemberRoles(token.access_token, discordUser.id);
    const id = discordUser.id;
    const expiresAt = new Date(Date.now() + token.expires_in * 1000);
    const av = avatarUrl(discordUser.id, discordUser.avatar);
    const [existing] = await db.select().from(users).where(eq(users.id, id));
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
          lastSeenAt: new Date(),
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
      });
    }
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

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const [link] = await db
    .select()
    .from(vrchatLinks)
    .where(eq(vrchatLinks.discordId, u.discordId));
  res.json({
    id: u.id,
    discordId: u.discordId,
    username: u.username,
    globalName: u.globalName,
    avatarUrl: u.avatarUrl,
    roles: u.roles,
    activeCharacterId: u.activeCharacterId,
    isAdmin: hasRole(u.roles, "ADMIN"),
    isFixer: hasRole(u.roles, "FIXER"),
    isCsApprover: hasRole(u.roles, "CS_APPROVER"),
    isRipperdoc: hasRole(u.roles, "RIPPERDOC"),
    isStoreOwner: hasRole(u.roles, "STORE_OWNER"),
    vrchat: link
      ? { vrchatUserId: link.vrchatUserId, vrchatUsername: link.vrchatUsername, vrchatUrl: link.vrchatUrl }
      : null,
  });
});

export default router;
