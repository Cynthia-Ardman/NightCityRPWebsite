import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  db,
  events,
  eventNpcSignups,
  missions,
  users,
  characters,
  type Event,
  type EventRecurrenceRule,
} from "@workspace/db";
import {
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
  listGuildScheduledEvents,
  fetchDiscordUser,
  type GuildScheduledEvent,
} from "./discord";
import { getMissionContext } from "./missionsConfig";
import { checkDiscordEventConflict } from "./missionsService";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";

const storage = new ObjectStorageService();

// Build the highest-quality CDN URL for a Discord scheduled-event banner. The
// raw guild-events image is served at a low default resolution unless `?size`
// is requested; 2048 is Discord's max and gives a crisp banner.
export function guildEventImageUrl(discordEventId: string, image: string): string {
  return `https://cdn.discordapp.com/guild-events/${discordEventId}/${image}.png?size=2048`;
}

// Fetch a Discord CDN banner and re-host it to object storage, returning the
// app-relative path. Falls back to the original CDN URL on failure so an event
// still has *some* image — but note signed CDN URLs can 401 after ~24h, so the
// rehosted copy is strongly preferred (see memory: discord-cdn-url-expiry).
export async function rehostEventImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/png";
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return null;
    return await storage.uploadBuffer(buf, ct);
  } catch (err) {
    logger.warn({ err, url }, "rehostEventImage failed");
    return null;
  }
}

// ===========================================================================
// EVENTS — non-mission calendar items (sessions, socials). Mirrors the mission
// Discord scheduled-event sync but carries no money/payment lifecycle. Discord
// writes ride the SHARED missions Test/Live switch (ctx.live) so events go live
// exactly when the missions system does.
// ===========================================================================

export interface EventViewer {
  id: string;
  isManager: boolean; // fixer or admin
  isAdmin: boolean;
}

export const EVENT_TYPES = ["session", "social", "mission", "other"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}

// Main Sessions (eventType "session") are the headline weekly game and ALWAYS
// need NPCs, so we treat them as NPC-accepting even when the stored needsNpcs
// flag is off (imported sessions default it to false, and a fixer can forget to
// tick it). Every NPC gate — both the serialized view and the sign-up endpoint —
// derives from this helper instead of the raw column so the two never diverge.
export function eventNeedsNpcs(e: { needsNpcs: boolean; eventType: string }): boolean {
  return e.needsNpcs || e.eventType === "session";
}

export interface EventSignupView {
  id: number;
  userId: string;
  userName: string | null;
  characterId: number | null;
  characterName: string | null;
  note: string | null;
  createdAt: string | null;
}

export interface EventView {
  id: number;
  title: string;
  eventType: string;
  location: string | null;
  description: string | null;
  imageUrl: string | null;
  startAt: string;
  endAt: string;
  status: string;
  needsNpcs: boolean;
  npcBlurb: string | null;
  createdById: string | null;
  createdByName: string | null;
  hasDiscordEvent: boolean;
  discordSyncError: string | null;
  signupCount: number;
  mySignup: EventSignupView | null;
  canManage: boolean;
  // Normalised recurrence (null = single occurrence). Expanded onto the
  // calendar client-side so a weekly Discord event shows on every occurrence.
  recurrence: EventRecurrenceRule | null;
  // Only populated on the detail view for managers.
  signups?: EventSignupView[];
}

// Mission images are stored as app-relative paths (e.g. "/api/storage/...").
// Discord needs an absolute URL, so prefix relative paths with PUBLIC_BASE_URL.
function resolveAbsoluteImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function userDisplayName(u: { globalName: string | null; username: string | null } | undefined): string | null {
  if (!u) return null;
  return u.globalName || u.username || null;
}

// ---------------------------------------------------------------------------
// Content fingerprint of the fields we mirror to Discord (title, description,
// location, start, end). The reconcile cron stores the last-synced hash on the
// row, then compares both sides' current hash against it to tell which side
// changed since the last sync — this is how "most recent edit wins" works
// without a Discord-side modified timestamp. Image is intentionally excluded:
// Discord exposes an image hash, not our URL, so they're not comparable.
//
// Normalisation MUST match buildEventBody in discord.ts: name/description/
// location are trimmed + length-capped and a null/empty location collapses to
// "Night City" (the default we push), so a website null and a Discord
// "Night City" hash identically. Timestamps compare at second granularity.
// ---------------------------------------------------------------------------
interface EventContent {
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date;
}

