import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";
import { and, eq } from "drizzle-orm";
import { db, events, eventNpcSignups, missionActorPayments } from "@workspace/db";

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
  it("is public: anonymous callers get the list with no viewer-specific or manager data", async () => {
    const admin = await createAdmin();
    const created = await createValidEvent(admin.id);
    expect(created.status).toBe(201);

    const res = await request(app).get("/api/events");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const mine = res.body.find((e: any) => e.id === created.body.id);
    expect(mine).toBeTruthy();
    expect(mine.canManage).toBe(false);
    expect(mine.signups).toBeUndefined();
    expect(mine.mySignup ?? null).toBeNull();
  });

  it("is public: anonymous event detail hides manager-only fields", async () => {
    const admin = await createAdmin();
    const created = await createValidEvent(admin.id);
    const res = await request(app).get(`/api/events/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.canManage).toBe(false);
    expect(res.body.canCheckIn).toBe(false);
    expect(res.body.signups ?? undefined).toBeUndefined();
    expect(res.body.discordSyncError ?? null).toBeNull();
    expect(res.body.myTickets).toEqual([]);
    expect(res.body.mySignup ?? null).toBeNull();
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

describe("GET /events/:id is occurrence-aware for recurring events", () => {
  async function createRecurringNpcEvent(adminId: string) {
    const res = await createValidEvent(adminId, { needsNpcs: true });
    expect(res.status).toBe(201);
    const event = res.body as { id: number; startAt: string };
    await db
      .update(events)
      .set({
        recurrenceRule: { frequency: 2, interval: 1, byWeekday: [6], count: null, until: null },
      })
      .where(eq(events.id, event.id));
    return event;
  }

  it("rejects an invalid occurrenceStartAt", async () => {
    const admin = await createAdmin();
    const event = await createRecurringNpcEvent(admin.id);
    const res = await request(app)
      .get(`/api/events/${event.id}?occurrenceStartAt=not-a-date`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(400);
  });

  it("shifts dates and scopes the roster to the requested occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createRecurringNpcEvent(admin.id);
    const later = future(24 * 7);
    const laterIso = new Date(later).toISOString();

    // Player signs up for NEXT week's occurrence only.
    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: later });
    expect(signup.status).toBe(200);

    // Base view (no param): dates unchanged, player NOT on this occurrence.
    const base = await request(app).get(`/api/events/${event.id}`).set("x-test-user", player.id);
    expect(base.status).toBe(200);
    expect(base.body.startAt).toBe(new Date(event.startAt).toISOString());
    expect(base.body.mySignup).toBeNull();
    expect(base.body.signupCount).toBe(0);

    // Occurrence view: dates shifted (duration preserved), signup visible.
    const occ = await request(app)
      .get(`/api/events/${event.id}?occurrenceStartAt=${encodeURIComponent(laterIso)}`)
      .set("x-test-user", player.id);
    expect(occ.status).toBe(200);
    expect(occ.body.startAt).toBe(laterIso);
    expect(new Date(occ.body.endAt).getTime() - new Date(occ.body.startAt).getTime()).toBe(
      new Date(base.body.endAt).getTime() - new Date(base.body.startAt).getTime(),
    );
    expect(occ.body.mySignup).not.toBeNull();
    expect(occ.body.signupCount).toBe(1);
  });

  it("counts legacy null-occurrence rows only for the current occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createRecurringNpcEvent(admin.id);

    await db.insert(eventNpcSignups).values({
      eventId: event.id,
      userId: player.id,
      characterId: null,
      note: null,
      state: "signed_up",
      occurrenceStartAt: null,
    });

    const currentIso = new Date(event.startAt).toISOString();
    const current = await request(app)
      .get(`/api/events/${event.id}?occurrenceStartAt=${encodeURIComponent(currentIso)}`)
      .set("x-test-user", player.id);
    expect(current.status).toBe(200);
    expect(current.body.mySignup).not.toBeNull();

    const laterIso = new Date(future(24 * 7)).toISOString();
    const later = await request(app)
      .get(`/api/events/${event.id}?occurrenceStartAt=${encodeURIComponent(laterIso)}`)
      .set("x-test-user", player.id);
    expect(later.status).toBe(200);
    expect(later.body.mySignup).toBeNull();
    expect(later.body.signupCount).toBe(0);
  });

  it("ignores the param on non-recurring events", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const res = await createValidEvent(admin.id, { needsNpcs: true });
    expect(res.status).toBe(201);
    const event = res.body as { id: number; startAt: string };

    const laterIso = new Date(future(24 * 7)).toISOString();
    const view = await request(app)
      .get(`/api/events/${event.id}?occurrenceStartAt=${encodeURIComponent(laterIso)}`)
      .set("x-test-user", player.id);
    expect(view.status).toBe(200);
    expect(view.body.startAt).toBe(new Date(event.startAt).toISOString());
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

describe("recurring events keep NPCs per occurrence", () => {
  const RECURRENCE = { frequency: 2, interval: 1, byWeekday: [6], count: null, until: null };

  async function createRecurringNpcEvent(adminId: string) {
    const res = await createValidEvent(adminId, { needsNpcs: true });
    expect(res.status).toBe(201);
    const event = res.body as { id: number; startAt: string };
    await db.update(events).set({ recurrenceRule: RECURRENCE }).where(eq(events.id, event.id));
    return event;
  }

  async function activeRows(eventId: number) {
    return db
      .select()
      .from(eventNpcSignups)
      .where(and(eq(eventNpcSignups.eventId, eventId), eq(eventNpcSignups.state, "signed_up")));
  }

  it("a roll-forward (start moves a week ahead) does NOT carry sign-ups to the next occurrence", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createRecurringNpcEvent(admin.id);

    // Player signs up for the current occurrence; also plant a legacy
    // NULL-occurrence row for a second volunteer.
    const other = await createUser();
    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signup.status).toBe(200);
    await db.insert(eventNpcSignups).values({
      eventId: event.id,
      userId: other.id,
      characterId: null,
      note: null,
      state: "signed_up",
      occurrenceStartAt: null,
    });

    const oldStart = new Date(event.startAt).toISOString();
    const newStart = future(24 * 8); // rolls forward past 24h => next occurrence
    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart, endAt: future(24 * 8 + 2) });
    expect(patch.status).toBe(200);

    // Both rows stay active but pinned to the OLD occurrence.
    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.occurrenceStartAt?.toISOString()).toBe(oldStart);
    }

    // The new occurrence starts with a clean roster.
    const view = await request(app).get(`/api/events/${event.id}`).set("x-test-user", admin.id);
    expect(view.status).toBe(200);
    expect(view.body.signupCount).toBe(0);
    expect(view.body.signups ?? []).toHaveLength(0);
    expect(view.body.mySignup).toBeNull();

    // The player can sign up again for the new occurrence.
    const again = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(again.status).toBe(200);
    const after = await request(app).get(`/api/events/${event.id}`).set("x-test-user", admin.id);
    expect(after.body.signupCount).toBe(1);
  });

  it("a ~23h shift (daily social across a DST boundary) still counts as a roll-forward", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createRecurringNpcEvent(admin.id);

    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signup.status).toBe(200);

    const oldStart = new Date(event.startAt).toISOString();
    const newStart = future(24 + 23); // +23h from the original future(24)
    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart, endAt: future(24 + 25) });
    expect(patch.status).toBe(200);

    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(oldStart);

    const view = await request(app).get(`/api/events/${event.id}`).set("x-test-user", admin.id);
    expect(view.body.signupCount).toBe(0);
  });

  it("a same-day time correction carries sign-ups to the corrected time", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createRecurringNpcEvent(admin.id);

    const signup = await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signup.status).toBe(200);

    const newStart = future(25); // +1h from the original future(24) => correction
    const patch = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart, endAt: future(27) });
    expect(patch.status).toBe(200);

    const rows = await activeRows(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceStartAt?.toISOString()).toBe(new Date(newStart).toISOString());

    const view = await request(app).get(`/api/events/${event.id}`).set("x-test-user", player.id);
    expect(view.body.mySignup).not.toBeNull();
    expect(view.body.signupCount).toBe(1);
  });

  it("pay-once guard is per occurrence: paid rows for different occurrences coexist, same occurrence conflicts", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const event = await createRecurringNpcEvent(admin.id);
    const occA = new Date(event.startAt);
    const occB = new Date(new Date(event.startAt).getTime() + 7 * 24 * 3600_000);

    const base = {
      eventId: event.id,
      missionName: "Haywood Social",
      userId: player.id,
      amount: 500,
      paymentStatus: "paid" as const,
      source: "manual" as const,
    };
    await db.insert(missionActorPayments).values({ ...base, occurrenceStartAt: occA });
    // Same user, LATER occurrence — must be allowed.
    await db.insert(missionActorPayments).values({ ...base, occurrenceStartAt: occB });
    // Same occurrence again — unique index must reject.
    await expect(
      db.insert(missionActorPayments).values({ ...base, occurrenceStartAt: occA }),
    ).rejects.toThrow();
  });

  it("paidActorUserIds only locks actors paid for the CURRENT occurrence", async () => {
    const admin = await createAdmin();
    const paidLastWeek = await createUser();
    const paidThisWeek = await createUser();
    const event = await createRecurringNpcEvent(admin.id);
    const current = new Date(event.startAt);
    const lastWeek = new Date(current.getTime() - 7 * 24 * 3600_000);

    const base = {
      eventId: event.id,
      missionName: "Haywood Social",
      amount: 500,
      paymentStatus: "paid" as const,
      source: "manual" as const,
    };
    await db.insert(missionActorPayments).values({ ...base, userId: paidLastWeek.id, occurrenceStartAt: lastWeek });
    await db.insert(missionActorPayments).values({ ...base, userId: paidThisWeek.id, occurrenceStartAt: current });

    const view = await request(app).get(`/api/events/${event.id}`).set("x-test-user", admin.id);
    expect(view.status).toBe(200);
    expect(view.body.paidActorUserIds).toContain(paidThisWeek.id);
    expect(view.body.paidActorUserIds).not.toContain(paidLastWeek.id);
  });
});

describe("PATCH /events/:id applyScope=occurrence splits a recurring occurrence", () => {
  async function createRecurring(adminId: string) {
    const res = await createValidEvent(adminId, { needsNpcs: true });
    expect(res.status).toBe(201);
    await db
      .update(events)
      .set({ recurrenceRule: { frequency: 2, interval: 1, byWeekday: [6], count: null, until: null } })
      .where(eq(events.id, res.body.id));
    return res.body as { id: number; startAt: string; endAt: string };
  }

  it("rejects occurrence scope on a non-recurring event and bad scope values", async () => {
    const admin = await createAdmin();
    const res = await createValidEvent(admin.id);
    expect(res.status).toBe(201);

    const badScope = await request(app)
      .patch(`/api/events/${res.body.id}`)
      .set("x-test-user", admin.id)
      .send({ applyScope: "weird" });
    expect(badScope.status).toBe(400);

    const noOcc = await request(app)
      .patch(`/api/events/${res.body.id}`)
      .set("x-test-user", admin.id)
      .send({ applyScope: "occurrence" });
    expect(noOcc.status).toBe(400);

    const notRecurring = await request(app)
      .patch(`/api/events/${res.body.id}`)
      .set("x-test-user", admin.id)
      .send({ applyScope: "occurrence", occurrenceStartAt: res.body.startAt, title: "One-off" });
    expect(notRecurring.status).toBe(400);
  });

  it("splits: creates a standalone child, excludes the occurrence, moves that occurrence's signups", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const other = await createUser();
    const event = await createRecurring(admin.id);
    const base = new Date(event.startAt);
    const nextWeek = new Date(base.getTime() + 7 * 24 * 3600_000);

    // One signup on the base occurrence (stays), one on next week's (moves).
    await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", other.id)
      .send({})
      .expect(200);
    await request(app)
      .post(`/api/events/${event.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: nextWeek.toISOString() })
      .expect(200);

    const shiftedStart = new Date(nextWeek.getTime() + 3600_000); // +1h edit
    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({
        applyScope: "occurrence",
        occurrenceStartAt: nextWeek.toISOString(),
        title: "Special Edition",
        startAt: shiftedStart.toISOString(),
        endAt: new Date(shiftedStart.getTime() + 2 * 3600_000).toISOString(),
      });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(event.id);
    expect(res.body.title).toBe("Special Edition");
    expect(res.body.startAt).toBe(shiftedStart.toISOString());
    expect(res.body.recurrence).toBeNull();

    // Parent untouched except the exclusion.
    const parent = await request(app).get(`/api/events/${event.id}`).set("x-test-user", admin.id);
    expect(parent.status).toBe(200);
    expect(parent.body.title).toBe("Heist Night");
    expect(parent.body.excludedOccurrences).toEqual([nextWeek.toISOString()]);

    // The next-week signup moved onto the child at its new start; base stayed.
    const moved = await db
      .select()
      .from(eventNpcSignups)
      .where(and(eq(eventNpcSignups.eventId, res.body.id), eq(eventNpcSignups.userId, player.id)));
    expect(moved).toHaveLength(1);
    expect(moved[0].occurrenceStartAt?.toISOString()).toBe(shiftedStart.toISOString());
    const stayed = await db
      .select()
      .from(eventNpcSignups)
      .where(and(eq(eventNpcSignups.eventId, event.id), eq(eventNpcSignups.userId, other.id)));
    expect(stayed).toHaveLength(1);

    // Splitting the same occurrence again conflicts.
    const again = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({ applyScope: "occurrence", occurrenceStartAt: nextWeek.toISOString(), title: "Again" });
    expect(again.status).toBe(409);
  });

  it("rejects ticket tier edits in occurrence scope", async () => {
    const admin = await createAdmin();
    const event = await createRecurring(admin.id);
    const nextWeek = new Date(new Date(event.startAt).getTime() + 7 * 24 * 3600_000);
    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("x-test-user", admin.id)
      .send({
        applyScope: "occurrence",
        occurrenceStartAt: nextWeek.toISOString(),
        ticketTypes: [{ name: "VIP", price: 100, quantity: 0 }],
      });
    expect(res.status).toBe(400);
  });
});

