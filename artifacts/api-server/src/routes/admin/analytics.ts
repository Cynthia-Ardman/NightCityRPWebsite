import type { IRouter } from "express";
import { sql, and, gte } from "drizzle-orm";
import { db, users, events } from "@workspace/db";
import { inArray, arrayOverlaps } from "drizzle-orm";
import type { PgTable, AnyPgColumn } from "drizzle-orm/pg-core";
import { requireAnyRole } from "../../middlewares/auth";
import { hasRole, ROLE_NAMES } from "../../lib/discord";
import { auditLog } from "@workspace/db";
import {
  computeAdminAnalytics,
  parseAnalyticsRange,
  computeMembershipGrowth,
  parseExcludeAbove,
  parseWeekParam,
  computeCharacterTrendWeek,
  computeVrchatInstanceDrilldown,
  computeMissionsWeekDrilldown,
  computeEconomyWeekTransactions,
} from "../../lib/analytics";
import { reviewVotes, reviewComments, missionActorPayments, missions } from "@workspace/db";
import { adminOrFixer } from "./shared";

export function registerAnalytics(router: IRouter): void {
  // Staff activity report: every FIXER / TRIAL_FIXER / CS APPROVER with counts
  // of role-attributable actions inside the requested window plus an all-time
  // "last action" timestamp, so leadership can spot staff who have gone idle.
  // ADMIN / COORDINATOR / ARCHIVIST — rank-and-file staff do NOT see each
  // other's activity numbers. Powers the FIXER tab on the Analytics page.
  // All aggregation happens in SQL — one grouped query per activity source.
  //
  // Role attribution: fixers and CS approvers do DIFFERENT jobs even when one
  // person holds both roles. Review-queue metrics (votes/comments) are only
  // counted for CS approvers, and fixer metrics (missions/events/NPC payouts)
  // only for fixers — a fixer without the CS role shows no review numbers and
  // vice versa, so neither group is judged on the other group's tasks.
  router.get("/admin/fixer-activity", requireAnyRole(["ADMIN", "COORDINATOR", "ARCHIVIST"]), async (req, res): Promise<void> => {
    const days = Math.min(365, Math.max(7, parseInt(String(req.query.days ?? "90"), 10) || 90));
    const since = new Date(Date.now() - days * 86_400_000);
    const weeks = Math.ceil(days / 7);

    const fixers = await db
      .select({
        id: users.id,
        username: users.username,
        globalName: users.globalName,
        avatarUrl: users.avatarUrl,
        roles: users.roles,
        lastSeenAt: users.lastSeenAt,
      })
      .from(users)
      // Roles are stored as LOWERCASE Discord role names (see ROLE_NAMES in
      // lib/discord.ts) — match every name in the FIXER/TRIAL_FIXER/CS_APPROVER groups.
      .where(arrayOverlaps(users.roles, [
        ...ROLE_NAMES.FIXER, ...ROLE_NAMES.TRIAL_FIXER, ...ROLE_NAMES.CS_APPROVER,
      ]));
    if (fixers.length === 0) {
      res.json({ days, weeks, generatedAt: new Date().toISOString(), fixers: [] });
      return;
    }
    const ids = fixers.map((f) => f.id);

    // Each source: window count + ALL-TIME latest action per user, plus
    // in-window weekly buckets (for charts), in two grouped queries.
    type Agg = { uid: string | null; cnt: number; last: Date | null };
    type SourceResult = { agg: Agg[]; weekly: Map<string, number[]> };
    const aggregate = async (
      table: PgTable,
      uidCol: AnyPgColumn,
      tsCol: AnyPgColumn,
    ): Promise<SourceResult> => {
      const [rows, wkRows] = await Promise.all([
        db
          .select({
            uid: sql<string | null>`${uidCol}`,
            cnt: sql<number>`count(*) filter (where ${tsCol} >= ${since})::int`,
            last: sql<Date | null>`max(${tsCol})`,
          })
          .from(table)
          .where(inArray(uidCol, ids))
          .groupBy(uidCol),
        // Weekly buckets: wk 0 = the most recent week; stored oldest-first.
        db
          .select({
            uid: sql<string | null>`${uidCol}`,
            wk: sql<number>`floor(extract(epoch from (now() - ${tsCol})) / 604800)::int`,
            cnt: sql<number>`count(*)::int`,
          })
          .from(table)
          .where(and(inArray(uidCol, ids), gte(tsCol, since)))
          .groupBy(uidCol, sql`2`),
      ]);
      const weekly = new Map<string, number[]>();
      for (const r of wkRows) {
        if (!r.uid || r.wk == null || r.wk < 0 || r.wk >= weeks) continue;
        const arr = weekly.get(r.uid) ?? new Array(weeks).fill(0);
        arr[weeks - 1 - r.wk] = r.cnt;
        weekly.set(r.uid, arr);
      }
      return { agg: rows as Agg[], weekly };
    };

    // NOTE: closing review tickets is deliberately NOT counted — that is an
    // admin-only duty on this server, so it would unfairly pad admin rows and
    // can never be held against fixers.
    const [
      created, completed, votes, comments, eventsCreated, payments, audits,
    ] = await Promise.all([
      aggregate(missions, missions.fixerId, missions.createdAt),
      aggregate(missions, missions.completedBy, missions.completedAt),
      aggregate(reviewVotes, reviewVotes.voterId, reviewVotes.votedAt),
      aggregate(reviewComments, reviewComments.authorId, reviewComments.createdAt),
      aggregate(events, events.createdById, events.createdAt),
      aggregate(missionActorPayments, missionActorPayments.fixerId, missionActorPayments.createdAt),
      aggregate(auditLog, auditLog.actorId, auditLog.createdAt),
    ]);

    const byUid = (rows: Agg[]) => {
      const m = new Map<string, Agg>();
      for (const r of rows) if (r.uid) m.set(r.uid, r);
      return m;
    };
    const mCreated = byUid(created.agg);
    const mCompleted = byUid(completed.agg);
    const mVotes = byUid(votes.agg);
    const mComments = byUid(comments.agg);
    const mEvents = byUid(eventsCreated.agg);
    const mPayments = byUid(payments.agg);
    const mAudits = byUid(audits.agg);
    const zeros = () => new Array(weeks).fill(0) as number[];
    const weeklySources: Array<[string, SourceResult]> = [
      ["missionsCreated", created],
      ["missionsCompleted", completed],
      ["reviewVotes", votes],
      ["reviewComments", comments],
      ["eventsCreated", eventsCreated],
      ["actorPayments", payments],
      ["auditActions", audits],
    ];

    const asTime = (d: Date | string | null | undefined): number | null => {
      if (!d) return null;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? null : t;
    };

    // Which report columns belong to which role. auditActions is an all-staff
    // metric and stays unmasked for everyone.
    const FIXER_KEYS = new Set(["missionsCreated", "missionsCompleted", "eventsCreated", "actorPayments"]);
    const CS_KEYS = new Set(["reviewVotes", "reviewComments"]);

    const report = fixers.map((f) => {
      const isFixer = hasRole(f.roles, "FIXER") || hasRole(f.roles, "TRIAL_FIXER");
      const isCsApprover = hasRole(f.roles, "CS_APPROVER");
      // Only count sources that belong to a role this user actually holds —
      // a fixer's stray review comments (or a CS approver's old mission rows)
      // must not pad or damn the wrong report column.
      const allowed = (key: string): boolean =>
        (FIXER_KEYS.has(key) && isFixer) || (CS_KEYS.has(key) && isCsApprover) || key === "auditActions";
      const sourceMaps: Array<[string, Map<string, Agg>]> = [
        ["missionsCreated", mCreated], ["missionsCompleted", mCompleted],
        ["reviewVotes", mVotes], ["reviewComments", mComments],
        ["eventsCreated", mEvents], ["actorPayments", mPayments], ["auditActions", mAudits],
      ];
      let lastMs: number | null = null;
      for (const [key, m] of sourceMaps) {
        if (!allowed(key)) continue;
        const t = asTime(m.get(f.id)?.last ?? null);
        if (t !== null && (lastMs === null || t > lastMs)) lastMs = t;
      }
      const cnt = (key: string, m: Map<string, Agg>): number =>
        allowed(key) ? (m.get(f.id)?.cnt ?? 0) : 0;
      return {
        userId: f.id,
        username: f.username,
        globalName: f.globalName,
        avatarUrl: f.avatarUrl,
        roles: f.roles,
        isFixer,
        isCsApprover,
        isTrialFixer: hasRole(f.roles, "TRIAL_FIXER") && !hasRole(f.roles, "FIXER"),
        lastSeenAt: f.lastSeenAt ? new Date(f.lastSeenAt).toISOString() : null,
        lastFixerActionAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
        missionsCreated: cnt("missionsCreated", mCreated),
        missionsCompleted: cnt("missionsCompleted", mCompleted),
        reviewVotes: cnt("reviewVotes", mVotes),
        reviewComments: cnt("reviewComments", mComments),
        eventsCreated: cnt("eventsCreated", mEvents),
        actorPayments: cnt("actorPayments", mPayments),
        auditActions: cnt("auditActions", mAudits),
        weekly: audits.weekly.get(f.id) ?? zeros(),
        weeklyBySource: Object.fromEntries(
          weeklySources.map(([key, src]) => [key, allowed(key) ? (src.weekly.get(f.id) ?? zeros()) : zeros()]),
        ),
      };
    });
    // Least-recently-active first — that is the whole point of the report.
    report.sort((a, b) => {
      const ta = a.lastFixerActionAt ? new Date(a.lastFixerActionAt).getTime() : 0;
      const tb = b.lastFixerActionAt ? new Date(b.lastFixerActionAt).getTime() : 0;
      return ta - tb;
    });
    res.json({ days, weeks, generatedAt: new Date().toISOString(), fixers: report });
  });

  // Staff analytics: server-health aggregates (economy, missions, review-queue
  // aging, player activity). Fixer-and-up — this powers the Analytics page in
  // the staff navigation. All aggregation happens in SQL (see lib/analytics).
  // Community growth timeline: weekly Discord/VRChat join & leave counts from
  // membership_events (welcome + bot-logs ingestion, VRChat audit-log poll).
  router.get("/admin/membership-growth", adminOrFixer, async (req, res): Promise<void> => {
    const range = parseAnalyticsRange(req.query.range);
    const payload = await computeMembershipGrowth(range);
    res.json(payload);
  });

  router.get("/admin/analytics", adminOrFixer, async (req, res): Promise<void> => {
    const range = parseAnalyticsRange(req.query.range);
    const excludeAbove = parseExcludeAbove(req.query.excludeAbove);
    const payload = await computeAdminAnalytics(range, excludeAbove);
    res.json(payload);
  });

  // Drill-down for the Players & Characters analytics cards: which characters
  // sit behind one bucket. active60/dormant mirror computeAdminAnalytics' 60-day
  // activity split (wallet movement, mission application, or assignment); the
  // remaining buckets are plain life statuses. Fixer-and-up like the analytics.
  router.get("/admin/analytics/characters", adminOrFixer, async (req, res): Promise<void> => {
    const bucket = String(req.query.bucket ?? "");
    const allowed = new Set(["active60", "dormant", "active", "loa", "dead", "retired", "missing"]);
    if (!allowed.has(bucket)) {
      res.status(400).json({ error: "invalid bucket" });
      return;
    }
    const cutoff = new Date(Date.now() - 60 * 86_400_000);
    const activitySplit = bucket === "active60" || bucket === "dormant";
    const rows = activitySplit
      ? ((
          await db.execute(sql`
            SELECT t.id, t.name, t.life_status, t.owner_name, t.last_activity_at
            FROM (
              SELECT c.id, c.name, c.life_status,
                COALESCE(u.global_name, u.username) AS owner_name,
                GREATEST(
                  (SELECT MAX(wt.created_at) FROM wallet_transactions wt WHERE wt.character_id = c.id),
                  (SELECT MAX(ma.created_at) FROM mission_applications ma WHERE ma.character_id = c.id),
                  (SELECT MAX(s.created_at) FROM mission_assignments s WHERE s.character_id = c.id)
                ) AS last_activity_at
              FROM characters c
              LEFT JOIN users u ON u.id = c.owner_id
              WHERE c.kind = 'pc' AND c.archived = false AND c.life_status = 'active'
            ) t
            WHERE ${bucket === "active60" ? sql`t.last_activity_at >= ${cutoff}` : sql`(t.last_activity_at IS NULL OR t.last_activity_at < ${cutoff})`}
            ORDER BY t.last_activity_at DESC NULLS LAST, lower(t.name)
          `)
        ).rows as Array<{ id: number; name: string; life_status: string; owner_name: string | null; last_activity_at: Date | string | null }>)
      : ((
          await db.execute(sql`
            SELECT c.id, c.name, c.life_status,
              COALESCE(u.global_name, u.username) AS owner_name,
              NULL::timestamptz AS last_activity_at
            FROM characters c
            LEFT JOIN users u ON u.id = c.owner_id
            WHERE c.kind = 'pc' AND c.archived = false AND c.life_status = ${bucket}
            ORDER BY lower(c.name)
          `)
        ).rows as Array<{ id: number; name: string; life_status: string; owner_name: string | null; last_activity_at: Date | string | null }>);
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        lifeStatus: r.life_status,
        ownerName: r.owner_name,
        lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
      })),
    );
  });

  // Drill-down for the Active/Dormant trend chart: which characters flipped
  // active->dormant (lost) or dormant->active (gained) in one snapshot week.
  router.get("/admin/analytics/character-trend", adminOrFixer, async (req, res): Promise<void> => {
    const week = parseWeekParam(req.query.week);
    if (!week) {
      res.status(400).json({ error: "invalid week" });
      return;
    }
    res.json(await computeCharacterTrendWeek(week));
  });

  // Drill-down for the VRChat charts: the individual instance sessions behind
  // one weekly bar (?week=) or one top-world row (?world=&since window from
  // ?range=). Includes per-instance median occupancy + a downsampled population
  // series for a sparkline.
  router.get("/admin/analytics/vrchat-instances", adminOrFixer, async (req, res): Promise<void> => {
    const week = parseWeekParam(req.query.week);
    const world = typeof req.query.world === "string" && req.query.world.trim() !== "" ? req.query.world : null;
    if (!week && !world) {
      res.status(400).json({ error: "week or world required" });
      return;
    }
    const range = parseAnalyticsRange(req.query.range);
    const weeks = { "4w": 4, "3m": 13, "1y": 52, all: 20 * 52 }[range];
    const since = new Date(Date.now() - weeks * 7 * 86_400_000);
    const instances = await computeVrchatInstanceDrilldown(week ? { week } : { world: world!, since });
    res.json({ instances });
  });

  // Drill-down for the Missions weekly chart: which missions completed in that
  // week plus per-mission and week-total player/actor payout splits.
  router.get("/admin/analytics/missions-week", adminOrFixer, async (req, res): Promise<void> => {
    const week = parseWeekParam(req.query.week);
    if (!week) {
      res.status(400).json({ error: "invalid week" });
      return;
    }
    res.json(await computeMissionsWeekDrilldown(week));
  });

  // Drill-down for the economy chart: the settled transactions behind one
  // (week, category, direction) cell, with the same whale filter as the chart.
  router.get("/admin/analytics/economy-transactions", adminOrFixer, async (req, res): Promise<void> => {
    const week = parseWeekParam(req.query.week);
    const category = String(req.query.category ?? "");
    const direction = req.query.direction === "destroyed" ? "destroyed" : "created";
    if (!week || category === "") {
      res.status(400).json({ error: "week and category required" });
      return;
    }
    const excludeAbove = parseExcludeAbove(req.query.excludeAbove);
    res.json(await computeEconomyWeekTransactions({ week, category, direction, excludeAbove }));
  });
}