function eventContentHash(c: EventContent): string {
  const norm = [
    c.title.trim().slice(0, 100),
    (c.description ?? "").trim().slice(0, 1000),
    (c.location?.trim() || "Night City").slice(0, 100),
    Math.floor(c.startAt.getTime() / 1000),
    Math.floor(c.endAt.getTime() / 1000),
  ];
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

// Structural equality for a normalised recurrence (order-independent on the
// weekday set). Lets the reconcile loop skip a no-op UPDATE when nothing changed.
function recurrenceEqual(
  a: EventRecurrenceRule | null | undefined,
  b: EventRecurrenceRule | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const wd = (x: number[] | null) => (x ? [...x].sort((m, n) => m - n).join(",") : "");
  return (
    a.frequency === b.frequency &&
    a.interval === b.interval &&
    a.count === b.count &&
    a.until === b.until &&
    wd(a.byWeekday) === wd(b.byWeekday)
  );
}

// Discord external events always carry an end time; defend against a missing
// one (non-external types) by assuming a 2h window so the row stays valid.
function discordEventContent(d: GuildScheduledEvent): EventContent {
  const startAt = new Date(d.scheduledStartTime);
  const endAt = d.scheduledEndTime
    ? new Date(d.scheduledEndTime)
    : new Date(startAt.getTime() + 2 * 60 * 60_000);
  return { title: d.name, description: d.description, location: d.location, startAt, endAt };
}

export interface EventSyncResult {
  discordEventId: string | null;
  discordSyncError: string | null;
  // Only present when a push was attempted (i.e. live mode). undefined = leave
  // the stored hash/timestamp untouched.
  discordSyncedHash?: string | null;
  discordSyncedAt?: Date | null;
}

// ---------------------------------------------------------------------------
// Discord scheduled-event sync (gated by the shared missions Test/Live switch).
// Never throws — failures are persisted to discordSyncError and returned.
// ---------------------------------------------------------------------------
export async function syncEventDiscordEvent(
  event: Event,
  live: boolean,
): Promise<EventSyncResult> {
  if (!live) {
    return { discordEventId: event.discordEventId, discordSyncError: null };
  }
  // Cancelled: tear down any linked Discord event.
  if (event.status === "cancelled") {
    if (!event.discordEventId) return { discordEventId: null, discordSyncError: null };
    const res = await deleteGuildScheduledEvent(event.discordEventId);
    return res.ok
      ? { discordEventId: null, discordSyncError: null, discordSyncedHash: null, discordSyncedAt: new Date() }
      : { discordEventId: event.discordEventId, discordSyncError: res.error };
  }
  const input = {
    name: event.title,
    description: event.description ?? null,
    location: event.location ?? "Night City",
    startAt: event.startAt,
    endAt: event.endAt,
    imageUrl: resolveAbsoluteImageUrl(event.imageUrl),
  };
  const res = event.discordEventId
    ? await modifyGuildScheduledEvent(event.discordEventId, input)
    : await createGuildScheduledEvent(input);
  if (res.ok) {
    return {
      discordEventId: res.id,
      discordSyncError: null,
      // Record what we just pushed so the reconcile cron treats this as "in
      // sync" until one side genuinely diverges.
      discordSyncedHash: eventContentHash(event),
      discordSyncedAt: new Date(),
    };
  }
  // Keep the old id on failure so a later retry can still modify it.
  return { discordEventId: event.discordEventId, discordSyncError: res.error };
}

// Persist a sync result onto a row. Always writes id + error (idempotent); only
// touches the synced hash/timestamp when the sync actually attempted a push.
async function applyEventSync(id: number, fallback: Event, sync: EventSyncResult): Promise<Event> {
  const set: Partial<typeof events.$inferInsert> = {
    discordEventId: sync.discordEventId,
    discordSyncError: sync.discordSyncError,
  };
  if (sync.discordSyncedHash !== undefined) set.discordSyncedHash = sync.discordSyncedHash;
  if (sync.discordSyncedAt !== undefined) set.discordSyncedAt = sync.discordSyncedAt;
  const [updated] = await db.update(events).set(set).where(eq(events.id, id)).returning();
  return updated ?? fallback;
}

// Reuse the mission conflict check (both share the same Discord guild events).
// The conflict scan compares against Discord scheduled events by their snowflake
// id, but callers pass our DB event id (e.g. editing event #12). Resolve the DB
// id to its linked discordEventId first so an event isn't flagged as conflicting
// with ITSELF. An unsynced row (no discordEventId) resolves to null and simply
// excludes nothing.
export async function checkEventConflict(opts: {
  startAt: Date;
  endAt: Date;
  excludeEventId?: string | null;
}) {
  const durationMinutes = Math.max(1, Math.round((opts.endAt.getTime() - opts.startAt.getTime()) / 60_000));
  let excludeDiscordId: string | null = null;
  const dbId = opts.excludeEventId != null ? parseInt(opts.excludeEventId, 10) : NaN;
  if (Number.isInteger(dbId)) {
    const [row] = await db
      .select({ discordEventId: events.discordEventId })
      .from(events)
      .where(eq(events.id, dbId));
    excludeDiscordId = row?.discordEventId ?? null;
  }
  return checkDiscordEventConflict({ startAt: opts.startAt, durationMinutes, excludeEventId: excludeDiscordId });
}

// ---------------------------------------------------------------------------
// View builders
// ---------------------------------------------------------------------------
async function loadSignupViews(eventIds: number[]): Promise<Map<number, EventSignupView[]>> {
  const byEvent = new Map<number, EventSignupView[]>();
  if (eventIds.length === 0) return byEvent;
  const rows = await db
    .select({
      id: eventNpcSignups.id,
      eventId: eventNpcSignups.eventId,
      userId: eventNpcSignups.userId,
      note: eventNpcSignups.note,
      createdAt: eventNpcSignups.createdAt,
      characterId: eventNpcSignups.characterId,
      globalName: users.globalName,
      username: users.username,
      characterName: characters.name,
    })
    .from(eventNpcSignups)
    .leftJoin(users, eq(users.id, eventNpcSignups.userId))
    .leftJoin(characters, eq(characters.id, eventNpcSignups.characterId))
    .where(and(inArray(eventNpcSignups.eventId, eventIds), eq(eventNpcSignups.state, "signed_up")));
  for (const r of rows) {
    const view: EventSignupView = {
      id: r.id,
      userId: r.userId,
      userName: userDisplayName({ globalName: r.globalName, username: r.username }),
      characterId: r.characterId,
      characterName: r.characterName ?? null,
      note: r.note,
      createdAt: iso(r.createdAt),
    };
    const list = byEvent.get(r.eventId) ?? [];
    list.push(view);
    byEvent.set(r.eventId, list);
  }
  return byEvent;
}

function toView(
  e: Event & { createdByName: string | null },
  viewer: EventViewer,
  signups: EventSignupView[],
  includeSignups: boolean,
): EventView {
  const mySignup = signups.find((s) => s.userId === viewer.id) ?? null;
  return {
    id: e.id,
    title: e.title,
    eventType: e.eventType,
    location: e.location,
    description: e.description,
    imageUrl: e.imageUrl,
    startAt: iso(e.startAt)!,
    endAt: iso(e.endAt)!,
    status: e.status,
    needsNpcs: eventNeedsNpcs(e),
    npcBlurb: e.npcBlurb,
    createdById: e.createdById,
    createdByName: e.createdByName,
    hasDiscordEvent: !!e.discordEventId,
    discordSyncError: viewer.isManager ? e.discordSyncError : null,
    signupCount: signups.length,
    mySignup,
    canManage: viewer.isManager,
    recurrence: e.recurrenceRule ?? null,
    ...(includeSignups && viewer.isManager ? { signups } : {}),
  };
}

export async function listEvents(viewer: EventViewer, opts?: { limit?: number }): Promise<EventView[]> {
  const limit = Math.min(1000, opts?.limit ?? 500);
  const select = {
    e: events,
    createdGlobalName: users.globalName,
    createdUsername: users.username,
  };
  const baseRows = await db
    .select(select)
    .from(events)
    .leftJoin(users, eq(users.id, events.createdById))
    .where(ne(events.status, "cancelled"))
    .orderBy(desc(events.startAt))
    .limit(limit);
  // Recurring series can have an old anchor `startAt`, so the desc-ordered limit
  // above could drop them before the calendar ever expands their occurrences.
  // Always fetch every active recurring row and merge (dedup by id) so the
  // client can expand them into the visible window.
  const recurringRows = await db
    .select(select)
    .from(events)
    .leftJoin(users, eq(users.id, events.createdById))
    .where(and(ne(events.status, "cancelled"), isNotNull(events.recurrenceRule)));
  const byId = new Map<number, (typeof baseRows)[number]>();
  for (const r of baseRows) byId.set(r.e.id, r);
  for (const r of recurringRows) byId.set(r.e.id, r);
  const rows = [...byId.values()].sort((a, b) => new Date(b.e.startAt).getTime() - new Date(a.e.startAt).getTime());
  const signupsByEvent = await loadSignupViews(rows.map((r) => r.e.id));
  return rows.map((r) =>
    toView(
      { ...r.e, createdByName: userDisplayName({ globalName: r.createdGlobalName, username: r.createdUsername }) },
      viewer,
      signupsByEvent.get(r.e.id) ?? [],
      false,
    ),
  );
}

// Discord stores mentions in descriptions as raw tokens (`<@123>` / `<@!123>`).
// Resolve them to readable @names for the website detail view. We try our own
// users table first (no network), then the Discord API (cached) as a fallback.
// Fail-safe: any unresolved id is left as a bare `@<id>` rather than the raw
// token so the UI never shows the angle-bracket noise. We DO NOT rewrite the
// stored description — resolving at read time keeps the Discord content hash
// (used by the reconcile sync) stable.
const MENTION_RE = /<@!?(\d+)>/g;
const mentionNameCache = new Map<string, string>();

async function resolveMentions(text: string | null): Promise<string | null> {
  if (!text) return text;
  const ids = [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))];
  if (ids.length === 0) return text;

  const unknown = ids.filter((id) => !mentionNameCache.has(id));
  if (unknown.length) {
    const rows = await db
      .select({ discordId: users.discordId, globalName: users.globalName, username: users.username })
      .from(users)
      .where(inArray(users.discordId, unknown));
    for (const r of rows) {
      const name = userDisplayName({ globalName: r.globalName, username: r.username });
      if (name) mentionNameCache.set(r.discordId, name);
    }
    const stillUnknown = unknown.filter((id) => !mentionNameCache.has(id));
    for (const id of stillUnknown) {
      const profile = await fetchDiscordUser(id);
      const name = profile ? profile.globalName || profile.username : null;
      if (name) mentionNameCache.set(id, name);
    }
  }

  return text.replace(MENTION_RE, (_full, id: string) => `@${mentionNameCache.get(id) ?? id}`);
}

