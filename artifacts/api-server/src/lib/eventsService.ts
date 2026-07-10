import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  botConfig,
  events,
  eventNpcSignups,
  missions,
  missionActorPayments,
  users,
  characters,
  type Event,
  type EventRecurrenceRule,
} from "@workspace/db";
import {
  createGroupCalendarEvent,
  updateGroupCalendarEvent,
  deleteGroupCalendarEvent,
  vrchatCredsConfigured,
  recordSessionError,
  type VrchatCalendarInput,
} from "./vrchatClient";
import {
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
  listGuildScheduledEvents,
  fetchDiscordUser,
  type GuildScheduledEvent,
} from "./discord";
import { getMissionContext } from "./missionsConfig";
import { checkDiscordEventConflict, payStandaloneActors } from "./missionsService";
import { recordAudit } from "./audit";
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

// Main Sessions are auto-titled "NCRP Main Event: Session N". They are created
// on-site (createEvent) as eventType "session", but when the SAME event is seen
// from the Discord side first — e.g. on a fresh deploy whose DB imported the
// schedule from Discord rather than authoring it — the import path has no way to
// know it's the headline weekly game and defaults it to "social". That silently
// drops the NPC sign-up (eventNeedsNpcs derives off "session"). Detect the
// canonical title so both the import default and the reconcile self-heal can
// classify these as sessions without an operator re-typing each week.
const MAIN_SESSION_TITLE = /main event\b.*\bsession\b/i;
export function isMainSessionTitle(title: string): boolean {
  return MAIN_SESSION_TITLE.test(title);
}
// eventType for a freshly-imported Discord event: promote Main Sessions, else
// the generic "social" default.
export function classifyImportedEventType(title: string): EventType {
  return isMainSessionTitle(title) ? "session" : "social";
}

export interface EventSignupView {
  id: number;
  userId: string;
  userName: string | null;
  characterId: number | null;
  characterName: string | null;
  note: string | null;
  // NPC lifecycle (mirrors mission NPC sign-ups). An organizer confirms each
  // volunteer as attended (pays) or no_show; players see the resolved state +
  // payout status.
  state: string;
  payAmount: number | null;
  paymentStatus: string;
  paymentError: string | null;
  paidAt: string | null;
  createdAt: string | null;
  // For recurring events, the concrete occurrence (ISO startAt) this signup
  // targets. Null = the event's single/base occurrence (or a legacy row from
  // before per-occurrence scoping — treated as the event's current startAt).
  occurrenceStartAt: string | null;
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
  hasVrchatEvent: boolean;
  vrchatSyncError: string | null;
  signupCount: number;
  mySignup: EventSignupView | null;
  // ISO occurrence startAt instants the caller is actively signed up for
  // (state signed_up). Legacy/null-occurrence signups map onto the event's
  // current startAt. The calendar matches these against its expanded
  // occurrences so a recurring event only badges the occurrence(s) actually
  // signed up for.
  myOccurrences: string[];
  canManage: boolean;
  // Normalised recurrence (null = single occurrence). Expanded onto the
  // calendar client-side so a weekly Discord event shows on every occurrence.
  recurrence: EventRecurrenceRule | null;
  // Only populated on the detail view for managers.
  signups?: EventSignupView[];
  // userIds already paid as an actor for THIS event (managers, detail only).
  // Used to lock already-paid NPCs in the roster so they can't be paid twice.
  paidActorUserIds?: string[];
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

// A drizzle executor: either the root db handle or a transaction handle. Lets
// helpers run inside or outside a transaction.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Persist a sync result onto a row. Always writes id + error (idempotent); only
// touches the synced hash/timestamp when the sync actually attempted a push.
async function applyEventSync(
  id: number,
  fallback: Event,
  sync: EventSyncResult,
  executor: Executor = db,
): Promise<Event> {
  const set: Partial<typeof events.$inferInsert> = {
    discordEventId: sync.discordEventId,
    discordSyncError: sync.discordSyncError,
  };
  if (sync.discordSyncedHash !== undefined) set.discordSyncedHash = sync.discordSyncedHash;
  if (sync.discordSyncedAt !== undefined) set.discordSyncedAt = sync.discordSyncedAt;
  const [updated] = await executor.update(events).set(set).where(eq(events.id, id)).returning();
  return updated ?? fallback;
}

// ===========================================================================
// VRChat group-calendar mirror (third downstream target beside Discord).
//
// The website stays source of truth. Only Main Sessions + social events are
// mirrored — missions live in a separate table and are never handled here, and
// 'other' events are excluded. The mirror is double-gated, independent of the
// missions Test/Live switch:
//   1. `vrchat_calendar_sync_enabled` bot_config kill-switch (defaults OFF).
//   2. The deployment write-gate (REPLIT_DEPLOYMENT=1 / ALLOW_EXTERNAL_WRITES=1)
//      so dev and one-off scripts never touch the real VRChat API.
// Plus VRChat creds must be configured. When any gate is closed every helper
// here is a silent no-op that leaves the stored mirror state untouched.
//
// VRChat's calendar API is unofficial and rate-limited (~1 write/60s) with no
// recurrence field, so recurring rows are mirrored as their single anchor
// occurrence and past events are never backfilled on create.
// ===========================================================================
export const VRCHAT_SYNC_FLAG = "vrchat_calendar_sync_enabled";
// VRChat's calendar API only accepts a fixed category enum (music, gaming,
// hangout, roleplaying, exploration, film_media, arts, wellness, education,
// performance, avatars, dance, other) — our own event types ("session" /
// "social") are NOT valid values and get rejected with a 400. Map them onto the
// closest VRChat category instead.
const VRCHAT_CATEGORY_BY_TYPE: Record<string, string> = {
  session: "roleplaying",
  social: "hangout",
};
const VRCHAT_CATEGORY_FALLBACK = "roleplaying";
function vrchatCategoryFor(e: Event): string {
  return VRCHAT_CATEGORY_BY_TYPE[e.eventType] ?? VRCHAT_CATEGORY_FALLBACK;
}
const VRCHAT_ACCESS_TYPE = "public" as const;
// Cap VRChat writes per reconcile cycle to respect the ~1 write/60s rate limit;
// remaining stale rows are picked up on later cycles.
const MAX_VRCHAT_WRITES_PER_CYCLE = 3;

function vrchatWritesAllowed(): boolean {
  return (
    process.env.REPLIT_DEPLOYMENT === "1" || process.env.ALLOW_EXTERNAL_WRITES === "1"
  );
}

export async function isVrchatCalendarSyncEnabled(): Promise<boolean> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, VRCHAT_SYNC_FLAG));
    return row?.value === true;
  } catch (err) {
    logger.warn({ err }, "vrchat calendar sync flag read failed; treating as off");
    return false;
  }
}

