import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";
import { and, eq } from "drizzle-orm";
import { db, events, eventNpcSignups } from "@workspace/db";

const app = buildTestApp();

const future = (hoursFromNow: number) =>
  new Date(Date.now() + hoursFromNow * 3600_000).toISOString();

async function createValidEvent(actorId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/events")
    .set("x-test-user", actorId)
    .send({ title: "Heist Night", startAt: future(24), endAt: future(26), ...overrides });
}

describe("GET /events", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(401);
  });

  it("returns a list for any signed-in user", async () => {
    const player = await createUser();
    const res = await request(app).get("/api/events").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("POST /events", () => {
  it("forbids a non-manager", async () => {
    const player = await createUser();
    const res = await createValidEvent(player.id);
    expect(res.status).toBe(403);
  });

  it("validates title and the start/end window", async () => {
    const admin = await createAdmin();

    const noTitle = await request(app)
      .post("/api/events")
      .set("x-test-user", admin.id)
      .send({ startAt: future(24), endAt: future(26) });
    expect(noTitle.status).toBe(400);

    const badDates = await request(app)
      .post("/api/events")
      .set("x-test-user", admin.id)
      .send({ title: "X", startAt: "not-a-date", endAt: future(26) });
    expect(badDates.status).toBe(400);

    const endBeforeStart = await createValidEvent(admin.id, { startAt: future(26), endAt: future(24) });
    expect(endBeforeStart.status).toBe(400);
  });

  it("creates an event for a manager", async () => {
    const admin = await createAdmin();
    const res = await createValidEvent(admin.id);
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Heist Night");
    expect(res.body.id).toBeTruthy();
  });
});

describe("PATCH/DELETE /events/:id", () => {
  it("forbids a non-manager from editing or cancelling", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const created = await createValidEvent(admin.id);
    const id = created.body.id;

    const patch = await request(app)
      .patch(`/api/events/${id}`)
      .set("x-test-user", player.id)
      .send({ title: "Hacked" });
    expect(patch.status).toBe(403);

    const del = await request(app).delete(`/api/events/${id}`).set("x-test-user", player.id);
    expect(del.status).toBe(403);
  });

  it("lets a manager rename and then cancel an event", async () => {
    const admin = await createAdmin();
    const created = await createValidEvent(admin.id);
    const id = created.body.id;

    const patch = await request(app)
      .patch(`/api/events/${id}`)
      .set("x-test-user", admin.id)
      .send({ title: "Renamed Night" });
    expect(patch.status).toBe(200);
    expect(patch.body.title).toBe("Renamed Night");

    const del = await request(app).delete(`/api/events/${id}`).set("x-test-user", admin.id);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });

  it("404s a manager editing an unknown event", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch(`/api/events/999999`)
      .set("x-test-user", admin.id)
      .send({ title: "Ghost" });
    expect(res.status).toBe(404);
  });
});