export async function getEventDetail(id: number, viewer: EventViewer): Promise<EventView | null> {
  const [row] = await db
    .select({
      e: events,
      createdGlobalName: users.globalName,
      createdUsername: users.username,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.createdById))
    .where(eq(events.id, id));
  if (!row) return null;
  const signupsByEvent = await loadSignupViews([id]);
  const view = toView(
    { ...row.e, createdByName: userDisplayName({ globalName: row.createdGlobalName, username: row.createdUsername }) },
    viewer,
    signupsByEvent.get(id) ?? [],
    true,
  );
  view.description = await resolveMentions(view.description);
  return view;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
export interface EventInput {
  title: string;
  eventType: EventType;
  location: string | null;
  description: string | null;
  imageUrl: string | null;
  startAt: Date;
  endAt: Date;
  needsNpcs: boolean;
  npcBlurb: string | null;
}

export async function createEvent(input: EventInput, createdById: string): Promise<Event> {
  const [created] = await db
    .insert(events)
    .values({
      title: input.title,
      eventType: input.eventType,
      location: input.location,
      description: input.description,
      imageUrl: input.imageUrl,
      startAt: input.startAt,
      endAt: input.endAt,
      needsNpcs: input.needsNpcs,
      npcBlurb: input.needsNpcs ? input.npcBlurb : null,
      createdById,
    })
    .returning();
  const ctx = await getMissionContext();
  const sync = await syncEventDiscordEvent(created, ctx.live);
  return applyEventSync(created.id, created, sync);
}

export async function updateEvent(id: number, patch: Partial<EventInput>): Promise<Event | null> {
  const [before] = await db.select().from(events).where(eq(events.id, id));
  if (!before) return null;
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.eventType !== undefined) set.eventType = patch.eventType;
  if (patch.location !== undefined) set.location = patch.location;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl;
  if (patch.startAt !== undefined) set.startAt = patch.startAt;
  if (patch.endAt !== undefined) set.endAt = patch.endAt;
  if (patch.needsNpcs !== undefined) set.needsNpcs = patch.needsNpcs;
  if (patch.npcBlurb !== undefined) set.npcBlurb = patch.npcBlurb;
  // If NPCs were turned off, clear the now-meaningless blurb.
  if (patch.needsNpcs === false) set.npcBlurb = null;
  const [updated] = Object.keys(set).length
    ? await db.update(events).set(set).where(eq(events.id, id)).returning()
    : [before];
  const ctx = await getMissionContext();
  const sync = await syncEventDiscordEvent(updated, ctx.live);
  return applyEventSync(id, updated, sync);
}