async function vrchatSyncEnabled(): Promise<boolean> {
  return vrchatWritesAllowed() && vrchatCredsConfigured() && (await isVrchatCalendarSyncEnabled());
}

// Only Main Sessions + social events get a VRChat calendar entry. Cancelled or
// retyped ('other') rows are torn down.
function shouldHaveVrchatEntry(e: Event): boolean {
  return e.status !== "cancelled" && (e.eventType === "session" || e.eventType === "social");
}

// Strip Discord mention/channel tokens so VRChat shows readable text, not raw
// `<@123>` / `<#123>` noise. Read-time only — the stored description is left as
// is so the Discord content hash stays stable.
function sanitizeVrchatText(text: string | null): string {
  if (!text) return "";
  return text
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

interface VrchatContent {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  category: string;
}

function buildVrchatContent(e: Event): VrchatContent {
  return {
    title: e.title.trim().slice(0, 100) || "NCRP Event",
    description: sanitizeVrchatText(e.description).slice(0, 1000),
    startsAt: new Date(e.startAt).toISOString(),
    endsAt: new Date(e.endAt).toISOString(),
    category: vrchatCategoryFor(e),
  };
}

// Fingerprint of everything we push to VRChat; lets the sync skip no-op writes.
function vrchatContentHash(e: Event): string {
  const c = buildVrchatContent(e);
  return createHash("sha256")
    .update(JSON.stringify([c.title, c.description, c.startsAt, c.endsAt, VRCHAT_ACCESS_TYPE, c.category]))
    .digest("hex");
}

function toVrchatInput(c: VrchatContent, opts: { notify: boolean }): VrchatCalendarInput {
  return {
    title: c.title,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    ...(c.description ? { description: c.description } : {}),
    category: c.category,
    accessType: VRCHAT_ACCESS_TYPE,
    sendCreationNotification: opts.notify,
  };
}

export interface VrchatEventSyncResult {
  vrchatCalendarId: string | null;
  vrchatSyncError: string | null;
  // Only present when a write was attempted; undefined = leave hash/at untouched.
  vrchatSyncedHash?: string | null;
  vrchatSyncedAt?: Date | null;
}

// Mirror one website event to the VRChat group calendar. Self-gated and never
// throws — failures are persisted to vrchatSyncError (and the shared session
// lastError) and returned. The group is notified only on first create, and only
// when notifyOnCreate is true: inline syncs (a brand-new event created/edited on
// the site) notify, but the reconcile sweep — which backfills pre-existing rows —
// passes false so a bulk backfill doesn't spam the group with one ping per event.
export async function syncEventVrchatCalendar(
  event: Event,
  opts: { notifyOnCreate?: boolean } = {},
): Promise<VrchatEventSyncResult> {
  const notifyOnCreate = opts.notifyOnCreate ?? true;
  if (!(await vrchatSyncEnabled())) {
    return { vrchatCalendarId: event.vrchatCalendarId, vrchatSyncError: null };
  }

  // Cancelled or no-longer-qualifying: tear down any linked calendar entry.
  if (!shouldHaveVrchatEntry(event)) {
    if (!event.vrchatCalendarId) return { vrchatCalendarId: null, vrchatSyncError: null };
    try {
      await deleteGroupCalendarEvent(event.vrchatCalendarId);
      return { vrchatCalendarId: null, vrchatSyncError: null, vrchatSyncedHash: null, vrchatSyncedAt: new Date() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordSessionError(msg);
      return { vrchatCalendarId: event.vrchatCalendarId, vrchatSyncError: msg };
    }
  }

  const content = buildVrchatContent(event);
  const hash = vrchatContentHash(event);
  try {
    if (!event.vrchatCalendarId) {
      // Never backfill past events on create (e.g. when the switch is first
      // flipped on with historical rows present).
      if (new Date(event.endAt).getTime() < Date.now()) {
        return { vrchatCalendarId: null, vrchatSyncError: null };
      }
      const id = await createGroupCalendarEvent(toVrchatInput(content, { notify: notifyOnCreate }));
      return { vrchatCalendarId: id, vrchatSyncError: null, vrchatSyncedHash: hash, vrchatSyncedAt: new Date() };
    }
    if (event.vrchatSyncedHash === hash) {
      return { vrchatCalendarId: event.vrchatCalendarId, vrchatSyncError: null };
    }
    await updateGroupCalendarEvent(event.vrchatCalendarId, toVrchatInput(content, { notify: false }));
    return { vrchatCalendarId: event.vrchatCalendarId, vrchatSyncError: null, vrchatSyncedHash: hash, vrchatSyncedAt: new Date() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSessionError(msg);
    // Keep the old id on failure so a later retry can still modify it.
    return { vrchatCalendarId: event.vrchatCalendarId, vrchatSyncError: msg };
  }
}

async function applyEventVrchatSync(
  id: number,
  fallback: Event,
  sync: VrchatEventSyncResult,
  executor: Executor = db,
): Promise<Event> {
  const set: Partial<typeof events.$inferInsert> = {
    vrchatCalendarId: sync.vrchatCalendarId,
    vrchatSyncError: sync.vrchatSyncError,
  };
  if (sync.vrchatSyncedHash !== undefined) set.vrchatSyncedHash = sync.vrchatSyncedHash;
  if (sync.vrchatSyncedAt !== undefined) set.vrchatSyncedAt = sync.vrchatSyncedAt;

  // Guard the create path against a concurrent writer: the CRUD paths and the
  // cron reconcile can both mirror the same row, each having read
  // vrchatCalendarId = null and each minting a NEW calendar id. Claim a freshly
  // minted id only if the row still has none; if a concurrent path already
  // claimed one, OUR VRChat event is an orphan — delete it to compensate and
  // keep the winner's id rather than overwriting it (which would leak an event).
  const isFreshCreate =
    !sync.vrchatSyncError && !fallback.vrchatCalendarId && !!sync.vrchatCalendarId;
  if (isFreshCreate) {
    const [claimed] = await executor
      .update(events)
      .set(set)
      .where(and(eq(events.id, id), isNull(events.vrchatCalendarId)))
      .returning();
    if (claimed) return claimed;
    // Lost the race: tear down our orphaned calendar event, return the row as-is.
    try {
      await deleteGroupCalendarEvent(sync.vrchatCalendarId!);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), eventId: id },
        "failed to delete orphaned VRChat event after losing a concurrent create race",
      );
    }
    const [current] = await executor.select().from(events).where(eq(events.id, id));
    return current ?? fallback;
  }

  const [updated] = await executor.update(events).set(set).where(eq(events.id, id)).returning();
  return updated ?? fallback;
}