describe("NPC sign-ups are per-occurrence", () => {
  async function createNpcEvent(adminId: string, overrides: Record<string, unknown> = {}) {
    const res = await createValidEvent(adminId, { needsNpcs: true, ...overrides });
    expect(res.status).toBe(201);
    return res.body as { id: number; startAt: string };
  }

  // Per-occurrence semantics only apply to RECURRING events (occurrence
  // timestamps on a single event now always mean "the event"). Recurrence is
  // normally backfilled from Discord, so tests set it directly.
  async function markRecurring(eventId: number) {
    await db
      .update(events)
      .set({
        recurrenceRule: { frequency: 2, interval: 1, byWeekday: [6], count: null, until: null },
      })
      .where(eq(events.id, eventId));
  }

  async function getEvent(id: number, userId: string) {
    const res = await request(app).get(`/api/events/${id}`).set("x-test-user", userId);
    expect(res.status).toBe(200);
    return res.body as {
      startAt: string;
      mySignup: { occurrenceStartAt?: string | null } | null;
      myOccurrences: string[];
    };
  }

  it("defaults a signup to the event's current startAt occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signup.status).toBe(200);

    const view = await getEvent(event.id, player.id);
    expect(view.mySignup).not.toBeNull();
    expect(view.myOccurrences).toEqual([view.startAt]);
  });

  it("rejects an invalid occurrenceStartAt", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    const bad = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: "not-a-date" });
    expect(bad.status).toBe(400);

    const badWithdraw = await request(app)
      .delete(`/api/events/${event.id}/npc-signups/me?occurrenceStartAt=not-a-date`)
      .set("x-test-user", player.id);
    expect(badWithdraw.status).toBe(400);
  });

  it("scopes a future-occurrence signup so it does not badge the current occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);
    await markRecurring(event.id);
    const later = future(24 * 7); // next week's occurrence of the recurring event

    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: later });
    expect(signup.status).toBe(200);

    const view = await getEvent(event.id, player.id);
    // Signed up for a LATER occurrence only — the current occurrence must not
    // show the viewer as signed up.
    expect(view.mySignup).toBeNull();
    expect(view.myOccurrences).toEqual([new Date(later).toISOString()]);
  });

  it("allows one signup per occurrence and withdraws only the targeted occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);
    await markRecurring(event.id);
    const later = future(24 * 7);

    const first = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: later });
    expect(second.status).toBe(200);

    let view = await getEvent(event.id, player.id);
    expect(view.myOccurrences.sort()).toEqual(
      [view.startAt, new Date(later).toISOString()].sort(),
    );

    // Withdraw ONLY the later occurrence; the current one must survive.
    const withdraw = await request(app)
      .delete(`/api/events/${event.id}/npc-signups/me?occurrenceStartAt=${encodeURIComponent(later)}`)
      .set("x-test-user", player.id);
    expect(withdraw.status).toBe(200);

    view = await getEvent(event.id, player.id);
    expect(view.mySignup).not.toBeNull();
    expect(view.myOccurrences).toEqual([view.startAt]);
  });

  it("treats a legacy null-occurrence row as the current occurrence and withdraws it by occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    // Legacy rows predate per-occurrence scoping and have NULL occurrence.
    await db.insert(eventNpcSignups).values({
      eventId: event.id,
      userId: player.id,
      characterId: null,
      note: null,
      state: "signed_up",
      occurrenceStartAt: null,
    });

    let view = await getEvent(event.id, player.id);
    expect(view.mySignup).not.toBeNull();
    expect(view.myOccurrences).toEqual([view.startAt]);

    // Occurrence-scoped withdraw must also clear the legacy null row.
    const withdraw = await request(app)
      .delete(
        `/api/events/${event.id}/npc-signups/me?occurrenceStartAt=${encodeURIComponent(view.startAt)}`,
      )
      .set("x-test-user", player.id);
    expect(withdraw.status).toBe(200);

    view = await getEvent(event.id, player.id);
    expect(view.mySignup).toBeNull();
    expect(view.myOccurrences).toEqual([]);
  });
});