export async function cancelEvent(id: number): Promise<Event | null> {
  const [before] = await db.select().from(events).where(eq(events.id, id));
  if (!before) return null;
  const [updated] = await db
    .update(events)
    .set({ status: "cancelled" })
    .where(eq(events.id, id))
    .returning();
  const ctx = await getMissionContext();
  const sync = await syncEventDiscordEvent(updated, ctx.live);
  return applyEventSync(id, updated, sync);
}

// ---------------------------------------------------------------------------
// Bidirectional reconcile (poll-based — there is no Discord gateway). Pure REST;
// safe to call repeatedly. Returns counts for the job log; never throws.
//
// The `live` flag splits the work by destination:
//  - Website-side writes (importing Discord events, pulling Discord edits down,
//    cancelling a row whose Discord event disappeared) ALWAYS run — they only
//    touch our own DB and are non-destructive to Discord, so admins can import
//    the existing schedule without flipping the Live switch.
//  - Discord-side mutations (pushing a website edit up, deleting a Discord event
//    for a row cancelled on-site) run ONLY when `live` — same gate as the
//    synchronous website→Discord push path (the missions Test/Live switch).
//
// Per cycle:
//  1. For every event row already linked to a Discord event:
//     - Discord event gone  → cancel the row too (true mirror of a Discord
//       delete/cancel).
//     - Both present        → compare each side's content hash to the stored
//       last-synced hash. Whichever side diverged is the one that changed since
//       the last sync, so it wins ("most recent edit wins"). If only Discord
//       changed we pull it down; otherwise we push the website's edit up (live).
//  2. Import any Discord event that isn't linked to an event row and isn't
//     owned by a mission (skipping completed/cancelled ones).
// ---------------------------------------------------------------------------
export interface ReconcileResult {
  imported: number;
  pulled: number;
  pushed: number;
  cancelled: number;
  /** Linked rows whose Discord event ended and was retained as history. */
  completed: number;
  /** Discord-side pushes/deletes skipped because the run was not Live. */
  deferred: number;
  error: string | null;
}