// Run the VRChat sync for a row and persist the result. Used by the website CRUD
// paths after the Discord sync has been applied. Returns the updated row. When
// any gate is closed this is a true no-op: the stored vrchat* columns (including
// a previously-recorded vrchatSyncError) are left untouched.
async function syncAndApplyVrchat(event: Event): Promise<Event> {
  if (!(await vrchatSyncEnabled())) return event;
  const sync = await syncEventVrchatCalendar(event);
  return applyEventVrchatSync(event.id, event, sync);
}

// Bounded backfill/repair sweep for the VRChat mirror, run after the Discord
// reconcile in the same cron. Mirrors upcoming qualifying rows whose entry is
// missing or stale, capped per cycle to respect the rate limit. A no-op unless
// the kill-switch + deployment gate are open.
export async function reconcileVrchatCalendar(): Promise<{ synced: number; failed: number }> {
  if (!(await vrchatSyncEnabled())) return { synced: 0, failed: 0 };

  const now = Date.now();
  // Two candidate sets: (1) upcoming qualifying rows (create/refresh) and
  // (2) ANY row still carrying a vrchatCalendarId — so rows cancelled or retyped
  // to mission/other (incl. while the switch was off) get torn down once sync is
  // re-enabled, not just freshly-edited ones.
  const rows = await db
    .select()
    .from(events)
    .where(
      or(
        and(ne(events.status, "cancelled"), inArray(events.eventType, ["session", "social"])),
        isNotNull(events.vrchatCalendarId),
      ),
    );

  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    if (shouldHaveVrchatEntry(row)) {
      // Never backfill past events; only create/refresh upcoming ones.
      if (new Date(row.endAt).getTime() < now) continue;
      const needs = !row.vrchatCalendarId || row.vrchatSyncedHash !== vrchatContentHash(row);
      if (!needs) continue;
    } else {
      // Teardown candidate: only act if there is actually an entry to delete.
      if (!row.vrchatCalendarId) continue;
    }
    // Backfill/reconcile sweep: never notify on create. A bulk backfill would
    // otherwise ping the whole group once per event.
    const sync = await syncEventVrchatCalendar(row, { notifyOnCreate: false });
    await applyEventVrchatSync(row.id, row, sync);
    if (sync.vrchatSyncError) failed++;
    else synced++;
    if (synced + failed >= MAX_VRCHAT_WRITES_PER_CYCLE) break;
  }
  if (synced || failed) logger.info({ synced, failed }, "reconcileVrchatCalendar applied changes");
  return { synced, failed };
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
      state: eventNpcSignups.state,
      payAmount: eventNpcSignups.payAmount,
      paymentStatus: eventNpcSignups.paymentStatus,
      paymentError: eventNpcSignups.paymentError,
      paidAt: eventNpcSignups.paidAt,
      createdAt: eventNpcSignups.createdAt,
      occurrenceStartAt: eventNpcSignups.occurrenceStartAt,
      characterId: eventNpcSignups.characterId,
      globalName: users.globalName,
      username: users.username,
      characterName: characters.name,
    })
    .from(eventNpcSignups)
    .leftJoin(users, eq(users.id, eventNpcSignups.userId))
    .leftJoin(characters, eq(characters.id, eventNpcSignups.characterId))
    // Include resolved sign-ups (attended/no_show) so the manager roster shows
    // the full history and players see their own resolved status; only the
    // withdrawn state is hidden.
    .where(and(inArray(eventNpcSignups.eventId, eventIds), ne(eventNpcSignups.state, "withdrawn")));
  for (const r of rows) {
    const view: EventSignupView = {
      id: r.id,
      userId: r.userId,
      userName: userDisplayName({ globalName: r.globalName, username: r.username }),
      characterId: r.characterId,
      characterName: r.characterName ?? null,
      note: r.note,
      state: r.state,
      payAmount: r.payAmount,
      paymentStatus: r.paymentStatus,
      paymentError: r.paymentError,
      paidAt: iso(r.paidAt),
      createdAt: iso(r.createdAt),
      occurrenceStartAt: iso(r.occurrenceStartAt),
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
  // A recurring event can carry one signup per occurrence, so the viewer may
  // have several rows. mySignup keeps its "current occurrence" meaning for the
  // detail page: the signup targeting the event's current startAt (Discord
  // rolls startAt forward to the next occurrence) or a legacy/null-occurrence
  // row. myOccurrences lists every active occurrence for calendar badging.
  const startMs = e.startAt.getTime();
  const mine = signups.filter((s) => s.userId === viewer.id);
  const mySignup =
    mine.find((s) => {
      if (s.occurrenceStartAt == null) return true;
      const t = new Date(s.occurrenceStartAt).getTime();
      return t === startMs;
    }) ?? null;
  const myOccurrences = Array.from(
    new Set(
      mine
        .filter((s) => s.state === "signed_up")
        .map((s) => s.occurrenceStartAt ?? iso(e.startAt)!),
    ),
  );
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
    hasVrchatEvent: !!e.vrchatCalendarId,
    vrchatSyncError: viewer.isManager ? e.vrchatSyncError : null,
    // Active (still-awaiting-confirmation) sign-ups only; the roster now also
    // carries resolved attended/no_show rows for history, which must not inflate
    // the calendar's "needs N NPCs" count.
    signupCount: signups.filter((s) => s.state === "signed_up").length,
    mySignup,
    myOccurrences,
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
  if (viewer.isManager) {
    const paidRows = await db
      .select({ userId: missionActorPayments.userId })
      .from(missionActorPayments)
      .where(and(eq(missionActorPayments.eventId, id), eq(missionActorPayments.paymentStatus, "paid")));
    view.paidActorUserIds = [...new Set(paidRows.map((r) => r.userId))];
  }
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
  const afterDiscord = await applyEventSync(created.id, created, sync);
  return syncAndApplyVrchat(afterDiscord);
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
  const afterDiscord = await applyEventSync(id, updated, sync);
  return syncAndApplyVrchat(afterDiscord);
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
  const afterDiscord = await applyEventSync(id, updated, sync);
  return syncAndApplyVrchat(afterDiscord);
}

// ---------------------------------------------------------------------------
// Convert event <-> mission (REPLACE). A single DB transaction soft-cancels the
// original (raw status flip — NO cancel-sync helper, so NO Discord API call)
// and creates the counterpart row. The linked Discord scheduled event is HANDED
// OFF: nulled on the original and carried onto the new row in the same tx, so
// the merged calendar shows exactly one entry (cancelled rows are filtered out)
// and the Discord event is never torn down or recreated. Actor-payment history
// (mission_actor_payments) is deliberately left pointing at the cancelled
// original — it is historical and must not be rewritten.
// ---------------------------------------------------------------------------
export interface ConvertResult {
  ok: boolean;
  error?: string;
  httpStatus?: number;
  newId?: number;
}

export interface EventToMissionFields {
  tier: number;
  playerPay: number;
  npcPayAmount: number;
  slots: number;
  maxPlayers: number;
  jobType: string | null;
  worldLink: string | null;
  requestedSkills: string | null;
  client: string | null;
  notesForPlayers: string | null;
  /** Null derives the duration from the event's start/end window. */
  durationMinutes: number | null;
}

export async function convertEventToMission(
  eventId: number,
  fixerId: string,
  f: EventToMissionFields,
): Promise<ConvertResult> {
  return await db.transaction(async (tx) => {
    const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!ev) return { ok: false, error: "Event not found", httpStatus: 404 };
    if (ev.status === "cancelled") {
      return { ok: false, error: "Event is already cancelled", httpStatus: 409 };
    }
    const windowMin = Math.max(
      1,
      Math.round((ev.endAt.getTime() - ev.startAt.getTime()) / 60000),
    );
    const durationMinutes = f.durationMinutes ?? windowMin;
    // Hand the Discord scheduled-event over to the new mission row.
    const handoffDiscordId = ev.discordEventId;

    const [mission] = await tx
      .insert(missions)
      .values({
        title: ev.title,
        tier: f.tier,
        playerPay: f.playerPay,
        npcPayAmount: f.npcPayAmount,
        location: ev.location,
        description: ev.description,
        imageUrl: ev.imageUrl,
        status: "open",
        workflowState: "posted",
        fixerId,
        startAt: ev.startAt,
        durationMinutes,
        slots: f.slots,
        worldLink: f.worldLink,
        jobType: f.jobType,
        requestedSkills: f.requestedSkills,
        client: f.client,
        notesForPlayers: f.notesForPlayers,
        maxPlayers: f.maxPlayers,
        discordEventId: handoffDiscordId,
      })
      .returning();

    await tx
      .update(events)
      .set({ status: "cancelled", discordEventId: null, updatedAt: new Date() })
      .where(eq(events.id, eventId));

    return { ok: true, newId: mission.id };
  });
}