describe("start-time changes on single events carry NPC sign-ups along", () => {
  async function createNpcEvent(adminId: string) {
    const res = await createValidEvent(adminId, { needsNpcs: true });
    expect(res.status).toBe(201);
    return res.body as { id: number; startAt: string };
  }

  async function activeRows(eventId: number) {
    return db
      .select()
      .from(eventNpcSignups)
      .where(and(eq(eventNpcSignups.eventId, eventId), eq(eventNpcSignups.state, "signed_up")));
  }

  it("re-stamps an active signup when a manager edits the start time", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signup.status).toBe(200);

    const newStart = future(30);
    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart, endAt: future(32) });
    expect(patch.status).toBe(200);

    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(new Date(newStart).toISOString());

    // The viewer still reads as signed up after the move.
    const view = await request(app).get(`/api/events/${event.id}`).set("x-test-user", player.id);
    expect(view.status).toBe(200);
    expect(view.body.mySignup).not.toBeNull();
    expect(view.body.myOccurrences).toEqual([new Date(newStart).toISOString()]);
  });

  it("signing up cannot create a duplicate when a stale-occurrence row exists", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    // Simulate a row orphaned by a start-time change from before the fix.
    await db.insert(eventNpcSignups).values({
      eventId: event.id,
      userId: player.id,
      characterId: null,
      note: null,
      state: "signed_up",
      occurrenceStartAt: new Date(future(24 * 14)),
    });

    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signup.status).toBe(200);

    // Self-heal: the stale row was re-stamped to the current start and the
    // insert deduped against it — exactly ONE active row remains.
    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(new Date(event.startAt).toISOString());
  });

  it("collapses duplicate active rows on a start-time edit (keeps oldest, withdraws the rest)", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    // Two active rows under different occurrences (the pre-fix Tony scenario).
    const older = await db
      .insert(eventNpcSignups)
      .values({
        eventId: event.id,
        userId: player.id,
        characterId: null,
        note: null,
        state: "signed_up",
        occurrenceStartAt: new Date(future(24 * 7)),
        createdAt: new Date(Date.now() - 3600_000),
      })
      .returning();
    await db.insert(eventNpcSignups).values({
      eventId: event.id,
      userId: player.id,
      characterId: null,
      note: null,
      state: "signed_up",
      occurrenceStartAt: new Date(future(24 * 14)),
    });

    const newStart = future(48);
    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart, endAt: future(50) });
    expect(patch.status).toBe(200);

    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(older[0].id);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(new Date(newStart).toISOString());
  });

  it("collapses a legacy NULL-occurrence duplicate alongside a stamped row on edit", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);

    // Legacy NULL-occurrence row (oldest) plus a stamped row from a later
    // re-sign-up — the NULL+non-NULL duplicate pair.
    const legacy = await db
      .insert(eventNpcSignups)
      .values({
        eventId: event.id,
        userId: player.id,
        characterId: null,
        note: null,
        state: "signed_up",
        occurrenceStartAt: null,
        createdAt: new Date(Date.now() - 3600_000),
      })
      .returning();
    await db.insert(eventNpcSignups).values({
      eventId: event.id,
      userId: player.id,
      characterId: null,
      note: null,
      state: "signed_up",
      occurrenceStartAt: new Date(future(24 * 7)),
    });

    const newStart = future(48);
    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart, endAt: future(50) });
    expect(patch.status).toBe(200);

    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(legacy[0].id);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(new Date(newStart).toISOString());
  });

  it("does NOT re-stamp occurrences on a recurring event edit", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createNpcEvent(admin.id);
    await db
      .update(events)
      .set({
        recurrenceRule: { frequency: 2, interval: 1, byWeekday: [6], count: null, until: null },
      })
      .where(eq(events.id, event.id));

    const later = future(24 * 7);
    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: later });
    expect(signup.status).toBe(200);

    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: future(30), endAt: future(32) });
    expect(patch.status).toBe(200);

    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(new Date(later).toISOString());
  });
});

describe("GET /events/conflicts", () => {
  it("forbids a non-manager and validates the window", async () => {
    const player = await createUser();
    const admin = await createAdmin();

    const denied = await request(app)
      .get(`/api/events/conflicts?startAt=${future(24)}&endAt=${future(26)}`)
      .set("x-test-user", player.id);
    expect(denied.status).toBe(403);

    const badParams = await request(app)
      .get(`/api/events/conflicts`)
      .set("x-test-user", admin.id);
    expect(badParams.status).toBe(400);

    const ok = await request(app)
      .get(`/api/events/conflicts?startAt=${encodeURIComponent(future(24))}&endAt=${encodeURIComponent(future(26))}`)
      .set("x-test-user", admin.id);
    expect(ok.status).toBe(200);
  });
});
