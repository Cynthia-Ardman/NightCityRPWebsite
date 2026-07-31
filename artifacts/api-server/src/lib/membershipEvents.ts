// Community growth timeline: ingest Discord server join/leave events and
// VRChat group join/leave events into membership_events.
//
// Discord sources (read-only REST, safe in any environment — idempotent via
// the sourceRef unique index):
//   - #ncrp-welcome: Discord system messages of type 7 (GUILD_MEMBER_JOIN).
//     Full channel history exists back to server creation → joins.
//   - #bot-logs: Dyno embeds with author "Member Joined"/"Member Left" and a
//     footer "ID: <discord id>" → joins AND leaves (leave history only goes
//     back as far as Dyno logging).
// A join observed by BOTH sources within a few minutes is stored once (the
// first ingested row wins; the near-duplicate is skipped).
//
// VRChat source: the group audit log (group.user.join / group.user.leave and
// member remove/ban entries). Only callable where the VRChat session works
// (deployed prod) — see the cron wiring in jobs.ts.
import { db, membershipEvents, botConfig } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { DISCORD_BOT_TOKEN } from "./discord";
import { fetchGroupAuditLogs } from "./vrchatClient";
import { logger } from "./logger";

const API = "https://discord.com/api/v10";

export const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID ?? "1348601552734257217";
export const BOT_LOGS_CHANNEL_ID = process.env.BOT_LOGS_CHANNEL_ID ?? "1349160856688267285";

// Two joins for the same user closer together than this are considered one
// observation reported by two log sources.
const JOIN_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

export interface RawDiscordMessage {
  id: string;
  type: number;
  timestamp: string;
  author?: { id: string; username?: string; bot?: boolean };
  embeds?: Array<{
    description?: string;
    author?: { name?: string };
    footer?: { text?: string };
  }>;
}

// --- cursor storage (bot_config jsonb) --------------------------------------

// Cursors are stored as `{ "id": "<snowflake>" }` — NOT as a bare JSON string.
// A bare digit-string round-trips through the jsonb layer as a JS number and
// loses precision (64-bit snowflakes > 2^53), silently resetting the walk.
async function getCursor(key: string): Promise<string | null> {
  const [row] = await db.select().from(botConfig).where(eq(botConfig.key, key));
  const v = row?.value as unknown;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
    return (v as { id: string }).id;
  }
  // Legacy formats: bare string, or a double-parsed number (precision-lossy
  // but within the same millisecond of ids — fine for a resume point).
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v)).toString();
  return null;
}

async function setCursor(key: string, value: string): Promise<void> {
  // Monotonic: concurrent walkers (cron tick + manual backfill) must never
  // move the cursor backwards, or the channel walk restarts behind itself.
  await db.execute(sql`
    INSERT INTO bot_config (key, value)
    VALUES (${key}, ${JSON.stringify({ id: value })}::jsonb)
    ON CONFLICT (key) DO UPDATE
      SET value = excluded.value, updated_at = now()
      WHERE coalesce(bot_config.value ->> 'id', bot_config.value #>> '{}')::numeric
          < (excluded.value ->> 'id')::numeric
  `);
}

// --- Discord REST ------------------------------------------------------------

// One ascending page of channel messages strictly after `afterId` ("0" walks
// from the beginning of the channel). Discord returns pages newest-first;
// callers advance the cursor to the max id of the page.
async function fetchMessagesAfter(channelId: string, afterId: string): Promise<RawDiscordMessage[]> {
  // Bounded: at most 6 attempts / ~60s wall clock per page, then fail the run
  // cleanly — the cursor makes the next tick resume where this one stopped.
  const deadline = Date.now() + 60_000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/channels/${channelId}/messages?limit=100&after=${afterId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return (await res.json()) as RawDiscordMessage[];
    if ((res.status === 429 || res.status >= 500) && attempt < 6 && Date.now() < deadline) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const backoff =
        res.status === 429
          ? Math.ceil((body.retry_after ?? 1) * 1000)
          : Math.min(2000 * attempt, 10_000) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    throw new Error(`Discord GET messages ${channelId} failed (${res.status})`);
  }
}

