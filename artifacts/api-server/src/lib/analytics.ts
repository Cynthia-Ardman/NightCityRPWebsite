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
  };
  vrchat: VrchatStats;
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
    SELECT date_trunc('week', created_at) AS week, SUM(amount)::bigint AS total
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
      row = { weekStart: k, missionsRun: 0, payoutTotal: 0 };
      missionWeekMap.set(k, row);
    }
    return row;
  };
  for (const r of missionWeeksRes.rows as Array<{ week: Date | string; n: number }>) {
    ensureWeek(weekOf(r.week)).missionsRun = Number(r.n) || 0;
  }
  let totalPayout = 0;
  for (const r of payoutWeeksRes.rows as Array<{ week: Date | string; total: string }>) {
    const t = Number(r.total) || 0;
    ensureWeek(weekOf(r.week)).payoutTotal = t;
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

  // New sheets per month over the last 12 months regardless of range — a
  // monthly series shorter than ~3 points isn't readable.
  const monthsSince = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const sheetsRes = await db.execute(sql`
    SELECT date_trunc('month', COALESCE(submitted_at, created_at)) AS month, COUNT(*)::int AS n
    FROM character_sheets
    WHERE status <> 'draft' AND COALESCE(submitted_at, created_at) >= ${monthsSince}
    GROUP BY 1 ORDER BY 1
  `);

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
    },
    vrchat,
  };
}
