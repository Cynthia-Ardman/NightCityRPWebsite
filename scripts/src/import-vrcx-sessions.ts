/**
 * Import historical VRChat instance sessions from a VRCX gamelog export.
 *
 * Input: CSV with columns id,created_at,type,display_name,location,user_id,time
 * (VRCX gamelog_join_leave with location included). Reconstructs one session
 * row per instance lifetime by replaying join/leave events per location:
 *   - firstSeenAt / lastSeenAt / closedAt from event timestamps
 *   - peakUserCount + time-weighted average concurrency (sumUserCounts/sampleCount)
 *   - uniqueUsers = distinct user_ids (only knowable from VRCX data)
 *   - per-event occupancy samples into vrchat_instance_samples
 * Rows are inserted with source='vrcx' so they never collide with the live
 * poller's partial unique index.
 *
 * Idempotent: deletes ALL existing source='vrcx' sessions (samples cascade)
 * and re-inserts — a full re-import. Live rows are never touched.
 *
 * World names: resolved from existing session rows in the target DB, then via
 * the VRChat API using the auth cookie stored in vrchat_sessions (best-effort);
 * falls back to the raw world id.
 *
 * Usage:
 *   pnpm tsx scripts/src/import-vrcx-sessions.ts --file=attached_assets/foo.csv
 *   IMPORT_TARGET=prod pnpm tsx scripts/src/import-vrcx-sessions.ts --file=... --target=live
 */
import fs from "node:fs";
import pg from "pg";

const GROUP_ID = process.env.VRCHAT_GROUP_ID ?? "grp_667e7e40-7ea9-4142-a81e-5939c18c990f";
// A location string can be reused by a later instance; if the same location is
// quiet for longer than this, treat the next event as a NEW session.
const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

// --- args ---------------------------------------------------------------
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1], m[2]);
}
const filePath = args.get("file");
const target = args.get("target") ?? "dev";
if (!filePath) {
  console.error("usage: --file=path/to/export.csv [--target=dev|live]");
  process.exit(1);
}