// --- parsing -----------------------------------------------------------------

interface ParsedEvent {
  direction: "join" | "leave";
  subjectId: string;
  displayName: string | null;
  occurredAt: Date;
  eventType: string;
  sourceRef: string;
}

export function parseWelcomeMessage(m: RawDiscordMessage): ParsedEvent | null {
  // Type 7 = GUILD_MEMBER_JOIN system message; the author IS the joiner.
  if (m.type !== 7 || !m.author?.id) return null;
  return {
    direction: "join",
    subjectId: m.author.id,
    displayName: m.author.username ?? null,
    occurredAt: new Date(m.timestamp),
    eventType: "welcome-system",
    sourceRef: `discord-msg:${m.id}`,
  };
}

export function parseDynoMessage(m: RawDiscordMessage): ParsedEvent | null {
  for (const e of m.embeds ?? []) {
    const kind = e.author?.name;
    if (kind !== "Member Joined" && kind !== "Member Left") continue;
    const id =
      e.footer?.text?.match(/ID:\s*(\d{5,})/)?.[1] ??
      e.description?.match(/<@!?(\d{5,})>/)?.[1] ??
      null;
    if (!id) continue;
    // Description shape: "<@!id> username" (username backslash-escaped).
    const name = e.description?.replace(/<@!?\d+>/, "").replace(/\\/g, "").trim() || null;
    return {
      direction: kind === "Member Joined" ? "join" : "leave",
      subjectId: id,
      displayName: name,
      occurredAt: new Date(m.timestamp),
      eventType: "dyno-embed",
      sourceRef: `discord-msg:${m.id}`,
    };
  }
  return null;
}

// --- ingestion ---------------------------------------------------------------

