import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
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
    req.session.userId = id;
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
  req.session.destroy(() => {
    res.sendStatus(204);
  });
});

router.get("/auth/me", requireAuth, (req, res): void => {
  const u = req.user!;
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
  });
});

export default router;