export interface MissionToEventFields {
  eventType: EventType;
  needsNpcs: boolean;
  npcBlurb: string | null;
  /** Null derives the end from the mission start + durationMinutes. */
  endAt: Date | null;
}

export async function convertMissionToEvent(
  missionId: number,
  createdById: string,
  f: MissionToEventFields,
): Promise<ConvertResult> {
  const txResult = await db.transaction(
    async (tx): Promise<{ ok: false; error: string; httpStatus: number } | { ok: true; ev: Event }> => {
      const [m] = await tx.select().from(missions).where(eq(missions.id, missionId)).for("update");
      if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
      if (m.status === "cancelled") {
        return { ok: false, error: "Mission is already cancelled", httpStatus: 409 };
      }
      if (!m.startAt) {
        return { ok: false, error: "Mission has no start time; set one before converting", httpStatus: 409 };
      }
      const startAt = m.startAt;
      const endAt = f.endAt ?? new Date(startAt.getTime() + m.durationMinutes * 60000);
      if (endAt.getTime() <= startAt.getTime()) {
        return { ok: false, error: "End time must be after start time", httpStatus: 400 };
      }
      const handoffDiscordId = m.discordEventId;

      // Null the Discord id on the mission FIRST so the partial-unique index on
      // events.discord_event_id can't collide when the new event claims it.
      await tx
        .update(missions)
        .set({ status: "cancelled", discordEventId: null, updatedAt: new Date() })
        .where(eq(missions.id, missionId));

      const [ev] = await tx
        .insert(events)
        .values({
          title: m.title,
          eventType: f.eventType,
          location: m.location,
          description: m.description,
          imageUrl: m.imageUrl,
          startAt,
          endAt,
          status: "scheduled",
          needsNpcs: f.needsNpcs,
          npcBlurb: f.needsNpcs ? f.npcBlurb : null,
          createdById,
          discordEventId: handoffDiscordId,
        })
        .returning();

      return { ok: true, ev };
    },
  );
  if (!txResult.ok) return txResult;
  // After commit, re-sync the handed-off Discord scheduled event to EVENT format
  // (title/description/end) — matching createEvent. The conversion only moves the
  // Discord id; without this the event keeps its old mission-formatted title
  // until the discord_event_sync cron reconciles it. External call lives outside
  // the transaction; a failure self-heals on the next reconcile pass.
  try {
    const ctx = await getMissionContext();
    const sync = await syncEventDiscordEvent(txResult.ev, ctx.live);
    await applyEventSync(txResult.ev.id, txResult.ev, sync);
  } catch (err) {
    logger.warn({ err, eventId: txResult.ev.id }, "convertMissionToEvent: Discord resync failed; reconcile cron will heal");
  }
  return { ok: true, newId: txResult.ev.id };
}

