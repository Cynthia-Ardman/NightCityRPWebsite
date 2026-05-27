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

router.get("/auth/discord/callback", async (req, res): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code || !state || state !== req.session.oauthState) {
    res.status(400).send("Invalid OAuth state");
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
      res.status(500).type("text/plain").send(
        `Login is misconfigured on the server.\n\n${err.message}\n\nPlease contact an administrator.`,
      );
      return;
    }
    if (err instanceof DiscordUpstreamError) {
      res.status(502).type("text/plain").send(
        `Discord returned an error during login (HTTP ${err.status}). Please try again in a moment.`,
      );
      return;
    }
    res.status(500).type("text/plain").send(
      "Unexpected error completing Discord login. Please try again; if the problem persists, contact an administrator.",
    );
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
