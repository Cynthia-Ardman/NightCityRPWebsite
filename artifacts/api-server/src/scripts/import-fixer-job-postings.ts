// One-off importer: backfill historical missions from the Discord forum
// channel #fixer-job-postings (1353888179882561598) into the missions table,
// attributed to the posting fixer (thread owner) and dated from the thread.
//
// Read-only against Discord (thread list + OP message fetches). Never touches
// wallets, payouts, or writes anything back to Discord.
//
// Usage (from repo root):
//   MISSION_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/import-fixer-job-postings.ts
//   MISSION_IMPORT_TARGET=dev  MISSION_IMPORT_APPLY=1 pnpm --filter @workspace/api-server exec tsx src/scripts/import-fixer-job-postings.ts
//   MISSION_IMPORT_TARGET=prod MISSION_IMPORT_APPLY=1 pnpm --filter @workspace/api-server exec tsx src/scripts/import-fixer-job-postings.ts
//
// Defaults to DRY-RUN (report only) unless MISSION_IMPORT_APPLY=1. Targeting
// prod requires LIVE_PROD_DATABASE_URL and is refused otherwise.
//
// Idempotency: keyed on missions.discord_thread_id; a second run updates
// nothing new. Existing missions matching a thread by normalized title are
// LINKED (discord_thread_id set + NULL/default fields backfilled), never
// duplicated and never overwritten where they already have data.

export {};

