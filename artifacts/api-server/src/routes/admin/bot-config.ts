import type { IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, activityEvents, botConfig } from "@workspace/db";
import { recordAudit } from "../../lib/audit";
import { getLiveModeState, LIVE_MODE_KEYS, LIVE_SYSTEMS, type LiveSystem } from "../../lib/liveMode";
import { isLoginRestricted, LOGIN_RESTRICTED_KEY } from "../../lib/siteAccess";
import { isVrchatCalendarSyncEnabled, VRCHAT_SYNC_FLAG } from "../../lib/eventsService";
import { scanVrchatChannel } from "../../lib/vrchatLinks";
import { adminOnly } from "./shared";

export function registerBotConfig(router: IRouter): void {
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
}
