/**
 * Tests for recurrenceRule support in createEvent / updateEvent.
 *
 * Network calls are mocked so these tests run without ALLOW_EXTERNAL_WRITES.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// Stub Discord network calls.
vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    listGuildScheduledEvents: vi.fn(async () => ({ ok: true, events: [] })),
    createGuildScheduledEvent: vi.fn(async () => ({ ok: true, id: "discord-new" })),
    modifyGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
    deleteGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
  };
});

// getMissionContext controls whether Discord pushes are live.
vi.mock("./missionsConfig", async (importActual) => {
  const actual = await importActual<typeof import("./missionsConfig")>();
  return { ...actual, getMissionContext: vi.fn(async () => ({ live: true })) };
});

import { db, events, users, type EventRecurrenceRule } from "@workspace/db";
import {
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
} from "../lib/discord";
import { createEvent, updateEvent } from "./eventsService";

const mockCreate = vi.mocked(createGuildScheduledEvent);
const mockModify = vi.mocked(modifyGuildScheduledEvent);

const WEEKLY: EventRecurrenceRule = {
  frequency: 2,
  interval: 1,
  byWeekday: null,
  count: null,
  until: null,
};

const BIWEEKLY: EventRecurrenceRule = {
  frequency: 2,
  interval: 2,
  byWeekday: null,
  count: null,
  until: null,
};

const START = new Date("2026-08-05T18:00:00.000Z"); // Wednesday
const END   = new Date("2026-08-05T22:00:00.000Z");

// Seed a real user so the createdById FK is satisfied.
const TEST_USER_ID = "test-recurrence-user";

beforeEach(async () => {
  mockCreate.mockClear();
  mockModify.mockClear();
  mockCreate.mockImplementation(async () => ({ ok: true, id: "discord-new" }));
  mockModify.mockImplementation(async (id: string) => ({ ok: true, id }));

  // Ensure test user exists (ON CONFLICT DO NOTHING so it's idempotent).
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      discordId: "111111111111111111",
      username: "recurrence-tester",
      roles: [],
    })
    .onConflictDoNothing();
});

describe("createEvent with recurrenceRule", () => {
  it("stores the rule in the DB and passes recurrenceRule to the Discord push", async () => {
    const created = await createEvent(
      {
        title: "Wednesday Social",
        eventType: "social",
        location: "Watson",
        description: null,
        imageUrl: null,
        startAt: START,
        endAt: END,
        needsNpcs: false,
        npcBlurb: null,
        recurrenceRule: WEEKLY,
      },
      TEST_USER_ID,
    );

    // Rule persisted to DB.
    expect(created.recurrenceRule).toMatchObject({ frequency: 2, interval: 1 });
    const [row] = await db.select().from(events).where(eq(events.id, created.id));
    expect(row.recurrenceRule).toMatchObject({ frequency: 2, interval: 1 });

    // Discord create was called and received the recurrenceRule.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0] as { recurrenceRule?: unknown };
    expect(arg.recurrenceRule).toMatchObject({ frequency: 2, interval: 1 });
  });

  it("stores null when no recurrenceRule provided (single-occurrence default)", async () => {
    const created = await createEvent(
      {
        title: "One-Off Social",
        eventType: "social",
        location: "Pacifica",
        description: null,
        imageUrl: null,
        startAt: START,
        endAt: END,
        needsNpcs: false,
        npcBlurb: null,
      },
      TEST_USER_ID,
    );

    expect(created.recurrenceRule).toBeNull();
    const [row] = await db.select().from(events).where(eq(events.id, created.id));
    expect(row.recurrenceRule).toBeNull();
  });
});

describe("updateEvent with recurrenceRule", () => {
  async function seedRecurring(): Promise<number> {
    const [row] = await db
      .insert(events)
      .values({
        title: "Weekly Social",
        eventType: "social",
        location: "Heywood",
        description: null,
        startAt: START,
        endAt: END,
        status: "scheduled",
        needsNpcs: false,
        discordEventId: "disc-123",
        recurrenceRule: WEEKLY,
        excludedOccurrences: [new Date("2026-08-12T18:00:00.000Z").toISOString()],
      })
      .returning({ id: events.id });
    return row.id;
  }

  it("updates the recurrence rule (interval change) and keeps excludedOccurrences", async () => {
    const id = await seedRecurring();
    mockModify.mockClear();

    await updateEvent(id, { recurrenceRule: BIWEEKLY });

    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row.recurrenceRule).toMatchObject({ frequency: 2, interval: 2 });
    // excludedOccurrences still present (rule changed but not cleared).
    expect(row.excludedOccurrences?.length).toBeGreaterThan(0);
  });

  it("clears excludedOccurrences when recurrenceRule is set to null", async () => {
    const id = await seedRecurring();

    await updateEvent(id, { recurrenceRule: null });

    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row.recurrenceRule).toBeNull();
    expect(row.excludedOccurrences).toEqual([]);
  });

  it("does NOT touch recurrenceRule when key is omitted from patch", async () => {
    const id = await seedRecurring();

    await updateEvent(id, { title: "Weekly Social — Updated" });

    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row.recurrenceRule).toMatchObject({ frequency: 2, interval: 1 }); // unchanged
    expect(row.title).toBe("Weekly Social — Updated");
  });

  it("passes recurrenceRule to Discord on update", async () => {
    const id = await seedRecurring();
    mockModify.mockClear();

    await updateEvent(id, { recurrenceRule: BIWEEKLY });

    expect(mockModify).toHaveBeenCalledTimes(1);
    const input = mockModify.mock.calls[0][1] as { recurrenceRule?: unknown };
    expect(input.recurrenceRule).toMatchObject({ frequency: 2, interval: 2 });
  });

  it("passes recurrenceRule=null to Discord when clearing recurrence", async () => {
    const id = await seedRecurring();
    mockModify.mockClear();

    await updateEvent(id, { recurrenceRule: null });

    expect(mockModify).toHaveBeenCalledTimes(1);
    const input = mockModify.mock.calls[0][1] as { recurrenceRule?: unknown };
    expect(input.recurrenceRule).toBeNull();
  });
});