const target = (process.env.MISSION_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("MISSION_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target !== "dev") {
  console.error("Set MISSION_IMPORT_TARGET=dev or prod");
  process.exit(1);
}

const APPLY = process.env.MISSION_IMPORT_APPLY === "1";
const FORUM_CHANNEL_ID = "1353888179882561598";
const GUILD_ID = "1348601552083882108";
// vinnybot posted a handful of threads on behalf of fixers; the OP's
// "Fixer Name / Handle" field holds an in-character alias, not a user.
const VINNYBOT_ID = "172847414791766016";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
if (!BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const HEADERS = { Authorization: `Bot ${BOT_TOKEN}` };

interface ThreadMeta {
  archived?: boolean;
  create_timestamp?: string;
  archive_timestamp?: string;
}
interface RawThread {
  id: string;
  name: string;
  parent_id?: string;
  owner_id?: string;
  applied_tags?: string[];
  message_count?: number;
  thread_metadata?: ThreadMeta;
}
interface RawMessage {
  id: string;
  content?: string;
  timestamp?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  attachments?: Array<{ url?: string; content_type?: string }>;
}

async function discordGet<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil(((body.retry_after ?? 1) + 0.25) * 1000);
      console.log(`  rate limited; waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`Discord GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`Discord GET ${path}: rate-limit retries exhausted`);
}

async function fetchAllThreads(): Promise<{ threads: RawThread[]; tagNames: Map<string, string> }> {
  const channel = await discordGet<{ type: number; available_tags?: Array<{ id: string; name: string }> }>(
    `/channels/${FORUM_CHANNEL_ID}`,
  );
  if (channel.type !== 15) throw new Error(`Channel ${FORUM_CHANNEL_ID} is not a forum (type=${channel.type})`);
  const tagNames = new Map((channel.available_tags ?? []).map((t) => [t.id, t.name]));

  const byId = new Map<string, RawThread>();
  // Active threads (guild-wide list, filtered to this forum).
  const act = await discordGet<{ threads?: RawThread[] }>(`/guilds/${GUILD_ID}/threads/active`);
  for (const t of act.threads ?? []) if (t.parent_id === FORUM_CHANNEL_ID) byId.set(t.id, t);
  // Archived threads, paginated oldest-cursor style via `before`.
  let before: string | undefined;
  for (;;) {
    const qs = before ? `?limit=100&before=${encodeURIComponent(before)}` : "?limit=100";
    const page = await discordGet<{ threads?: RawThread[]; has_more?: boolean }>(
      `/channels/${FORUM_CHANNEL_ID}/threads/archived/public${qs}`,
    );
    const threads = page.threads ?? [];
    for (const t of threads) byId.set(t.id, t);
    if (!page.has_more || threads.length === 0) break;
    before = threads[threads.length - 1]?.thread_metadata?.archive_timestamp;
    if (!before) break;
  }
  return { threads: [...byId.values()], tagNames };
}

// ---------------------------------------------------------------------------
// OP template parsing. Labels appear on their own line (occasionally bolded),
// values are the following lines until the next known label.
// ---------------------------------------------------------------------------
const FIELD_LABELS = [
  "Job Title",
  "Fixer Name / Handle",
  "Fixer Name/Handle",
  "Max Players",
  "Requested Skills",
  "Job Summary",
  "Job Type",
  "Job Difficulty",
  "Client (Optional)",
  "Client",
  "Expected Pay",
  "Pay",
  "Expected Length",
  // Labels we don't store but must recognize so they terminate the previous
  // field's value block instead of leaking into it.
  "Contact",
  "Risk Level",
  "Tone & Themes (Optional but useful)",
  "Tone & Themes",
  "Location / District (Optional)",
  "Location / District",
  "Location/District",
  "Location",
  "Notes for Players",
] as const;

function normalizeLabel(line: string): string | null {
  const stripped = line.replace(/[*_`#]+/g, "").trim().replace(/:$/, "").trim();
  for (const label of FIELD_LABELS) {
    if (stripped.toLowerCase() === label.toLowerCase()) return label;
  }
  return null;
}

function parseTemplate(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      const val = buf.join("\n").trim();
      if (val) out.set(canonicalField(current), val);
    }
    buf = [];
  };
  for (const line of content.split(/\r?\n/)) {
    // Inline form "Label: value" also appears occasionally.
    const inline = line.match(/^\s*[*_`#]*\s*([A-Za-z &/()]+?)\s*[*_`#]*\s*:\s*(\S.*)$/);
    if (inline && normalizeLabel(`${inline[1]}:`)) {
      flush();
      current = normalizeLabel(`${inline[1]}:`);
      buf = [inline[2]];
      continue;
    }
    const label = normalizeLabel(line);
    if (label) {
      flush();
      current = label;
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

function canonicalField(label: string): string {
  const l = label.toLowerCase();
  if (l.startsWith("fixer name")) return "fixerHandle";
  if (l.startsWith("client")) return "client";
  if (l.startsWith("location")) return "location";
  if (l === "job title") return "title";
  if (l === "max players") return "maxPlayers";
  if (l === "requested skills") return "requestedSkills";
  if (l === "job summary") return "summary";
  if (l === "job type") return "jobType";
  if (l === "job difficulty") return "difficulty";
  if (l === "expected pay" || l === "pay") return "pay";
  if (l === "contact" || l.startsWith("risk level") || l.startsWith("tone & themes")) return "_ignore";
  if (l === "expected length") return "length";
  if (l === "notes for players") return "notes";
  return label;
}

function parseTier(difficulty: string | undefined): number {
  const m = difficulty?.match(/tier\s*(\d)/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

function parsePay(pay: string | undefined): number {
  if (!pay) return 0;
  const cleaned = pay.replace(/,/g, "");
  const k = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:k\b|grand\b)/i);
  const n = k ? Number(k[1]) * 1000 : Number(cleaned.match(/\d+/)?.[0] ?? NaN);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n) : 0;
}

function parseDurationMinutes(len: string | undefined): number {
  if (!len) return 120;
  const l = len.toLowerCase();
  let minutes = 0;
  const h = l.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/);
  if (h) minutes += Math.round(Number(h[1]) * 60);
  const m = l.match(/(\d+)\s*(?:minutes?|mins?|m\b)/);
  if (m) minutes += Number(m[1]);
  if (minutes === 0) {
    // Bare number = assume hours if small, minutes otherwise.
    const bare = l.match(/\d+(?:\.\d+)?/);
    if (bare) {
      const n = Number(bare[0]);
      minutes = n <= 12 ? Math.round(n * 60) : Math.round(n);
    }
  }
  return minutes > 0 && minutes <= 24 * 60 ? minutes : 120;
}

function parseMaxPlayers(v: string | undefined): number {
  if (!v) return 0;
  if (/unlimited|no\s*limit|any/i.test(v)) return 0;
  const m = v.match(/\d+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : 0;
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

async function main() {
  const { db, pool, missions, users } = await import("@workspace/db");
  const { inArray, isNull, sql } = await import("drizzle-orm");

  console.log(`Target: ${target}  |  ${APPLY ? "APPLY" : "DRY-RUN (set MISSION_IMPORT_APPLY=1 to write)"}`);

  const { threads, tagNames } = await fetchAllThreads();
  console.log(`Fetched ${threads.length} threads from #fixer-job-postings`);

  // Resolve fixer users in one bulk load (users.id == discord id here, but go
  // through discord_id to be explicit).
  const ownerIds = [...new Set(threads.map((t) => t.owner_id).filter((x): x is string => !!x))];
  const userRows = ownerIds.length
    ? await db.select({ id: users.id, discordId: users.discordId }).from(users).where(inArray(users.discordId, ownerIds))
    : [];
  const userByDiscord = new Map(userRows.map((u) => [u.discordId, u.id]));

  // Existing missions for dedupe/link.
  const existing = await db
    .select({
      id: missions.id,
      title: missions.title,
      discordThreadId: missions.discordThreadId,
      fixerId: missions.fixerId,
      startAt: missions.startAt,
      completedAt: missions.completedAt,
      location: missions.location,
      description: missions.description,
      jobType: missions.jobType,
      requestedSkills: missions.requestedSkills,
      client: missions.client,
      notesForPlayers: missions.notesForPlayers,
      playerPay: missions.playerPay,
      tier: missions.tier,
      maxPlayers: missions.maxPlayers,
      durationMinutes: missions.durationMinutes,
    })
    .from(missions);
  const byThreadId = new Map(existing.filter((m) => m.discordThreadId).map((m) => [m.discordThreadId as string, m]));
  const byTitle = new Map<string, (typeof existing)[number]>();
  for (const m of existing) if (!byTitle.has(normTitle(m.title))) byTitle.set(normTitle(m.title), m);

  let imported = 0;
  let linked = 0;
  let skipped = 0;
  const needsAttribution: string[] = [];

  for (const t of threads) {
    // Non-mission housekeeping threads.
    if (/player guide/i.test(t.name)) {
      skipped++;
      console.log(`SKIP   "${t.name}" — not a mission posting`);
      continue;
    }
    const created = t.thread_metadata?.create_timestamp ? new Date(t.thread_metadata.create_timestamp) : null;
    const archivedAt = t.thread_metadata?.archive_timestamp ? new Date(t.thread_metadata.archive_timestamp) : null;
    const tagList = (t.applied_tags ?? []).map((id) => tagNames.get(id) ?? id);
    const isOpen = !t.thread_metadata?.archived && tagList.includes("Open") && !tagList.includes("Closed");

    if (byThreadId.has(t.id)) {
      skipped++;
      continue; // already imported/linked on a previous run
    }

    // OP message id == thread id in forums.
    let op: RawMessage | null = null;
    try {
      op = await discordGet<RawMessage>(`/channels/${t.id}/messages/${t.id}`);
    } catch (err) {
      console.warn(`  ! OP fetch failed for "${t.name}" (${t.id}): ${(err as Error).message}`);
    }
    const fields = parseTemplate(op?.content ?? "");
    // Thread name is the canonical title (forum post title); OP "Job Title"
    // fields are often polluted with markdown bold markers / extra lines.
    const title = t.name.trim().slice(0, 200);
    const description = fields.get("summary") || (op?.content ?? "").trim() || null;

    // Attribution: thread owner unless the bot posted it.
    let fixerId: string | null = null;
    if (t.owner_id && t.owner_id !== VINNYBOT_ID) {
      fixerId = userByDiscord.get(t.owner_id) ?? null;
      if (!fixerId) needsAttribution.push(`"${title}" — thread owner ${t.owner_id} has no website account`);
    } else {
      needsAttribution.push(`"${title}" — posted by bot; OP handle: ${fields.get("fixerHandle") ?? "?"}`);
    }

    const imageUrl = null; // Discord CDN attachment URLs expire (~24h); do not store them.

    const values = {
      title,
      tier: parseTier(fields.get("difficulty")),
      playerPay: parsePay(fields.get("pay")),
      location: fields.get("location")?.slice(0, 300) ?? null,
      description,
      imageUrl,
      status: isOpen ? "open" : "completed",
      workflowState: "posted",
      fixerId,
      startAt: created,
      durationMinutes: parseDurationMinutes(fields.get("length")),
      slots: 0,
      maxPlayers: parseMaxPlayers(fields.get("maxPlayers")),
      jobType: fields.get("jobType")?.slice(0, 100) ?? null,
      requestedSkills: fields.get("requestedSkills") ?? null,
      client: fields.get("client")?.slice(0, 200) ?? null,
      notesForPlayers: fields.get("notes") ?? null,
      discordThreadId: t.id,
      completedAt: isOpen ? null : (archivedAt ?? created),
      createdAt: created ?? new Date(),
      updatedAt: new Date(),
    };

    const match = byTitle.get(normTitle(title));
    if (match && !match.discordThreadId) {
      // Link the existing mission; backfill only empty/default fields.
      linked++;
      console.log(`LINK   #${match.id} "${match.title}" <- thread ${t.id}${APPLY ? "" : " (dry-run)"}`);
      if (APPLY) {
        await db
          .update(missions)
          .set({
            discordThreadId: t.id,
            location: match.location ?? values.location,
            description: match.description ?? values.description,
            jobType: match.jobType ?? values.jobType,
            requestedSkills: match.requestedSkills ?? values.requestedSkills,
            client: match.client ?? values.client,
            notesForPlayers: match.notesForPlayers ?? values.notesForPlayers,
            fixerId: match.fixerId ?? values.fixerId,
            startAt: match.startAt ?? values.startAt,
            playerPay: match.playerPay || values.playerPay,
            tier: match.tier !== 1 ? match.tier : values.tier,
            maxPlayers: match.maxPlayers || values.maxPlayers,
            durationMinutes: match.durationMinutes !== 120 ? match.durationMinutes : values.durationMinutes,
            updatedAt: new Date(),
          })
          .where(sql`${missions.id} = ${match.id} AND ${missions.discordThreadId} IS NULL`);
      }
      byThreadId.set(t.id, { ...match, discordThreadId: t.id });
      continue;
    }
    if (match && match.discordThreadId) {
      skipped++;
      console.log(`SKIP   "${title}" — title already linked to thread ${match.discordThreadId}`);
      continue;
    }

    imported++;
    console.log(
      `IMPORT "${title}" | ${values.status} | fixer=${fixerId ?? "-"} | ${created?.toISOString().slice(0, 10) ?? "?"} | tier ${values.tier} | pay ${values.playerPay}${APPLY ? "" : " (dry-run)"}`,
    );
    if (APPLY) {
      await db
        .insert(missions)
        .values(values)
        .onConflictDoNothing({
          target: missions.discordThreadId,
          where: sql`discord_thread_id IS NOT NULL`,
        });
      byThreadId.set(t.id, { ...values, id: -1 } as never);
    }
  }

  console.log("\n===== SUMMARY =====");
  console.log(`threads: ${threads.length}  imported: ${imported}  linked: ${linked}  skipped(already linked): ${skipped}`);
  if (needsAttribution.length) {
    console.log(`\nNeeds manual fixer attribution (${needsAttribution.length}):`);
    for (const line of needsAttribution) console.log(`  - ${line}`);
  }
  // Sanity: unlinked missions that still have no thread.
  const unlinked = await db.select({ id: missions.id, title: missions.title }).from(missions).where(isNull(missions.discordThreadId));
  if (unlinked.length) {
    console.log(`\nMissions still without a thread link (${unlinked.length}):`);
    for (const m of unlinked) console.log(`  - #${m.id} ${m.title}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error("IMPORT FAILED:", err);
  process.exit(1);
});
