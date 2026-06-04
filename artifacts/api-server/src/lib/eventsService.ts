import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  events,
  eventNpcSignups,
  users,
  characters,
  type Event,
} from "@workspace/db";
import {
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
} from "./discord";
import { getMissionContext } from "./missionsConfig";
import { checkDiscordEventConflict } from "./missionsService";

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

export const EVENT_TYPES = ["session", "social", "other"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
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
// Discord scheduled-event sync (gated by the shared missions Test/Live switch).
// Never throws — failures are persisted to discordSyncError and returned.
// ---------------------------------------------------------------------------
export async function syncEventDiscordEvent(
  event: Event,
  live: boolean,
): Promise<{ discordEventId: string | null; discordSyncError: string | null }> {
  if (!live) {
    return { discordEventId: event.discordEventId, discordSyncError: null };
  }
  // Cancelled: tear down any linked Discord event.
  if (event.status === "cancelled") {
    if (!event.discordEventId) return { discordEventId: null, discordSyncError: null };
    const res = await deleteGuildScheduledEvent(event.discordEventId);
    return res.ok
      ? { discordEventId: null, discordSyncError: null }
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
  if (res.ok) return { discordEventId: res.id, discordSyncError: null };
  // Keep the old id on failure so a later retry can still modify it.
  return { discordEventId: event.discordEventId, discordSyncError: res.error };
}

// Reuse the mission conflict check (both share the same Discord guild events).
export async function checkEventConflict(opts: {
  startAt: Date;
  endAt: Date;
  excludeEventId?: string | null;
}) {
  const durationMinutes = Math.max(1, Math.round((opts.endAt.getTime() - opts.startAt.getTime()) / 60_000));
  return checkDiscordEventConflict({ startAt: opts.startAt, durationMinutes, excludeEventId: opts.excludeEventId });
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
    needsNpcs: e.needsNpcs,
    npcBlurb: e.npcBlurb,
    createdById: e.createdById,
    createdByName: e.createdByName,
    hasDiscordEvent: !!e.discordEventId,
    discordSyncError: viewer.isManager ? e.discordSyncError : null,
    signupCount: signups.length,
    mySignup,
    canManage: viewer.isManager,
    ...(includeSignups && viewer.isManager ? { signups } : {}),
  };
}

export async function listEvents(viewer: EventViewer, opts?: { limit?: number }): Promise<EventView[]> {
  const limit = Math.min(1000, opts?.limit ?? 500);
  const rows = await db
    .select({
      e: events,
      createdGlobalName: users.globalName,
      createdUsername: users.username,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.createdById))
    .where(ne(events.status, "cancelled"))
    .orderBy(desc(events.startAt))
    .limit(limit);
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
  return toView(
    { ...row.e, createdByName: userDisplayName({ globalName: row.createdGlobalName, username: row.createdUsername }) },
    viewer,
    signupsByEvent.get(id) ?? [],
    true,
  );
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
  if (sync.discordEventId !== created.discordEventId || sync.discordSyncError !== created.discordSyncError) {
    await db.update(events).set(sync).where(eq(events.id, created.id));
    return { ...created, ...sync };
  }
  return created;
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
  if (sync.discordEventId !== updated.discordEventId || sync.discordSyncError !== updated.discordSyncError) {
    await db.update(events).set(sync).where(eq(events.id, id));
    return { ...updated, ...sync };
  }
  return updated;
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
  if (sync.discordEventId !== updated.discordEventId || sync.discordSyncError !== updated.discordSyncError) {
    await db.update(events).set(sync).where(eq(events.id, id));
    return { ...updated, ...sync };
  }
  return updated;
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
  if (!event.needsNpcs) return { ok: false, httpStatus: 409, error: "This event is not accepting NPC sign-ups" };
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