export async function reconcileDiscordEvents(live: boolean): Promise<ReconcileResult> {
  const result: ReconcileResult = { imported: 0, pulled: 0, pushed: 0, cancelled: 0, completed: 0, deferred: 0, error: null };
  const list = await listGuildScheduledEvents();
  if (!list.ok) {
    result.error = list.error;
    logger.warn({ error: list.error }, "reconcileDiscordEvents: list failed");
    return result;
  }
  const discordById = new Map(list.events.map((e) => [e.id, e]));

  // Discord ids owned by a mission are off-limits — the mission system owns
  // their lifecycle, so we never import or reconcile them here.
  const missionRows = await db
    .select({ discordEventId: missions.discordEventId })
    .from(missions)
    .where(isNotNull(missions.discordEventId));
  const missionIds = new Set(
    missionRows.map((r) => r.discordEventId).filter((x): x is string => !!x),
  );

  const rows = await db.select().from(events);
  const linkedIds = new Set(rows.map((r) => r.discordEventId).filter((x): x is string => !!x));

  // 1. Reconcile rows already linked to a Discord event.
  for (const row of rows) {
    if (!row.discordEventId) continue; // never-synced rows are owned by the create/edit path
    if (missionIds.has(row.discordEventId)) continue; // defensive: leave mission-owned ids alone
    const d = discordById.get(row.discordEventId);
    if (!d) {
      // Gone from Discord. Discord automatically removes a scheduled event from
      // the guild once it has ended, so a linked one-off row whose end time has
      // already passed almost certainly *finished* rather than being deleted — we
      // keep it as a historical record (status "completed") and unlink it so we
      // stop reconciling a Discord event that no longer exists. Only a row whose
      // end is still in the future is a genuine early delete/cancel on Discord's
      // side, which we mirror as a cancellation (the original bidirectional
      // behaviour). Recurring rows are excluded from the "completed" path: Discord
      // keeps them in the list (rolling forward), so a disappeared recurring row
      // means the whole series was deleted — mirror that as a cancellation rather
      // than leaving a row that would keep expanding phantom future occurrences.
      const endRef = row.endAt ?? row.startAt;
      const ended = !row.recurrenceRule && endRef.getTime() <= Date.now();
      if (ended) {
        if (row.status === "scheduled") {
          await db
            .update(events)
            .set({
              status: "completed",
              discordEventId: null,
              discordSyncError: null,
              discordSyncedAt: new Date(),
            })
            .where(eq(events.id, row.id));
          result.completed++;
        }
      } else if (row.status !== "cancelled") {
        await db
          .update(events)
          .set({ status: "cancelled", discordSyncError: null })
          .where(eq(events.id, row.id));
        result.cancelled++;
      }
      continue;
    }
    // A row we cancelled on the website still has a live Discord event: finish
    // the mirror by tearing it down here. This also retries cases where the
    // synchronous cancel push failed transiently or happened while in Test mode.
    if (row.status === "cancelled") {
      // Tearing down a real Discord event is a Discord mutation → Live only.
      // In Test mode leave it for the next Live run.
      if (!live) {
        result.deferred++;
        continue;
      }
      const del = await deleteGuildScheduledEvent(d.id);
      if (del.ok) {
        await db
          .update(events)
          .set({ discordEventId: null, discordSyncError: null, discordSyncedAt: new Date() })
          .where(eq(events.id, row.id));
        result.cancelled++;
      } else {
        await db.update(events).set({ discordSyncError: del.error }).where(eq(events.id, row.id));
      }
      continue;
    }

    // Recurrence isn't part of the content hash (it never round-trips to Discord
    // from us), so backfill it independently on every run for active linked rows
    // — this is what lets an existing weekly event start expanding on the
    // calendar without waiting for an unrelated title/time edit.
    if (!recurrenceEqual(row.recurrenceRule, d.recurrence)) {
      await db
        .update(events)
        .set({ recurrenceRule: d.recurrence ?? null })
        .where(eq(events.id, row.id));
    }

    const discordHash = eventContentHash(discordEventContent(d));
    const websiteHash = eventContentHash(row);
    const synced = row.discordSyncedHash;
    const discordChanged = discordHash !== synced;
    const websiteChanged = websiteHash !== synced;
    if (!discordChanged && !websiteChanged) continue;

    if (discordChanged && !websiteChanged) {
      // Only Discord moved → pull it into the website row. Guard on the stored
      // hash (non-null in this branch, since websiteHash === synced) so a
      // concurrent website edit that landed since we read `rows` isn't
      // clobbered — if it changed the row, this UPDATE simply no-ops.
      const c = discordEventContent(d);
      const upd = await db
        .update(events)
        .set({
          title: c.title,
          description: c.description,
          location: c.location,
          startAt: c.startAt,
          endAt: c.endAt,
          discordSyncedHash: discordHash,
          discordSyncedAt: new Date(),
          discordSyncError: null,
        })
        .where(and(eq(events.id, row.id), eq(events.discordSyncedHash, synced as string)))
        .returning({ id: events.id });
      if (upd.length) result.pulled++;
    } else {
      // Website moved (and maybe Discord too). Most-recent-wins: push the
      // website's explicit edit back up. Both-changed is rare because website
      // edits push synchronously and stamp the hash; honouring the website here
      // keeps the operator's last on-site action authoritative.
      // Pushing to Discord is a Discord mutation → Live only; defer in Test.
      if (!live) {
        result.deferred++;
        continue;
      }
      const sync = await syncEventDiscordEvent(row, true);
      await applyEventSync(row.id, row, sync);
      if (!sync.discordSyncError) result.pushed++;
    }
  }

  // 2. Import Discord events with no event row and no owning mission.
  const creatorIds = [
    ...new Set(list.events.map((e) => e.creatorId).filter((x): x is string => !!x)),
  ];
  const creatorMap = new Map<string, string>(); // discordId -> users.id
  if (creatorIds.length) {
    const userRows = await db
      .select({ id: users.id, discordId: users.discordId })
      .from(users)
      .where(inArray(users.discordId, creatorIds));
    for (const u of userRows) creatorMap.set(u.discordId, u.id);
  }
  for (const d of list.events) {
    if (linkedIds.has(d.id) || missionIds.has(d.id)) continue;
    if (d.status === 3 || d.status === 4) continue; // skip completed / canceled
    const c = discordEventContent(d);
    // Re-host the banner at full resolution to object storage. The raw CDN URL
    // is low-res (no ?size) and signed CDN URLs expire after ~24h, so we pull a
    // 2048px copy and store it. Fall back to the high-res CDN URL if rehosting
    // fails, so the event still has a (sharper) banner.
    let imageUrl: string | null = null;
    if (d.image) {
      const cdnUrl = guildEventImageUrl(d.id, d.image);
      imageUrl = (await rehostEventImage(cdnUrl)) ?? cdnUrl;
    }
    const inserted = await db
      .insert(events)
      .values({
        title: c.title,
        eventType: "social",
        location: c.location,
        description: c.description,
        imageUrl,
        startAt: c.startAt,
        endAt: c.endAt,
        status: "scheduled",
        needsNpcs: false,
        createdById: d.creatorId ? creatorMap.get(d.creatorId) ?? null : null,
        discordEventId: d.id,
        discordSyncedHash: eventContentHash(c),
        discordSyncedAt: new Date(),
        recurrenceRule: d.recurrence ?? null,
      })
      // Idempotent: if a concurrent run (or the synchronous create path) already
      // linked this Discord id, skip rather than create a duplicate row.
      // The unique index is PARTIAL (WHERE discord_event_id IS NOT NULL), so the
      // ON CONFLICT must repeat that predicate to match it. For onConflictDoNothing
      // the predicate option is `where` (NOT `targetWhere`, which is silently
      // ignored here and yields a 42P10 "no matching constraint" error).
      .onConflictDoNothing({ target: events.discordEventId, where: isNotNull(events.discordEventId) })
      .returning({ id: events.id });
    if (inserted.length) result.imported++;
  }

  if (result.imported || result.pulled || result.pushed || result.cancelled || result.completed || result.deferred) {
    logger.info(result, "reconcileDiscordEvents applied changes");
  }
  return result;
}