// ---------------------------------------------------------------------------
// Main Session calendar coverage. Main Sessions run every Sunday but are stored
// as DISCRETE rows (one per week, each its own Discord scheduled-event), NOT a
// recurrence rule (see memory: main-sessions-discrete) — so the calendar only
// extends as far out as rows physically exist. This clones the latest session
// forward one week + one session-number at a time ("Session 69" → "Session 70")
// until coverage reaches the horizon (~3 months out), going through createEvent
// so each new row rides the normal Discord push gated on the live flag, exactly
// like a staff-created event.
//
// Idempotent: only fills Sundays AFTER the latest existing session, skips any
// week that already has a session row, and no-ops once coverage reaches the
// horizon. Safe to call repeatedly (e.g. from a daily cron).
export interface BackfillMainSessionsResult {
  created: number;
  titles: string[];
  /** Existing website-only session rows that were (re)pushed to Discord. */
  healed: number;
  /** Titles of the rows pushed to Discord by the self-heal pass. */
  healedTitles: string[];
  reason?: string; // why nothing (or less) was created, for the job log
}

const SESSION_TITLE_NUM = /^(.*?)(\d+)\s*$/;
const SESSION_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function sessionDayKeyUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

export async function backfillMainSessions(
  opts: { horizonDays?: number; dryRun?: boolean } = {},
): Promise<BackfillMainSessionsResult> {
  const horizonDays = opts.horizonDays ?? 90;
  const dryRun = opts.dryRun ?? false;

  const sessions = (await db.select().from(events).where(eq(events.eventType, "session")))
    .filter((e) => e.status !== "cancelled" && e.startAt)
    .sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());

  if (sessions.length === 0) {
    return { created: 0, titles: [], healed: 0, healedTitles: [], reason: "no existing session to seed from" };
  }

  // Self-heal BEFORE the horizon early-returns: a session row can exist on the
  // website yet never have been pushed to Discord — e.g. it was created by this
  // backfill/cron while the Live switch was off (createEvent silently defers the
  // push), and the reconcile cron only updates rows ALREADY linked to Discord,
  // never creating an event for a website-only row. When Live, push any future,
  // non-cancelled session that's still missing its Discord event so the Discord
  // schedule matches the calendar. Must run even when coverage already reaches
  // the horizon, since the gap can sit entirely below the latest row.
  const { healed, healedTitles } = await healUnsyncedSessions(sessions, dryRun);

  const last = sessions[sessions.length - 1]!;
  const m = last.title.match(SESSION_TITLE_NUM);
  if (!m) {
    return { created: 0, titles: [], healed, healedTitles, reason: `cannot parse session number from "${last.title}"` };
  }
  if (!last.startAt || !last.endAt) {
    return { created: 0, titles: [], healed, healedTitles, reason: `latest session #${last.id} missing start/end time` };
  }

  const prefix = m[1]!;
  let num = Number(m[2]);
  const durationMs = last.endAt.getTime() - last.startAt.getTime();
  const existingDays = new Set(sessions.map((e) => sessionDayKeyUTC(e.startAt!)));
  const horizon = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000);

  if (last.startAt.getTime() >= horizon.getTime()) {
    return { created: 0, titles: [], healed, healedTitles, reason: "coverage already reaches horizon" };
  }

  let start = new Date(last.startAt.getTime());
  const titles: string[] = [];
  // Hard cap so a clock/duration anomaly can never spin into an unbounded
  // create loop; ample for a 90-day horizon stepped one week at a time.
  const maxIterations = Math.ceil(horizonDays / 7) + 8;

  for (let i = 0; i < maxIterations; i++) {
    start = new Date(start.getTime() + SESSION_WEEK_MS);
    num += 1;
    const reachedHorizon = start.getTime() >= horizon.getTime();
    if (!existingDays.has(sessionDayKeyUTC(start))) {
      const title = `${prefix}${num}`;
      if (!dryRun) {
        await createEvent(
          {
            title,
            eventType: "session",
            location: last.location,
            description: last.description,
            imageUrl: last.imageUrl,
            startAt: start,
            endAt: new Date(start.getTime() + durationMs),
            needsNpcs: last.needsNpcs,
            npcBlurb: last.npcBlurb,
          },
          last.createdById ?? "system",
        );
      }
      titles.push(title);
      existingDays.add(sessionDayKeyUTC(start));
    }
    if (reachedHorizon) break;
  }

  return { created: titles.length, titles, healed, healedTitles };
}

