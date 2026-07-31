import { db, classifyWalletCategory } from "@workspace/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Staff analytics — server-side aggregates for the Analytics dashboard.
// Everything is computed in SQL (grouped sums / counts) so the browser only
// ever receives small pre-bucketed series, never raw transaction dumps.
// ---------------------------------------------------------------------------

export type AnalyticsRange = "4w" | "3m" | "1y" | "all";

// "all" uses a far-past window start so every recorded row qualifies; the
// portal's data only goes back to early 2025, so charts stay a sane size.
const RANGE_WEEKS: Record<AnalyticsRange, number> = { "4w": 4, "3m": 13, "1y": 52, all: 20 * 52 };

export function parseAnalyticsRange(raw: unknown): AnalyticsRange {
  return raw === "4w" || raw === "1y" || raw === "all" ? raw : "3m";
}

export interface MembershipGrowthWeek {
  weekStart: string;
  discordJoins: number;
  discordLeaves: number;
  vrchatJoins: number;
  vrchatLeaves: number;
}

export interface MembershipGrowthPayload {
  weeks: MembershipGrowthWeek[];
  // Earliest recorded event per (source, direction) — the chart uses these to
  // mark where each series' coverage actually begins (e.g. Discord leave
  // logging starts later than join history).
  coverage: {
    discordJoinSince: string | null;
    discordLeaveSince: string | null;
    vrchatSince: string | null;
  };
  generatedAt: string;
}