export type SignupResult =
  | { ok: true }
  | { ok: false; httpStatus: number; error: string };

export async function signUpAsEventNpc(opts: {
  eventId: number;
  userId: string;
  characterId: number | null;
  note: string | null;
}): Promise<SignupResult> {
  const [event] = await db.select().from(events).where(eq(events.id, opts.eventId));
  if (!event) return { ok: false, httpStatus: 404, error: "Event not found" };
  if (event.status === "cancelled") return { ok: false, httpStatus: 409, error: "Event is cancelled" };
  if (!eventNeedsNpcs(event)) return { ok: false, httpStatus: 409, error: "This event is not accepting NPC sign-ups" };
  // Validate character ownership when supplied.
  let characterId: number | null = null;
  if (opts.characterId != null) {
    const [c] = await db.select().from(characters).where(eq(characters.id, opts.characterId));
    if (c && c.ownerId === opts.userId) characterId = c.id;
  }
  // Idempotent: a partial unique index keeps at most one active sign-up per
  // (event, user). onConflictDoNothing avoids a 500 on a double-submit race.
  await db
    .insert(eventNpcSignups)
    .values({ eventId: opts.eventId, userId: opts.userId, characterId, note: opts.note, state: "signed_up" })
    .onConflictDoNothing();
  return { ok: true };
}

export async function withdrawEventNpcSignup(opts: { eventId: number; userId: string }): Promise<SignupResult> {
  await db
    .update(eventNpcSignups)
    .set({ state: "withdrawn" })
    .where(
      and(
        eq(eventNpcSignups.eventId, opts.eventId),
        eq(eventNpcSignups.userId, opts.userId),
        eq(eventNpcSignups.state, "signed_up"),
      ),
    );
  return { ok: true };
}