function targetUrl(): string {
  if (target === "live") {
    const url = process.env.LIVE_PROD_DATABASE_URL;
    if (!url) {
      console.error("LIVE_PROD_DATABASE_URL not set");
      process.exit(1);
    }
    if (process.env.IMPORT_TARGET !== "prod") {
      console.error("refusing to write to live DB without IMPORT_TARGET=prod");
      process.exit(1);
    }
    return url;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  if (!/helium/.test(url) && process.env.IMPORT_TARGET !== "prod") {
    console.error("DATABASE_URL does not look like the dev (helium) DB; refusing without IMPORT_TARGET=prod");
    process.exit(1);
  }
  return url;
}

// --- tiny RFC4180 CSV parser (values may contain commas/quotes/newlines) ---
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

// --- location parsing (mirrors api-server parseLocation semantics) --------
function parseLocation(location: string): {
  worldId: string;
  accessType: string;
  region: string | null;
} {
  const [worldId, rest = ""] = location.split(":");
  const has = (token: string) => rest.includes(`~${token}(`);
  const grab = (token: string): string | null => {
    const m = new RegExp(`~${token}\\(([^)]*)\\)`).exec(rest);
    return m ? m[1] : null;
  };
  let accessType = "unknown";
  if (has("group")) {
    const gat = (grab("groupAccessType") ?? "").toLowerCase();
    accessType =
      gat === "public" ? "group_public" : gat === "plus" ? "group_plus" : "group_members";
  } else if (has("hidden")) accessType = "invite_plus";
  else if (has("friends")) accessType = "friends_plus";
  else if (has("private")) accessType = "invite";
  else if (rest && !rest.includes("~")) accessType = "public";
  return { worldId, accessType, region: grab("region") };
}

// --- sessionization -------------------------------------------------------
interface Ev {
  at: number;
  join: boolean;
  userId: string;
}
interface Session {
  location: string;
  worldId: string;
  accessType: string;
  region: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  peak: number;
  sampleCount: number;
  sumUserCounts: number;
  uniqueUsers: number;
  samples: Array<{ at: Date; userCount: number }>;
}

function buildSessions(location: string, events: Ev[]): Session[] {
  events.sort((a, b) => a.at - b.at || (a.join === b.join ? 0 : a.join ? 1 : -1));
  const chunks: Ev[][] = [];
  let cur: Ev[] = [];
  for (const e of events) {
    if (cur.length > 0 && e.at - cur[cur.length - 1].at > SESSION_GAP_MS) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(e);
  }
  if (cur.length > 0) chunks.push(cur);

  const parsed = parseLocation(location);
  return chunks.map((evs) => {
    const present = new Set<string>();
    const unique = new Set<string>();
    let peak = 0;
    // Time-weighted average concurrency: integrate headcount over the gaps
    // between consecutive events.
    let integralMs = 0;
    let prevAt = evs[0].at;
    const samples: Array<{ at: Date; userCount: number }> = [];
    for (const e of evs) {
      integralMs += present.size * (e.at - prevAt);
      prevAt = e.at;
      if (e.join) {
        present.add(e.userId);
        unique.add(e.userId);
      } else present.delete(e.userId);
      peak = Math.max(peak, present.size);
      samples.push({ at: new Date(e.at), userCount: present.size });
    }
    const durationMs = evs[evs.length - 1].at - evs[0].at;
    const avg = durationMs > 0 ? integralMs / durationMs : peak;
    const sampleCount = evs.length;
    return {
      location,
      worldId: parsed.worldId,
      accessType: parsed.accessType,
      region: parsed.region,
      firstSeenAt: new Date(evs[0].at),
      lastSeenAt: new Date(evs[evs.length - 1].at),
      peak,
      sampleCount,
      sumUserCounts: Math.round(avg * sampleCount),
      uniqueUsers: unique.size,
      samples,
    };
  });
}

// --- world-name resolution --------------------------------------------------
async function resolveWorldNames(
  client: pg.Client,
  worldIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const { rows } = await client.query<{ world_id: string; world_name: string }>(
    `SELECT DISTINCT ON (world_id) world_id, world_name
     FROM vrchat_instance_sessions
     WHERE world_id = ANY($1) AND world_name <> world_id
     ORDER BY world_id, last_seen_at DESC`,
    [worldIds],
  );
  for (const r of rows) names.set(r.world_id, r.world_name);
  // Also try the live instance cache if present.
  try {
    const { rows: cache } = await client.query<{ world_id: string; world_name: string }>(
      `SELECT DISTINCT ON (world_id) world_id, world_name FROM vrchat_instances
       WHERE world_id = ANY($1) ORDER BY world_id`,
      [worldIds],
    );
    for (const r of cache) if (!names.has(r.world_id)) names.set(r.world_id, r.world_name);
  } catch {
    /* table may not exist */
  }

  const missing = worldIds.filter((w) => !names.has(w));
  if (missing.length === 0) return names;

  // Best-effort VRChat API lookups. The /worlds/:id endpoint is publicly
  // readable; attach the stored auth cookie if one exists (harmless either way).
  let cookie = "";
  try {
    const { rows: sess } = await client.query<{ auth_cookie: string | null; two_factor_cookie: string | null }>(
      `SELECT auth_cookie, two_factor_cookie FROM vrchat_sessions LIMIT 1`,
    );
    cookie = [
      sess[0]?.auth_cookie ? `auth=${sess[0].auth_cookie}` : "",
      sess[0]?.two_factor_cookie ? `twoFactorAuth=${sess[0].two_factor_cookie}` : "",
    ]
      .filter(Boolean)
      .join("; ");
  } catch {
    /* table may not exist */
  }
  const contact =
    process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "night-city-rp";
  let fetched = 0;
  const lookup = async (worldId: string) => {
    try {
      const res = await fetch(`https://api.vrchat.cloud/api/1/worlds/${worldId}`, {
        headers: {
          "User-Agent": `NightCityRP-Portal/1.0 (${contact})`,
          Accept: "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { name?: string };
        if (body?.name) {
          names.set(worldId, body.name);
          fetched++;
        }
      }
    } catch {
      /* skip */
    }
  };
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(missing.slice(i, i + 8).map(lookup));
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`world names: ${names.size - fetched} from DB, ${fetched} from VRChat API, ${worldIds.length - names.size} unresolved`);
  return names;
}

// --- main --------------------------------------------------------------------
async function main() {
  const text = fs.readFileSync(filePath!, "utf8");
  const rows = parseCsv(text);
  const header = rows[0];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column ${name}`);
    return i;
  };
  const cAt = col("created_at");
  const cType = col("type");
  const cLoc = col("location");
  const cUser = col("user_id");

  const byLocation = new Map<string, Ev[]>();
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const loc = r[cLoc];
    if (!loc || !loc.includes(`~group(${GROUP_ID})`)) {
      skipped++;
      continue;
    }
    const type = r[cType];
    if (type !== "OnPlayerJoined" && type !== "OnPlayerLeft") {
      skipped++;
      continue;
    }
    const at = Date.parse(r[cAt]);
    if (!Number.isFinite(at)) {
      skipped++;
      continue;
    }
    let evs = byLocation.get(loc);
    if (!evs) byLocation.set(loc, (evs = []));
    evs.push({ at, join: type === "OnPlayerJoined", userId: r[cUser] });
  }
  console.log(`events: ${rows.length - 1} rows, ${skipped} skipped, ${byLocation.size} locations`);

  const sessions: Session[] = [];
  for (const [loc, evs] of byLocation) sessions.push(...buildSessions(loc, evs));
  sessions.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
  console.log(`reconstructed ${sessions.length} sessions`);

  const client = new pg.Client({ connectionString: targetUrl() });
  await client.connect();
  console.log(`connected to ${target} DB`);
  try {
    const worldIds = [...new Set(sessions.map((s) => s.worldId))];
    const names = await resolveWorldNames(client, worldIds);

    await client.query("BEGIN");
    const del = await client.query(`DELETE FROM vrchat_instance_sessions WHERE source = 'vrcx'`);
    console.log(`deleted ${del.rowCount} prior vrcx sessions`);

    let inserted = 0;
    let sampleRows = 0;
    for (const s of sessions) {
      const { rows: ins } = await client.query<{ id: number }>(
        `INSERT INTO vrchat_instance_sessions
           (location, world_id, world_name, access_type, region, source,
            first_seen_at, last_seen_at, closed_at,
            peak_user_count, sample_count, sum_user_counts, unique_users)
         VALUES ($1,$2,$3,$4,$5,'vrcx',$6,$7,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          s.location,
          s.worldId,
          names.get(s.worldId) ?? s.worldId,
          s.accessType,
          s.region,
          s.firstSeenAt,
          s.lastSeenAt,
          s.peak,
          s.sampleCount,
          s.sumUserCounts,
          s.uniqueUsers,
        ],
      );
      const sessionId = ins[0].id;
      inserted++;
      // Bulk insert samples for this session via unnest.
      const ats = s.samples.map((x) => x.at.toISOString());
      const counts = s.samples.map((x) => x.userCount);
      await client.query(
        `INSERT INTO vrchat_instance_samples (session_id, at, user_count)
         SELECT $1, x.at, x.c FROM unnest($2::timestamptz[], $3::int[]) AS x(at, c)`,
        [sessionId, ats, counts],
      );
      sampleRows += s.samples.length;
    }
    await client.query("COMMIT");
    console.log(`inserted ${inserted} sessions, ${sampleRows} samples`);

    const { rows: summary } = await client.query(
      `SELECT source, COUNT(*)::int AS n,
              MIN(first_seen_at) AS earliest, MAX(last_seen_at) AS latest,
              SUM(EXTRACT(EPOCH FROM (COALESCE(closed_at, last_seen_at) - first_seen_at)) / 3600)::numeric(10,1) AS hours
       FROM vrchat_instance_sessions GROUP BY source ORDER BY source`,
    );
    console.table(summary);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("import failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