// Weekly join/leave counts per community for the growth timeline. All
// aggregation in SQL; cumulative/net math happens client-side.
export async function computeMembershipGrowth(range: AnalyticsRange): Promise<MembershipGrowthPayload> {
  const weeks = RANGE_WEEKS[range];
  const rows = await db.execute(sql`
    SELECT date_trunc('week', occurred_at)::date::text AS week,
           source, direction, COUNT(*)::int AS n
    FROM membership_events
    WHERE occurred_at >= date_trunc('week', now()) - make_interval(weeks => ${weeks})
    GROUP BY 1, 2, 3
    ORDER BY 1
  `);
  const byWeek = new Map<string, MembershipGrowthWeek>();
  for (const r of rows.rows as Array<{ week: string; source: string; direction: string; n: number }>) {
    let w = byWeek.get(r.week);
    if (!w) {
      w = { weekStart: r.week, discordJoins: 0, discordLeaves: 0, vrchatJoins: 0, vrchatLeaves: 0 };
      byWeek.set(r.week, w);
    }
    if (r.source === "discord") {
      if (r.direction === "join") w.discordJoins += r.n;
      else w.discordLeaves += r.n;
    } else if (r.source === "vrchat") {
      if (r.direction === "join") w.vrchatJoins += r.n;
      else w.vrchatLeaves += r.n;
    }
  }
  const cov = await db.execute(sql`
    SELECT source, direction, MIN(occurred_at) AS since
    FROM membership_events
    GROUP BY 1, 2
  `);
  const covRows = cov.rows as Array<{ source: string; direction: string; since: string | Date }>;
  const findSince = (source: string, direction?: string) => {
    const matches = covRows.filter((r) => r.source === source && (!direction || r.direction === direction));
    if (matches.length === 0) return null;
    const min = matches.map((r) => new Date(r.since).getTime()).sort((a, b) => a - b)[0];
    return new Date(min).toISOString();
  };
  return {
    weeks: [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    coverage: {
      discordJoinSince: findSince("discord", "join"),
      discordLeaveSince: findSince("discord", "leave"),
      vrchatSince: findSince("vrchat"),
    },
    generatedAt: new Date().toISOString(),
  };
}

interface EconomyWeek {
  weekStart: string;
  created: Record<string, number>;
  destroyed: Record<string, number>;
}

interface SupplyPoint {
  weekStart: string;
  net: number;
  total: number;
}

interface MissionWeek {
  weekStart: string;
  missionsRun: number;
  payoutTotal: number;
  // Split of payoutTotal by ledger idempotency-key prefix: player mission pay
  // (mission_payout:<assignmentId>) vs actor/NPC pay (actor_payout:<rowId>).
  // Legacy mission-category rows predating those keys fall in neither bucket,
  // so playerPayout + actorPayout <= payoutTotal.
  playerPayout: number;
  actorPayout: number;
}

interface ActivityTrendWeek {
  weekStart: string;
  active: number;
  dormant: number;
  gained: number;
  lost: number;
}

interface AgeBuckets {
  under1d: number;
  d1to3: number;
  d3to7: number;
  d7to30: number;
  over30: number;
}

interface ReviewQueueStats {
  queue: string;
  label: string;
  open: number;
  decidedAwaitingClose: number;
  changesRequested: number;
  oldestDays: number | null;
  ageBuckets: AgeBuckets;
}

interface VrchatWeek {
  weekStart: string;
  sessions: number;
  hours: number;
}

interface VrchatWorldStat {
  worldName: string;
  sessions: number;
  hours: number;
  peakUserCount: number;
}

interface VrchatStats {
  weekly: VrchatWeek[];
  totalSessions: number;
  totalHours: number;
  avgDurationMinutes: number;
  peakUserCount: number;
  openNow: number;
  topWorlds: VrchatWorldStat[];
}

interface SiteWeek {
  weekStart: string;
  activeUsers: number;
  pageHits: number;
  logins: number;
  charactersCreated: number;
  characterEdits: number;
}

interface SiteStats {
  weekly: SiteWeek[];
  totalActiveUsers: number;
  totalLogins: number;
  totalCharactersCreated: number;
  totalCharacterEdits: number;
  trackingSince: string | null;
}

export interface AdminAnalytics {
  range: AnalyticsRange;
  since: string;
  excludeAbove: number | null;
  excludedWallets: number;
  economy: { weekly: EconomyWeek[]; supply: SupplyPoint[] };
  missions: {
    weekly: MissionWeek[];
    totalMissions: number;
    totalApplications: number;
    avgApplicationsPerMission: number;
    totalPayout: number;
  };
  reviews: ReviewQueueStats[];
  players: {
    lifeStatus: Record<string, number>;
    activeRecent: number;
    dormant: number;
    sheetsPerMonth: Array<{ month: string; count: number }>;
    // Weekly Active(60d)/Dormant history from character_week_snapshots (the
    // character_snapshot job). Empty until the job has run at least once.
    activityTrend: ActivityTrendWeek[];
  };
  vrchat: VrchatStats;
  site: SiteStats;
}

function bucketAges(dates: Date[], now: Date): { buckets: AgeBuckets; oldestDays: number | null } {
  const buckets: AgeBuckets = { under1d: 0, d1to3: 0, d3to7: 0, d7to30: 0, over30: 0 };
  let oldest: number | null = null;
  for (const d of dates) {
    const days = (now.getTime() - d.getTime()) / 86_400_000;
    if (oldest === null || days > oldest) oldest = days;
    if (days < 1) buckets.under1d++;
    else if (days < 3) buckets.d1to3++;
    else if (days < 7) buckets.d3to7++;
    else if (days < 30) buckets.d7to30++;
    else buckets.over30++;
  }
  return { buckets, oldestDays: oldest === null ? null : Math.round(dates.length ? oldest : 0) };
}

// wallet_transactions rows that represent REAL settled player-wallet movement.
// pending/failed rows never moved money; venue-only rows (user_id null) are
// internal store/clinic ledgers, not player money supply.
const SETTLED = sql`sync_status IN ('synced', 'reconciled') AND user_id IS NOT NULL`;

export function parseExcludeAbove(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export async function computeAdminAnalytics(
  range: AnalyticsRange,
  excludeAbove: number | null = null,
): Promise<AdminAnalytics> {
  const weeks = RANGE_WEEKS[range];
  const now = new Date();
  const since = new Date(now.getTime() - weeks * 7 * 86_400_000);

  // Optional whale filter: staff can exclude wallets whose all-time settled
  // net balance exceeds a typed-in threshold so one outlier account doesn't
  // dwarf the economy charts. The exclusion is a subquery (not an in-memory
  // id list) so it composes into each aggregate without parameter spreading.
  const WHALES = sql`
    SELECT user_id FROM wallet_transactions
    WHERE ${SETTLED}
    GROUP BY user_id
    HAVING SUM(amount) > ${excludeAbove ?? 0}
  `;
  const EXCLUDE = excludeAbove === null ? sql`` : sql`AND user_id NOT IN (${WHALES})`;
  let excludedWallets = 0;
  if (excludeAbove !== null) {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS n FROM (${WHALES}) w`);
    excludedWallets = Number((res.rows[0] as { n: number } | undefined)?.n) || 0;
  }

  // ---- Economy: weekly created vs destroyed, grouped by category -----------
  // Rows are grouped by (week, category, kind) so null-category live rows can
  // be classified in JS via the shared classifier (kind alone is enough for
  // live rows; historical rows had category backfilled). Transfers move money
  // between players (two mirrored legs) so they neither create nor destroy —
  // excluded, as is the one-time reconcile seed which only mirrors pre-existing
  // UB balances into tracking.
  const econRes = await db.execute(sql`
    SELECT date_trunc('week', created_at) AS week,
           category, kind,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::bigint AS created,
           SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END)::bigint AS destroyed
    FROM wallet_transactions
    WHERE ${SETTLED}
      AND created_at >= ${since}
      AND kind NOT IN ('reconcile_seed', 'transfer', 'transfer_in', 'transfer_out')
      ${EXCLUDE}
    GROUP BY 1, 2, 3
    ORDER BY 1
  `);
  const econByWeek = new Map<string, EconomyWeek>();
  for (const r of econRes.rows as Array<{ week: Date | string; category: string | null; kind: string; created: string; destroyed: string }>) {
    const weekStart = new Date(r.week as string).toISOString();
    const cat = r.category ?? classifyWalletCategory(r.kind, null);
    if (cat === "transfer") continue;
    let w = econByWeek.get(weekStart);
    if (!w) {
      w = { weekStart, created: {}, destroyed: {} };
      econByWeek.set(weekStart, w);
    }
    const created = Number(r.created) || 0;
    const destroyed = Number(r.destroyed) || 0;
    if (created) w.created[cat] = (w.created[cat] ?? 0) + created;
    if (destroyed) w.destroyed[cat] = (w.destroyed[cat] ?? 0) + destroyed;
  }

  // ---- Economy: total money-supply trend ------------------------------------
  // Cumulative net of ALL settled player movement over all time (including the
  // reconcile seed — that is money entering tracking), sliced to the range.
  const supplyRes = await db.execute(sql`
    SELECT date_trunc('week', created_at) AS week, SUM(amount)::bigint AS net
    FROM wallet_transactions
    WHERE ${SETTLED}
      AND kind NOT IN ('transfer', 'transfer_in', 'transfer_out')
      ${EXCLUDE}
    GROUP BY 1
    ORDER BY 1
  `);
  let running = 0;
  const supplyAll: SupplyPoint[] = (supplyRes.rows as Array<{ week: Date | string; net: string }>).map((r) => {
    const net = Number(r.net) || 0;
    running += net;
    return { weekStart: new Date(r.week as string).toISOString(), net, total: running };
  });
  // Supply tracking only became meaningful at the first reconcile seed (the
  // moment existing balances entered tracking). Weeks before that hold only
  // sparse pre-launch rows near zero; including them flattens the whole chart
  // against the post-seed scale, so start the series at the seed week.
  const seedRes = await db.execute(sql`
    SELECT date_trunc('week', MIN(created_at)) AS week
    FROM wallet_transactions
    WHERE kind = 'reconcile_seed' AND ${SETTLED} ${EXCLUDE}
  `);
  const seedWeekRaw = (seedRes.rows[0] as { week: Date | string | null } | undefined)?.week;
  const seedWeek = seedWeekRaw ? new Date(seedWeekRaw as string) : null;
  const supplySince = seedWeek && seedWeek > since ? seedWeek : since;
  const supply = supplyAll.filter((p) => new Date(p.weekStart) >= supplySince);
  // Anchor the trend with the pre-range total so the first visible point
  // doesn't look like the supply started at ~0 — but only when the cut is the
  // range window. When the cut is the seed week, the dropped points are the
  // near-zero pre-tracking rows we deliberately excluded; anchoring on them
  // would reintroduce the misleading flat start.
  const anchorIsPostSeed = !seedWeek || since >= seedWeek;
  if (anchorIsPostSeed && supply.length < supplyAll.length && supplyAll.length > 0) {
    const lastBefore = supplyAll[supplyAll.length - supply.length - 1];
    supply.unshift({ weekStart: lastBefore.weekStart, net: 0, total: lastBefore.total });
  }

  // ---- Missions -------------------------------------------------------------
  const missionWeeksRes = await db.execute(sql`
    SELECT date_trunc('week', completed_at) AS week, COUNT(*)::int AS n
    FROM missions
    WHERE completed_at IS NOT NULL AND completed_at >= ${since}
    GROUP BY 1 ORDER BY 1
  `);
  const payoutWeeksRes = await db.execute(sql`
    SELECT date_trunc('week', created_at) AS week, SUM(amount)::bigint AS total,
           COALESCE(SUM(amount) FILTER (WHERE idempotency_key LIKE 'mission_payout:%'), 0)::bigint AS player_total,
           COALESCE(SUM(amount) FILTER (WHERE idempotency_key LIKE 'actor_payout:%'), 0)::bigint AS actor_total
    FROM wallet_transactions
    WHERE ${SETTLED}
      AND created_at >= ${since}
      AND amount > 0
      AND (category = 'mission' OR (category IS NULL AND kind = 'mission'))
      ${EXCLUDE}
    GROUP BY 1 ORDER BY 1
  `);
  const missionWeekMap = new Map<string, MissionWeek>();
  const weekOf = (w: Date | string) => new Date(w as string).toISOString();
  const ensureWeek = (k: string) => {
    let row = missionWeekMap.get(k);
    if (!row) {
      row = { weekStart: k, missionsRun: 0, payoutTotal: 0, playerPayout: 0, actorPayout: 0 };
      missionWeekMap.set(k, row);
    }
    return row;
  };
  for (const r of missionWeeksRes.rows as Array<{ week: Date | string; n: number }>) {
    ensureWeek(weekOf(r.week)).missionsRun = Number(r.n) || 0;
  }
  let totalPayout = 0;
  for (const r of payoutWeeksRes.rows as Array<{ week: Date | string; total: string; player_total: string; actor_total: string }>) {
    const t = Number(r.total) || 0;
    const row = ensureWeek(weekOf(r.week));
    row.payoutTotal = t;
    row.playerPayout = Number(r.player_total) || 0;
    row.actorPayout = Number(r.actor_total) || 0;
    totalPayout += t;
  }
  const missionWeekly = [...missionWeekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const totalMissions = missionWeekly.reduce((s, w) => s + w.missionsRun, 0);
  const [appsRow] = (
    await db.execute(sql`
      SELECT COUNT(*)::int AS apps
      FROM mission_applications
      WHERE created_at >= ${since}
    `)
  ).rows as Array<{ apps: number }>;
  const totalApplications = Number(appsRow?.apps) || 0;

  // ---- Review queues ---------------------------------------------------------
  // Mirrors what staff see in the unified /requests queue: "open" = awaiting a
  // reviewer decision; decided-but-not-closed tickets still need a staff close;
  // changes_requested is waiting on the submitter (tracked separately so it
  // doesn't inflate the "stalled reviews" signal).
  const queues: ReviewQueueStats[] = [];
  const pushQueue = (
    queue: string,
    label: string,
    openDates: Date[],
    decidedAwaitingClose: number,
    changesRequested: number,
  ) => {
    const { buckets, oldestDays } = bucketAges(openDates, now);
    queues.push({ queue, label, open: openDates.length, decidedAwaitingClose, changesRequested, oldestDays, ageBuckets: buckets });
  };
  const dates = (rows: Array<{ at: Date | string }>) => rows.map((r) => new Date(r.at as string));

  const [miscOpen, miscDecided, miscChanges] = await Promise.all([
    db.execute(sql`SELECT created_at AS at FROM custom_requests WHERE status = 'pending' AND type <> 'mission_participation'`),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM custom_requests WHERE status IN ('approved','rejected') AND closed_at IS NULL AND type <> 'mission_participation'`),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM custom_requests WHERE status = 'changes_requested' AND type <> 'mission_participation'`),
  ]);
  pushQueue(
    "misc",
    "Misc Requests",
    dates(miscOpen.rows as Array<{ at: string }>),
    Number((miscDecided.rows[0] as { n: number })?.n) || 0,
    Number((miscChanges.rows[0] as { n: number })?.n) || 0,
  );

  const [sheetOpen, sheetDecided, sheetChanges] = await Promise.all([
    db.execute(sql`SELECT COALESCE(submitted_at, created_at) AS at FROM character_sheets WHERE status = 'pending'`),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM character_sheets WHERE status IN ('approved','rejected') AND closed_at IS NULL`),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM character_sheets WHERE status = 'changes_requested'`),
  ]);
  pushQueue(
    "sheets",
    "Character Sheets",
    dates(sheetOpen.rows as Array<{ at: string }>),
    Number((sheetDecided.rows[0] as { n: number })?.n) || 0,
    Number((sheetChanges.rows[0] as { n: number })?.n) || 0,
  );

  const [editOpen, editDecided, editChanges] = await Promise.all([
    db.execute(sql`SELECT submitted_at AS at FROM pending_character_edits WHERE status = 'pending'`),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM pending_character_edits WHERE status IN ('approved','rejected') AND closed_at IS NULL`),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM pending_character_edits WHERE status = 'changes_requested'`),
  ]);
  pushQueue(
    "edits",
    "Character Edits",
    dates(editOpen.rows as Array<{ at: string }>),
    Number((editDecided.rows[0] as { n: number })?.n) || 0,
    Number((editChanges.rows[0] as { n: number })?.n) || 0,
  );

  const [loreOpen, guideOpen] = await Promise.all([
    db.execute(sql`SELECT created_at AS at FROM lore_pending_edits WHERE status = 'pending'`),
    db.execute(sql`SELECT created_at AS at FROM guidebook_pending_edits WHERE status = 'pending'`),
  ]);
  pushQueue("lore", "Lore", dates(loreOpen.rows as Array<{ at: string }>), 0, 0);
  pushQueue("guidebook", "Guidebook", dates(guideOpen.rows as Array<{ at: string }>), 0, 0);

  // ---- Players ----------------------------------------------------------------
  const lifeRes = await db.execute(sql`
    SELECT life_status, COUNT(*)::int AS n
    FROM characters
    WHERE kind = 'pc' AND archived = false
    GROUP BY 1
  `);
  const lifeStatus: Record<string, number> = {};
  for (const r of lifeRes.rows as Array<{ life_status: string; n: number }>) {
    lifeStatus[r.life_status] = Number(r.n) || 0;
  }

  // Active vs dormant among life-status-active PCs: any wallet movement,
  // mission application, or assignment touching the character in the last
  // 60 days counts as active.
  const cutoff = new Date(now.getTime() - 60 * 86_400_000);
  const [activityRow] = (
    await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE recent)::int AS active,
        COUNT(*) FILTER (WHERE NOT recent)::int AS dormant
      FROM (
        SELECT c.id,
          EXISTS (SELECT 1 FROM wallet_transactions wt WHERE wt.character_id = c.id AND wt.created_at >= ${cutoff})
          OR EXISTS (SELECT 1 FROM mission_applications ma WHERE ma.character_id = c.id AND ma.created_at >= ${cutoff})
          OR EXISTS (SELECT 1 FROM mission_assignments s WHERE s.character_id = c.id AND s.created_at >= ${cutoff})
          AS recent
        FROM characters c
        WHERE c.kind = 'pc' AND c.archived = false AND c.life_status = 'active'
      ) t
    `)
  ).rows as Array<{ active: number; dormant: number }>;

  // Weekly Active(60d)/Dormant trend from the character_snapshot job's rows.
  // gained = active this week but not (or absent) the prior week; lost = the
  // reverse. Only life-status-active PCs count, matching the live cards.
  const trendRes = await db.execute(sql`
    SELECT s.week_start AS week,
           COUNT(*) FILTER (WHERE s.active AND s.life_status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE NOT s.active AND s.life_status = 'active')::int AS dormant,
           COUNT(*) FILTER (WHERE s.active AND s.life_status = 'active' AND COALESCE(p.active, false) = false)::int AS gained,
           COUNT(*) FILTER (WHERE NOT s.active AND s.life_status = 'active' AND p.active)::int AS lost
    FROM character_week_snapshots s
    LEFT JOIN character_week_snapshots p
      ON p.character_id = s.character_id AND p.week_start = s.week_start - 7
    WHERE s.week_start >= ${since.toISOString().slice(0, 10)}::date
    GROUP BY 1 ORDER BY 1
  `);
  const activityTrend: ActivityTrendWeek[] = (
    trendRes.rows as Array<{ week: Date | string; active: number; dormant: number; gained: number; lost: number }>
  ).map((r) => ({
    weekStart: new Date(r.week as string).toISOString(),
    active: Number(r.active) || 0,
    dormant: Number(r.dormant) || 0,
    gained: Number(r.gained) || 0,
    lost: Number(r.lost) || 0,
  }));

  // New sheets per month over the last 12 months regardless of range — a
  // monthly series shorter than ~3 points isn't readable.
  const monthsSince = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const sheetsRes = await db.execute(sql`
    SELECT date_trunc('month', COALESCE(submitted_at, created_at)) AS month, COUNT(*)::int AS n
    FROM character_sheets
    WHERE status <> 'draft' AND COALESCE(submitted_at, created_at) >= ${monthsSince}
    GROUP BY 1 ORDER BY 1
  `);

  // ---- Website activity -------------------------------------------------------
  // Weekly series measuring whether portal usage is trending up or down.
  // Hits/logins/active-users come from site_activity_daily, which only exists
  // from the day tracking shipped (trackingSince tells the UI where the series
  // genuinely starts). Characters created and character edits come from their
  // own tables, so those series have full history.
  const [siteWeeklyRes, siteTotalsRes, charWeeklyRes, editWeeklyRes] = await Promise.all([
    db.execute(sql`
      SELECT date_trunc('week', day::timestamptz) AS week,
             COUNT(DISTINCT user_id)::int AS active_users,
             COALESCE(SUM(hits), 0)::bigint AS hits,
             COALESCE(SUM(logins), 0)::int AS logins
      FROM site_activity_daily
      WHERE day >= ${since.toISOString().slice(0, 10)}
      GROUP BY 1 ORDER BY 1
    `),
    db.execute(sql`
      SELECT COUNT(DISTINCT user_id) FILTER (WHERE day >= ${since.toISOString().slice(0, 10)})::int AS active_users,
             COALESCE(SUM(logins) FILTER (WHERE day >= ${since.toISOString().slice(0, 10)}), 0)::int AS logins,
             MIN(day)::text AS first_day
      FROM site_activity_daily
    `),
    db.execute(sql`
      SELECT date_trunc('week', created_at) AS week, COUNT(*)::int AS n
      FROM characters
      WHERE kind = 'pc' AND created_at >= ${since}
        -- Exclude thread-imported characters: the 2026-05-24 bulk import
        -- created hundreds of rows in one week, which dwarfs the organic
        -- "characters created" signal this chart is meant to show.
        AND imported_from_thread_id IS NULL
      GROUP BY 1 ORDER BY 1
    `),
    db.execute(sql`
      SELECT date_trunc('week', submitted_at) AS week, COUNT(*)::int AS n
      FROM pending_character_edits
      WHERE submitted_at >= ${since}
      GROUP BY 1 ORDER BY 1
    `),
  ]);
  const siteByWeek = new Map<string, SiteWeek>();
  const siteWeek = (weekStart: string): SiteWeek => {
    let w = siteByWeek.get(weekStart);
    if (!w) {
      w = { weekStart, activeUsers: 0, pageHits: 0, logins: 0, charactersCreated: 0, characterEdits: 0 };
      siteByWeek.set(weekStart, w);
    }
    return w;
  };
  for (const r of siteWeeklyRes.rows as Array<{ week: Date | string; active_users: number; hits: string; logins: number }>) {
    const w = siteWeek(new Date(r.week as string).toISOString());
    w.activeUsers = Number(r.active_users) || 0;
    w.pageHits = Number(r.hits) || 0;
    w.logins = Number(r.logins) || 0;
  }
  let totalCharactersCreated = 0;
  for (const r of charWeeklyRes.rows as Array<{ week: Date | string; n: number }>) {
    const n = Number(r.n) || 0;
    siteWeek(new Date(r.week as string).toISOString()).charactersCreated = n;
    totalCharactersCreated += n;
  }
  let totalCharacterEdits = 0;
  for (const r of editWeeklyRes.rows as Array<{ week: Date | string; n: number }>) {
    const n = Number(r.n) || 0;
    siteWeek(new Date(r.week as string).toISOString()).characterEdits = n;
    totalCharacterEdits += n;
  }
  const siteTotals = siteTotalsRes.rows[0] as
    | { active_users: number; logins: number; first_day: string | null }
    | undefined;
  const site: SiteStats = {
    weekly: [...siteByWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    totalActiveUsers: Number(siteTotals?.active_users) || 0,
    totalLogins: Number(siteTotals?.logins) || 0,
    totalCharactersCreated,
    totalCharacterEdits,
    trackingSince: siteTotals?.first_day ?? null,
  };

  // ---- VRChat instance sessions ---------------------------------------------
  // Session history written by the group-instance poller (plus VRCX-imported
  // rows). Durations use COALESCE(closed_at, last_seen_at) so still-open
  // sessions count their elapsed time without inflating by the poll gap.
  const vrDur = sql`EXTRACT(EPOCH FROM (COALESCE(closed_at, last_seen_at) - first_seen_at))`;
  const [vrWeeklyRes, vrTotalsRes, vrTopRes] = await Promise.all([
    db.execute(sql`
      SELECT date_trunc('week', first_seen_at) AS week,
             COUNT(*)::int AS sessions,
             COALESCE(SUM(${vrDur}), 0)::float8 AS seconds
      FROM vrchat_instance_sessions
      WHERE first_seen_at >= ${since}
      GROUP BY 1 ORDER BY 1
    `),
    db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE first_seen_at >= ${since})::int AS sessions,
             COALESCE(SUM(${vrDur}) FILTER (WHERE first_seen_at >= ${since}), 0)::float8 AS seconds,
             COALESCE(MAX(peak_user_count) FILTER (WHERE first_seen_at >= ${since}), 0)::int AS peak,
             COUNT(*) FILTER (WHERE closed_at IS NULL AND source = 'live')::int AS open_now
      FROM vrchat_instance_sessions
    `),
    db.execute(sql`
      SELECT world_name,
             COUNT(*)::int AS sessions,
             COALESCE(SUM(${vrDur}), 0)::float8 AS seconds,
             COALESCE(MAX(peak_user_count), 0)::int AS peak
      FROM vrchat_instance_sessions
      WHERE first_seen_at >= ${since}
      GROUP BY 1 ORDER BY SUM(${vrDur}) DESC NULLS LAST LIMIT 8
    `),
  ]);
  const hoursOf = (seconds: unknown) => Math.round(((Number(seconds) || 0) / 3600) * 10) / 10;
  const vrTotals = vrTotalsRes.rows[0] as
    | { sessions: number; seconds: string; peak: number; open_now: number }
    | undefined;
  const vrTotalSessions = Number(vrTotals?.sessions) || 0;
  const vrTotalSeconds = Number(vrTotals?.seconds) || 0;
  const vrchat: VrchatStats = {
    weekly: (vrWeeklyRes.rows as Array<{ week: Date | string; sessions: number; seconds: string }>).map((r) => ({
      weekStart: new Date(r.week as string).toISOString(),
      sessions: Number(r.sessions) || 0,
      hours: hoursOf(r.seconds),
    })),
    totalSessions: vrTotalSessions,
    totalHours: hoursOf(vrTotalSeconds),
    avgDurationMinutes: vrTotalSessions > 0 ? Math.round(vrTotalSeconds / vrTotalSessions / 60) : 0,
    peakUserCount: Number(vrTotals?.peak) || 0,
    openNow: Number(vrTotals?.open_now) || 0,
    topWorlds: (vrTopRes.rows as Array<{ world_name: string; sessions: number; seconds: string; peak: number }>).map((r) => ({
      worldName: r.world_name,
      sessions: Number(r.sessions) || 0,
      hours: hoursOf(r.seconds),
      peakUserCount: Number(r.peak) || 0,
    })),
  };

  return {
    range,
    since: since.toISOString(),
    excludeAbove,
    excludedWallets,
    economy: {
      weekly: [...econByWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
      supply,
    },
    missions: {
      weekly: missionWeekly,
      totalMissions,
      totalApplications,
      avgApplicationsPerMission: totalMissions > 0 ? Math.round((totalApplications / totalMissions) * 10) / 10 : 0,
      totalPayout,
    },
    reviews: queues,
    players: {
      lifeStatus,
      activeRecent: Number(activityRow?.active) || 0,
      dormant: Number(activityRow?.dormant) || 0,
      sheetsPerMonth: (sheetsRes.rows as Array<{ month: Date | string; n: number }>).map((r) => ({
        month: new Date(r.month as string).toISOString(),
        count: Number(r.n) || 0,
      })),
      activityTrend,
    },
    vrchat,
    site,
  };
}

// ---------------------------------------------------------------------------
// Drill-downs — per-week / per-world detail behind the aggregate charts.
// ---------------------------------------------------------------------------

function parseWeekParam(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
export { parseWeekParam };

export interface CharacterTrendEntry {
  id: number;
  name: string;
  ownerName: string | null;
}

// Which characters were gained (dormant/absent -> active) or lost
// (active -> dormant) in the given snapshot week, vs the prior week.
// Mirrors the activityTrend gained/lost counters exactly.
export async function computeCharacterTrendWeek(week: Date): Promise<{
  weekStart: string;
  gained: CharacterTrendEntry[];
  lost: CharacterTrendEntry[];
}> {
  const weekDate = week.toISOString().slice(0, 10);
  const res = await db.execute(sql`
    SELECT c.id, c.name, COALESCE(u.global_name, u.username) AS owner_name,
           s.active AS now_active
    FROM character_week_snapshots s
    JOIN characters c ON c.id = s.character_id
    LEFT JOIN users u ON u.id = c.owner_id
    LEFT JOIN character_week_snapshots p
      ON p.character_id = s.character_id AND p.week_start = s.week_start - 7
    WHERE s.week_start = date_trunc('week', ${weekDate}::date)::date
      AND s.life_status = 'active'
      AND ((s.active AND COALESCE(p.active, false) = false)
        OR (NOT s.active AND p.active))
    ORDER BY lower(c.name)
  `);
  const gained: CharacterTrendEntry[] = [];
  const lost: CharacterTrendEntry[] = [];
  for (const r of res.rows as Array<{ id: number; name: string; owner_name: string | null; now_active: boolean }>) {
    (r.now_active ? gained : lost).push({ id: Number(r.id), name: r.name, ownerName: r.owner_name });
  }
  return { weekStart: weekDate, gained, lost };
}

export interface VrchatInstanceDetail {
  id: number;
  worldName: string;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  durationMinutes: number;
  peakUserCount: number;
  avgUserCount: number;
  medianUserCount: number;
  uniqueUsers: number | null;
  samples: Array<{ at: string; userCount: number }>;
}

// Per-instance sessions behind one weekly bar (week) or one top-world row
// (world + since). Median comes from the raw poll samples; the population
// sparkline is the sample series downsampled to <= 60 points per instance.
export async function computeVrchatInstanceDrilldown(opts: {
  week?: Date;
  world?: string;
  since?: Date;
}): Promise<VrchatInstanceDetail[]> {
  const where = opts.week
    ? sql`date_trunc('week', s.first_seen_at) = date_trunc('week', ${opts.week}::timestamptz)`
    : sql`s.world_name = ${opts.world ?? ""} AND s.first_seen_at >= ${opts.since ?? new Date(0)}`;
  const res = await db.execute(sql`
    SELECT s.id, s.world_name, s.source, s.first_seen_at, s.last_seen_at, s.closed_at,
           s.peak_user_count, s.unique_users,
           EXTRACT(EPOCH FROM (COALESCE(s.closed_at, s.last_seen_at) - s.first_seen_at))::float8 AS seconds,
           CASE WHEN s.sample_count > 0 THEN s.sum_user_counts::float8 / s.sample_count ELSE 0 END AS avg_users,
           COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sm.user_count)
                     FROM vrchat_instance_samples sm WHERE sm.session_id = s.id), 0)::float8 AS median_users
    FROM vrchat_instance_sessions s
    WHERE ${where}
    ORDER BY s.first_seen_at DESC
  `);
  const rows = res.rows as Array<{
    id: number; world_name: string; source: string;
    first_seen_at: Date | string; last_seen_at: Date | string; closed_at: Date | string | null;
    peak_user_count: number; unique_users: number | null;
    seconds: number; avg_users: number; median_users: number;
  }>;
  const ids = rows.map((r) => Number(r.id));
  const samplesBySession = new Map<number, Array<{ at: string; userCount: number }>>();
  if (ids.length > 0) {
    const sampleRes = await db.execute(sql`
      SELECT session_id, at, user_count FROM vrchat_instance_samples
      WHERE session_id = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::int[]`})
      ORDER BY session_id, at
    `);
    for (const r of sampleRes.rows as Array<{ session_id: number; at: Date | string; user_count: number }>) {
      const sid = Number(r.session_id);
      let arr = samplesBySession.get(sid);
      if (!arr) {
        arr = [];
        samplesBySession.set(sid, arr);
      }
      arr.push({ at: new Date(r.at as string).toISOString(), userCount: Number(r.user_count) || 0 });
    }
    // Downsample long series to <= 60 points, always keeping the last point.
    for (const [sid, arr] of samplesBySession) {
      if (arr.length > 60) {
        const step = Math.ceil(arr.length / 60);
        const thin = arr.filter((_, i) => i % step === 0);
        if (thin[thin.length - 1] !== arr[arr.length - 1]) thin.push(arr[arr.length - 1]);
        samplesBySession.set(sid, thin);
      }
    }
  }
  return rows.map((r) => ({
    id: Number(r.id),
    worldName: r.world_name,
    source: r.source,
    firstSeenAt: new Date(r.first_seen_at as string).toISOString(),
    lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at as string).toISOString() : null,
    durationMinutes: Math.round((Number(r.seconds) || 0) / 60),
    peakUserCount: Number(r.peak_user_count) || 0,
    avgUserCount: Math.round((Number(r.avg_users) || 0) * 10) / 10,
    medianUserCount: Math.round((Number(r.median_users) || 0) * 10) / 10,
    uniqueUsers: r.unique_users === null ? null : Number(r.unique_users),
    samples: samplesBySession.get(Number(r.id)) ?? [],
  }));
}