describe("split occurrences are blocked on the parent", () => {
  it("rejects empty-array ticketTypes in occurrence scope and blocks parent signups for excluded occurrences", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const res = await createValidEvent(admin.id, { needsNpcs: true });
    expect(res.status).toBe(201);
    await db
      .update(events)
      .set({ recurrenceRule: { frequency: 2, interval: 1, byWeekday: [6], count: null, until: null } })
      .where(eq(events.id, res.body.id));
    const nextWeek = new Date(new Date(res.body.startAt).getTime() + 7 * 24 * 3600_000);

    const emptyTiers = await request(app)
      .patch(`/api/events/${res.body.id}`)
      .set("x-test-user", admin.id)
      .send({ applyScope: "occurrence", occurrenceStartAt: nextWeek.toISOString(), ticketTypes: [] });
    expect(emptyTiers.status).toBe(400);

    const split = await request(app)
      .patch(`/api/events/${res.body.id}`)
      .set("x-test-user", admin.id)
      .send({ applyScope: "occurrence", occurrenceStartAt: nextWeek.toISOString(), title: "Split" });
    expect(split.status).toBe(201);

    // Stale deep-link signup against the parent's split-out occurrence is refused.
    const staleSignup = await request(app)
      .post(`/api/events/${res.body.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({ occurrenceStartAt: nextWeek.toISOString() });
    expect(staleSignup.status).toBe(409);

    // Detail deep link for the excluded occurrence falls back to the base view.
    const detail = await request(app)
      .get(`/api/events/${res.body.id}?occurrenceStartAt=${encodeURIComponent(nextWeek.toISOString())}`)
      .set("x-test-user", player.id);
    expect(detail.status).toBe(200);
    expect(detail.body.startAt).toBe(res.body.startAt);
  });
});