// Push any future, non-cancelled session row that exists on the website but has
// no linked Discord event. Only mutates Discord when the shared Live switch is
// on (in Test mode the push is a no-op, exactly like createEvent). dryRun lists
// the rows it WOULD push without touching Discord.
async function healUnsyncedSessions(
  sessions: Event[],
  dryRun: boolean,
): Promise<{ healed: number; healedTitles: string[] }> {
  const now = Date.now();
  const unsynced = sessions.filter((e) => !e.discordEventId && e.startAt && e.startAt.getTime() > now);
  if (unsynced.length === 0) return { healed: 0, healedTitles: [] };
  if (dryRun) return { healed: unsynced.length, healedTitles: unsynced.map((e) => e.title) };

  const ctx = await getMissionContext();
  if (!ctx.live) return { healed: 0, healedTitles: [] };

  const healedTitles: string[] = [];
  for (const candidate of unsynced) {
    // Lock the row and re-check UNDER the lock before pushing. Two overlapping
    // heals (e.g. the daily cron overlapping a manual admin "Run job") could both
    // read discordEventId === null off the snapshot and double-create a Discord
    // event for one session — orphaning whichever id loses the DB write. The
    // FOR UPDATE makes the second worker block until the first commits, then it
    // sees the freshly-set id and skips. The lock spans the Discord create, which
    // is fine for this rare, single low-traffic row.
    const title = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(events).where(eq(events.id, candidate.id)).for("update");
      if (!locked || locked.discordEventId) return null;
      const sync = await syncEventDiscordEvent(locked, true);
      await applyEventSync(locked.id, locked, sync, tx);
      // Count only a genuine push (new Discord id, no error) so a transient
      // Discord failure is reported as still-unsynced, not silently "healed".
      return sync.discordEventId && !sync.discordSyncError ? locked.title : null;
    });
    if (title) healedTitles.push(title);
  }
  return { healed: healedTitles.length, healedTitles };
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
    if (missionIds.has(row.discordEventId)) {
      // A mission now owns this Discord id. This happens when the event row was
      // imported from Discord first and a mission was later created for (or
      // linked to) the same scheduled event — leaving a duplicate that renders
      // TWICE on the calendar (once as the mission, once as this event). The
      // mission system owns the Discord lifecycle, so retire this orphan: hide
      // it from the calendar (cancelled) and UNLINK the Discord id so the
      // cancelled-row teardown branch below never deletes the mission's live
      // Discord event. Website-only write → runs regardless of Live. Idempotent:
      // once unlinked the row no longer reaches here (caught by the null guard).
      await db
        .update(events)
        .set({ status: "cancelled", discordEventId: null, discordSyncError: null, discordSyncedAt: new Date() })
        .where(eq(events.id, row.id));
      result.cancelled++;
      continue;
    }
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

    // Self-heal Main Sessions that were imported as "social" (see
    // classifyImportedEventType). eventType is NOT part of the Discord content
    // hash, so — like the recurrence backfill above — this is a website-only
    // write that never triggers a spurious push. Promote-only (never demote) and
    // gated on the canonical Main Session title, so a deliberate non-session
    // classification of an unrelated event is never clobbered.
    if (row.status !== "cancelled" && row.eventType !== "session" && isMainSessionTitle(row.title)) {
      await db.update(events).set({ eventType: "session" }).where(eq(events.id, row.id));
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
        eventType: classifyImportedEventType(c.title),
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
  // Concrete occurrence being signed up for (recurring events). Defaults to
  // the event's current startAt so a signup always targets ONE occurrence and
  // never bleeds onto every projected future occurrence.
  occurrenceStartAt?: Date | null;
}): Promise<SignupResult> {
  const [event] = await db.select().from(events).where(eq(events.id, opts.eventId));
  if (!event) return { ok: false, httpStatus: 404, error: "Event not found" };
  if (event.status === "cancelled") return { ok: false, httpStatus: 409, error: "Event is cancelled" };
  if (!eventNeedsNpcs(event)) return { ok: false, httpStatus: 409, error: "This event is not accepting NPC sign-ups" };
  // Validate character ownership when supplied. Reject an unknown or
  // not-owned character rather than silently signing the user up anonymously —
  // the client believes the signup is tied to the chosen character.
  let characterId: number | null = null;
  if (opts.characterId != null) {
    const [c] = await db.select().from(characters).where(eq(characters.id, opts.characterId));
    if (!c) return { ok: false, httpStatus: 404, error: "Character not found" };
    if (c.ownerId !== opts.userId) return { ok: false, httpStatus: 403, error: "You can only sign up with a character you own" };
    characterId = c.id;
  }
  // Scope the signup to one concrete occurrence. Recurring events default to
  // the current startAt (Discord rolls it forward to the next occurrence);
  // single events store the occurrence too so withdraw/match logic is uniform.
  const occurrenceStartAt = opts.occurrenceStartAt ?? event.startAt;
  // Idempotent: a partial unique index keeps at most one active sign-up per
  // (event, user, occurrence). onConflictDoNothing avoids a 500 on a
  // double-submit race.
  await db
    .insert(eventNpcSignups)
    .values({
      eventId: opts.eventId,
      userId: opts.userId,
      characterId,
      note: opts.note,
      state: "signed_up",
      occurrenceStartAt,
    })
    .onConflictDoNothing();
  return { ok: true };
}