export interface MissionWeekDetail {
  weekStart: string;
  // Chart-parity totals: mission-category ledger rows CREATED in this week,
  // split player vs actor (legacy rows fall in neither bucket).
  totalPayout: number;
  playerPayout: number;
  actorPayout: number;
  missions: Array<{
    id: number;
    title: string;
    status: string;
    completedAt: string | null;
    fixerName: string | null;
    participants: number;
    // Per-mission all-time payout split (whenever the money actually moved).
    playerPayout: number;
    actorPayout: number;
  }>;
}

// The missions behind one weekly bar: missions COMPLETED in that week, each
// with its payout split, plus the week's transaction-dated totals so the
// header matches the chart bar exactly (payouts can land in a different week
// than completion).
export async function computeMissionsWeekDrilldown(week: Date): Promise<MissionWeekDetail> {
  const [missionsRes, totalsRes] = await Promise.all([
    db.execute(sql`
      SELECT m.id, m.title, m.status, m.completed_at,
             COALESCE(u.global_name, u.username) AS fixer_name,
             (SELECT COUNT(*)::int FROM mission_assignments a WHERE a.mission_id = m.id) AS participants,
             COALESCE((SELECT SUM(wt.amount) FROM wallet_transactions wt
                       WHERE wt.related_entity_type = 'mission' AND wt.related_entity_id = m.id
                         AND wt.sync_status IN ('synced','reconciled') AND wt.amount > 0
                         AND wt.idempotency_key LIKE 'mission_payout:%'), 0)::bigint AS player_payout,
             COALESCE((SELECT SUM(wt.amount) FROM wallet_transactions wt
                       WHERE wt.related_entity_type = 'mission' AND wt.related_entity_id = m.id
                         AND wt.sync_status IN ('synced','reconciled') AND wt.amount > 0
                         AND wt.idempotency_key LIKE 'actor_payout:%'), 0)::bigint AS actor_payout
      FROM missions m
      LEFT JOIN users u ON u.id = m.fixer_id
      WHERE m.completed_at IS NOT NULL
        AND date_trunc('week', m.completed_at) = date_trunc('week', ${week}::timestamptz)
      ORDER BY m.completed_at DESC
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::bigint AS total,
             COALESCE(SUM(amount) FILTER (WHERE idempotency_key LIKE 'mission_payout:%'), 0)::bigint AS player_total,
             COALESCE(SUM(amount) FILTER (WHERE idempotency_key LIKE 'actor_payout:%'), 0)::bigint AS actor_total
      FROM wallet_transactions
      WHERE ${SETTLED}
        AND amount > 0
        AND (category = 'mission' OR (category IS NULL AND kind = 'mission'))
        AND date_trunc('week', created_at) = date_trunc('week', ${week}::timestamptz)
    `),
  ]);
  const totals = totalsRes.rows[0] as { total: string; player_total: string; actor_total: string } | undefined;
  return {
    weekStart: week.toISOString(),
    totalPayout: Number(totals?.total) || 0,
    playerPayout: Number(totals?.player_total) || 0,
    actorPayout: Number(totals?.actor_total) || 0,
    missions: (missionsRes.rows as Array<{
      id: number; title: string; status: string; completed_at: Date | string | null;
      fixer_name: string | null; participants: number; player_payout: string; actor_payout: string;
    }>).map((m) => ({
      id: Number(m.id),
      title: m.title,
      status: m.status,
      completedAt: m.completed_at ? new Date(m.completed_at as string).toISOString() : null,
      fixerName: m.fixer_name,
      participants: Number(m.participants) || 0,
      playerPayout: Number(m.player_payout) || 0,
      actorPayout: Number(m.actor_payout) || 0,
    })),
  };
}