async function insertEvent(source: "discord" | "vrchat", ev: ParsedEvent): Promise<boolean> {
  if (ev.direction === "join" && source === "discord") {
    // Cross-source join dedupe: welcome + Dyno both report the same join.
    // Check-then-insert is racy across processes (cron vs backfill script),
    // so serialize per subject with a tx-scoped advisory lock — both writers
    // of the same subject queue here, and the second one sees the first row.
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"membership-join:" + ev.subjectId}))`);
      const dupe = await tx
        .select({ id: membershipEvents.id })
        .from(membershipEvents)
        .where(
          and(
            eq(membershipEvents.source, source),
            eq(membershipEvents.direction, "join"),
            eq(membershipEvents.subjectId, ev.subjectId),
            gte(membershipEvents.occurredAt, new Date(ev.occurredAt.getTime() - JOIN_DEDUPE_WINDOW_MS)),
            lte(membershipEvents.occurredAt, new Date(ev.occurredAt.getTime() + JOIN_DEDUPE_WINDOW_MS)),
          ),
        )
        .limit(1);
      if (dupe.length > 0) return false;
      const rows = await tx
        .insert(membershipEvents)
        .values({
          source,
          direction: ev.direction,
          subjectId: ev.subjectId,
          displayName: ev.displayName,
          occurredAt: ev.occurredAt,
          eventType: ev.eventType,
          sourceRef: ev.sourceRef,
        })
        .onConflictDoNothing({ target: membershipEvents.sourceRef })
        .returning({ id: membershipEvents.id });
      return rows.length > 0;
    });
  }
  const inserted = await db
    .insert(membershipEvents)
    .values({
      source,
      direction: ev.direction,
      subjectId: ev.subjectId,
      displayName: ev.displayName,
      occurredAt: ev.occurredAt,
      eventType: ev.eventType,
      sourceRef: ev.sourceRef,
    })
    .onConflictDoNothing({ target: membershipEvents.sourceRef })
    .returning({ id: membershipEvents.id });
  return inserted.length > 0;
}

// Walk one Discord channel forward from its stored cursor, parsing and
// inserting membership events. Processes at most `maxPages` pages per call so
// a cron tick stays bounded; the cursor makes the walk resumable, so the
// first run backfills the entire channel history across successive ticks.
async function ingestChannel(
  channelId: string,
  parse: (m: RawDiscordMessage) => ParsedEvent | null,
  maxPages: number,
): Promise<{ inserted: number; pages: number; caughtUp: boolean }> {
  const cursorKey = `membership_cursor_${channelId}`;
  let cursor = (await getCursor(cursorKey)) ?? "0";
  let inserted = 0;
  let pages = 0;
  while (pages < maxPages) {
    const msgs = await fetchMessagesAfter(channelId, cursor);
    if (msgs.length === 0) return { inserted, pages, caughtUp: true };
    pages++;
    // Pages come newest-first; process oldest-first so the dedupe window sees
    // earlier events before later ones.
    for (const m of [...msgs].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
      const ev = parse(m);
      if (ev && (await insertEvent("discord", ev))) inserted++;
    }
    cursor = msgs.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), cursor);
    await setCursor(cursorKey, cursor);
    if (msgs.length < 100) return { inserted, pages, caughtUp: true };
    await new Promise((r) => setTimeout(r, 150)); // the 429 handler absorbs bucket limits
  }
  return { inserted, pages, caughtUp: false };
}

export async function ingestDiscordMembershipEvents(opts: { maxPages?: number } = {}): Promise<{
  inserted: number;
  caughtUp: boolean;
}> {
  if (!DISCORD_BOT_TOKEN) return { inserted: 0, caughtUp: true };
  const maxPages = opts.maxPages ?? 40;
  // bot-logs first: Dyno rows carry leaves and win the join-dedupe window for
  // periods where both sources exist.
  const logs = await ingestChannel(BOT_LOGS_CHANNEL_ID, parseDynoMessage, maxPages);
  const welcome = await ingestChannel(WELCOME_CHANNEL_ID, parseWelcomeMessage, maxPages);
  const result = {
    inserted: logs.inserted + welcome.inserted,
    caughtUp: logs.caughtUp && welcome.caughtUp,
  };
  logger.info({ ...result, logsPages: logs.pages, welcomePages: welcome.pages }, "membership discord ingest");
  return result;
}

// --- VRChat ------------------------------------------------------------------

function classifyVrchatEvent(eventType: string): "join" | "leave" | null {
  const t = eventType.toLowerCase();
  if (t.endsWith(".join")) return "join";
  if (t.endsWith(".leave") || t.endsWith(".remove") || t.endsWith(".ban")) return "leave";
  return null;
}

// Pull recent group audit-log entries and record join/leave events. VRChat
// retention is limited (~60 days), so this is tail-following, not a full
// historical backfill. Caller is responsible for session gating (prod cron).
export async function ingestVrchatMembershipEvents(): Promise<{ inserted: number }> {
  // Overlap a little past the newest stored event so nothing is missed
  // between ticks; the sourceRef unique index absorbs the overlap.
  const [newest] = await db
    .select({ max: sql<string | null>`max(${membershipEvents.occurredAt})` })
    .from(membershipEvents)
    .where(eq(membershipEvents.source, "vrchat"));
  const since = newest?.max ? new Date(new Date(newest.max).getTime() - 60 * 60 * 1000) : null;

  let inserted = 0;
  let offset = 0;
  const pageSize = 100;
  for (let page = 0; page < 20; page++) {
    const entries = await fetchGroupAuditLogs({ n: pageSize, offset });
    if (entries.length === 0) break;
    let sawOlder = false;
    for (const entry of entries) {
      const direction = classifyVrchatEvent(entry.eventType ?? "");
      const at = new Date(entry.created_at);
      if (since && at < since) {
        sawOlder = true;
        continue;
      }
      if (!direction || !entry.targetId?.startsWith("usr_")) continue;
      const ok = await insertEvent("vrchat", {
        direction,
        subjectId: entry.targetId,
        displayName: entry.actorDisplayName ?? null,
        occurredAt: at,
        eventType: entry.eventType ?? "unknown",
        sourceRef: `vrchat-log:${entry.id}`,
      });
      if (ok) inserted++;
    }
    if (sawOlder || entries.length < pageSize) break;
    offset += pageSize;
  }
  if (inserted > 0) logger.info({ inserted }, "membership vrchat ingest");
  return { inserted };
}