export async function withdrawEventNpcSignup(opts: {
  eventId: number;
  userId: string;
  // When supplied, withdraw only the signup for this occurrence (legacy
  // null-occurrence rows also match — they predate per-occurrence scoping and
  // semantically mean "the current occurrence"). When omitted, withdraw every
  // active signup on the event (legacy client behavior).
  occurrenceStartAt?: Date | null;
}): Promise<SignupResult> {
  const conds = [
    eq(eventNpcSignups.eventId, opts.eventId),
    eq(eventNpcSignups.userId, opts.userId),
    eq(eventNpcSignups.state, "signed_up"),
  ];
  if (opts.occurrenceStartAt != null) {
    conds.push(
      or(
        isNull(eventNpcSignups.occurrenceStartAt),
        eq(eventNpcSignups.occurrenceStartAt, opts.occurrenceStartAt),
      )!,
    );
  }
  await db
    .update(eventNpcSignups)
    .set({ state: "withdrawn" })
    .where(and(...conds));
  return { ok: true };
}

// Organizer (fixer/admin) confirms an event NPC sign-up: attended (pays the
// per-person fee) or no_show. Mirrors the mission NPC lifecycle
// (confirmNpcSignup) but, because events have no fixed NPC pay amount, the
// attended payout amount is supplied per confirm. The actual payout reuses the
// shared event-bound actor-pay path (payStandaloneActors), which dedups per
// (eventId, userId), credits via UnbelievaBoat, records the ledger, and is
// gated on Test/Live — so re-confirming never double-pays.
export async function confirmEventNpcSignup(opts: {
  eventId: number;
  signupId: number;
  action: "attended" | "no_show";
  amount: number;
  viewer: EventViewer;
  req?: Request;
}): Promise<{ ok: true } | { ok: false; error: string; httpStatus: number }> {
  if (!opts.viewer.isManager) {
    return { ok: false, error: "Only a fixer or admin can confirm NPC sign-ups", httpStatus: 403 };
  }
  const [signup] = await db
    .select()
    .from(eventNpcSignups)
    .where(eq(eventNpcSignups.id, opts.signupId));
  if (!signup || signup.eventId !== opts.eventId) {
    return { ok: false, error: "Sign-up not found", httpStatus: 404 };
  }
  if (signup.state === "withdrawn") {
    return { ok: false, error: "This sign-up was withdrawn", httpStatus: 409 };
  }
  const [event] = await db.select().from(events).where(eq(events.id, opts.eventId));
  if (!event) return { ok: false, error: "Event not found", httpStatus: 404 };
  if (event.status === "cancelled") {
    return { ok: false, error: "This event is cancelled. Cancelled events cannot pay NPCs.", httpStatus: 409 };
  }

  if (opts.action === "no_show") {
    await db
      .update(eventNpcSignups)
      .set({ state: "no_show", paymentStatus: "unpaid", payAmount: null, paymentError: null, paidAt: null })
      .where(eq(eventNpcSignups.id, signup.id));
    await recordAudit({
      req: opts.req,
      actorId: opts.viewer.id,
      category: "mission",
      action: "event.npc_no_show",
      targetType: "event",
      targetId: opts.eventId,
      message: `Marked event NPC sign-up ${signup.id} (user ${signup.userId}) as no-show`,
    });
    return { ok: true };
  }

  // action === "attended": idempotent if already paid/simulated for this event.
  if (signup.state === "attended" && (signup.paymentStatus === "paid" || signup.paymentStatus === "simulated")) {
    return { ok: true };
  }

  const amount = Math.max(0, Math.trunc(opts.amount));
  const now = new Date();
  const res = await payStandaloneActors(
    {
      eventName: event.title,
      eventType: event.eventType,
      eventDate: event.startAt,
      eventId: event.id,
      userIds: [signup.userId],
      amount,
    },
    { req: opts.req, actorId: opts.viewer.id },
  );

  // Map the single-actor payout result onto the sign-up's payment fields.
  // skipped means this actor was already paid for the event via another path
  // (the PAID dedup index fired) — mark paid so the row reflects reality, but do
  // NOT claim `amount` was disbursed this call, since this confirm paid nothing.
  let paymentStatus: string;
  let paymentError: string | null = null;
  let paidAt: Date | null = null;
  let paidAmount: number | null = null;
  if (!res.live) {
    paymentStatus = "simulated";
    paidAt = now;
    paidAmount = amount;
  } else if (res.paid > 0) {
    paymentStatus = "paid";
    paidAt = now;
    paidAmount = amount;
  } else if (res.skipped > 0) {
    // Already paid earlier — preserve any previously-recorded amount; never
    // overwrite it with this call's (unpaid) amount.
    paymentStatus = "paid";
    paidAt = signup.paidAt ?? now;
    paidAmount = signup.payAmount ?? null;
  } else {
    paymentStatus = "failed";
    paymentError = "UnbelievaBoat payout failed";
  }
  await db
    .update(eventNpcSignups)
    .set({ state: "attended", payAmount: paidAmount, paymentStatus, paymentError, paidAt })
    .where(eq(eventNpcSignups.id, signup.id));
  await recordAudit({
    req: opts.req,
    actorId: opts.viewer.id,
    category: "mission",
    action: "event.npc_attended",
    targetType: "event",
    targetId: opts.eventId,
    message: `Confirmed event NPC sign-up ${signup.id} (user ${signup.userId}) attended — ${paymentStatus}${amount > 0 ? ` (${amount.toLocaleString()} €$)` : ""}`,
  });
  return { ok: true };
}