export interface EconomyTransactionEntry {
  id: number;
  createdAt: string;
  amount: number;
  kind: string;
  category: string;
  memo: string | null;
  userName: string | null;
  characterName: string | null;
}

// The raw settled transactions behind one economy-chart cell: week + category
// + direction (created = money in, destroyed = money out). Applies the SAME
// settled/transfer/whale filters as the weekly aggregate so the listed rows
// sum exactly to the chart bar segment. Null-category rows are classified in
// JS with the shared classifier, mirroring the aggregate path. Capped at 500
// rows (largest first) — `truncated` tells the UI when a cap hit.
export async function computeEconomyWeekTransactions(opts: {
  week: Date;
  category: string;
  direction: "created" | "destroyed";
  excludeAbove: number | null;
}): Promise<{ transactions: EconomyTransactionEntry[]; total: number; truncated: boolean }> {
  const WHALES = sql`
    SELECT user_id FROM wallet_transactions
    WHERE ${SETTLED}
    GROUP BY user_id
    HAVING SUM(amount) > ${opts.excludeAbove ?? 0}
  `;
  const EXCLUDE = opts.excludeAbove === null ? sql`` : sql`AND wt.user_id NOT IN (${WHALES})`;
  const amountCond = opts.direction === "created" ? sql`wt.amount > 0` : sql`wt.amount < 0`;
  const res = await db.execute(sql`
    SELECT wt.id, wt.created_at, wt.amount, wt.kind, wt.category, wt.memo,
           COALESCE(u.global_name, u.username) AS user_name,
           c.name AS character_name
    FROM wallet_transactions wt
    LEFT JOIN users u ON u.id = wt.user_id
    LEFT JOIN characters c ON c.id = wt.character_id
    WHERE wt.sync_status IN ('synced', 'reconciled') AND wt.user_id IS NOT NULL
      AND wt.kind NOT IN ('reconcile_seed', 'transfer', 'transfer_in', 'transfer_out')
      AND date_trunc('week', wt.created_at) = date_trunc('week', ${opts.week}::timestamptz)
      AND ${amountCond}
      ${EXCLUDE}
    ORDER BY ABS(wt.amount) DESC, wt.created_at DESC
  `);
  const all = (res.rows as Array<{
    id: number; created_at: Date | string; amount: string; kind: string;
    category: string | null; memo: string | null; user_name: string | null; character_name: string | null;
  }>)
    .map((r) => ({
      id: Number(r.id),
      createdAt: new Date(r.created_at as string).toISOString(),
      amount: Number(r.amount) || 0,
      kind: r.kind,
      category: r.category ?? classifyWalletCategory(r.kind, null),
      memo: r.memo,
      userName: r.user_name,
      characterName: r.character_name,
    }))
    .filter((r) => r.category === opts.category);
  const total = all.reduce((s, r) => s + Math.abs(r.amount), 0);
  return { transactions: all.slice(0, 500), total, truncated: all.length > 500 };
}
