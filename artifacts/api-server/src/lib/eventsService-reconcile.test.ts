import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// Discord is PARTIALLY mocked: keep the real recurrence parser / role helpers,
// but stub the network calls. listGuildScheduledEvents drives the reconcile, and
// modifyGuildScheduledEvent lets the (live) push branch stamp a synced hash so we
// can then drive a clean Discord-only pull. Each test sets the list payload.
vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    listGuildScheduledEvents: vi.fn(),
    modifyGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
    createGuildScheduledEvent: vi.fn(async () => ({ ok: true, id: "evt-new" })),
    deleteGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
  };
});

import { db, events } from "@workspace/db";
import {
  listGuildScheduledEvents,
  modifyGuildScheduledEvent,
  type GuildScheduledEvent,
  type DiscordRecurrence,
} from "../lib/discord";
import { reconcileDiscordEvents } from "./eventsService";

const mockList = vi.mocked(listGuildScheduledEvents);
const mockModify = vi.mocked(modifyGuildScheduledEvent);

// A weekly (frequency 2) recurrence on Thursday in the UTC frame, open-ended —
// exactly how the live weekly socials are stored.
const WEEKLY_THU: DiscordRecurrence = {
  frequency: 2,
  interval: 1,
  byWeekday: [3],
  count: null,
  until: null,
};

const START = new Date("2026-06-11T01:00:00.000Z");
const END = new Date("2026-06-11T05:00:00.000Z");

function discordEvent(overrides: Partial<GuildScheduledEvent> = {}): GuildScheduledEvent {
  return {
    id: "disc-social-1",
    name: "Heywood Social",
    description: "Come hang out",
    location: "Heywood",
    scheduledStartTime: START.toISOString(),
    scheduledEndTime: END.toISOString(),
    creatorId: null,
    image: null,
    status: 1,
    entityType: 3,
    recurrence: WEEKLY_THU,
    ...overrides,
  };
}

// Seed a recurring social already linked to the Discord event, then run a single
// LIVE reconcile where Discord matches the row. With no stored synced hash both
// sides read as "changed", so reconcile takes the push branch and stamps
// discordSyncedHash = hash(row) — leaving the row genuinely in sync without us
// needing the (non-exported) hash helper. Returns the seeded row id.
async function seedSyncedRecurringSocial(): Promise<number> {
  const [row] = await db
    .insert(events)
    .values({
      title: "Heywood Social",
      eventType: "social",
      location: "Heywood",
      description: "Come hang out",
      startAt: START,
      endAt: END,
      status: "scheduled",
      needsNpcs: false,
      discordEventId: "disc-social-1",
      recurrenceRule: WEEKLY_THU,
      discordSyncedHash: null,
    })
    .returning({ id: events.id });

  mockList.mockResolvedValue({ ok: true, events: [discordEvent()] });
  await reconcileDiscordEvents(true);
  // The seed's live reconcile takes the push branch (no stored hash yet), which
  // calls modifyGuildScheduledEvent once. Clear that history so a test asserting
  // post-seed push counts starts from zero.
  mockModify.mockClear();
  return row.id;
}

beforeEach(() => {
  mockList.mockReset();
  mockModify.mockReset();
  mockModify.mockImplementation(async (id: string) => ({ ok: true, id }));
});

describe("reconcileDiscordEvents — recurring social edits propagate via the single row", () => {
  it("pulls a Discord-side title/description edit into the one linked row, preserving its recurrence", async () => {
    const id = await seedSyncedRecurringSocial();

    // The operator edits the single recurring event on Discord.
    mockList.mockResolvedValue({
      ok: true,
      events: [discordEvent({ name: "Heywood Social — Neon Night", description: "New theme this week" })],
    });

    const result = await reconcileDiscordEvents(false);
    expect(result.pulled).toBe(1);

    const [row] = await db.select().from(events).where(eq(events.id, id));
    // The single row now carries the edit. Because the client expands this one
    // row into every weekly occurrence, all occurrences inherit the new content.
    expect(row.title).toBe("Heywood Social — Neon Night");
    expect(row.description).toBe("New theme this week");
    // The series stays recurring — the edit must not drop the weekly rule.
    expect(row.recurrenceRule).toEqual(WEEKLY_THU);
  });

  it("backfills a recurrence rule onto a linked row that is missing one (website-only, runs even in Test mode)", async () => {
    // A social linked to Discord but stored WITHOUT a recurrence rule (e.g. an
    // older import) — it would only ever show a single occurrence until the rule
    // is mirrored down.
    const [row] = await db
      .insert(events)
      .values({
        title: "Heywood Social",
        eventType: "social",
        location: "Heywood",
        description: "Come hang out",
        startAt: START,
        endAt: END,
        status: "scheduled",
        needsNpcs: false,
        discordEventId: "disc-social-1",
        recurrenceRule: null,
        discordSyncedHash: null,
      })
      .returning({ id: events.id });

    mockList.mockResolvedValue({ ok: true, events: [discordEvent()] });
    // Test mode (live=false): the recurrence backfill is a website-only write and
    // must still apply so the calendar starts expanding occurrences.
    await reconcileDiscordEvents(false);

    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.recurrenceRule).toEqual(WEEKLY_THU);
  });

  it("pulls a Discord-side time (start/end) edit into the one linked row", async () => {
    const id = await seedSyncedRecurringSocial();

    // Operator moves the weekly social an hour later on Discord.
    const newStart = new Date("2026-06-11T02:00:00.000Z");
    const newEnd = new Date("2026-06-11T06:00:00.000Z");
    mockList.mockResolvedValue({
      ok: true,
      events: [
        discordEvent({
          scheduledStartTime: newStart.toISOString(),
          scheduledEndTime: newEnd.toISOString(),
        }),
      ],
    });

    const result = await reconcileDiscordEvents(false);
    expect(result.pulled).toBe(1);

    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row.startAt.getTime()).toBe(newStart.getTime());
    expect(row.endAt.getTime()).toBe(newEnd.getTime());
    // Still recurring — the anchor moved, every future occurrence steps off it.
    expect(row.recurrenceRule).toEqual(WEEKLY_THU);
  });

  it("mirrors a Discord-side recurrence-rule change (weekday shift) onto the row", async () => {
    const id = await seedSyncedRecurringSocial();

    // Operator changes the weekly social from Thursday to Friday on Discord.
    const weeklyFri: DiscordRecurrence = { ...WEEKLY_THU, byWeekday: [4] };
    mockList.mockResolvedValue({ ok: true, events: [discordEvent({ recurrence: weeklyFri })] });

    // Recurrence is backfilled independently of the content hash, so even a pure
    // rule change (no title/time edit) is mirrored down in Test mode.
    await reconcileDiscordEvents(false);

    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row.recurrenceRule).toEqual(weeklyFri);
  });

  it("both sides changed: website edit is authoritative and pushes back to Discord (documented policy)", async () => {
    const id = await seedSyncedRecurringSocial();

    // A website-side edit lands (changes the row's hashed content) AND Discord
    // also moved since the last sync. Policy is most-recent-on-site-wins: the
    // reconcile pushes the website row up rather than pulling Discord down.
    await db.update(events).set({ title: "Heywood Social — Website Edit" }).where(eq(events.id, id));
    mockList.mockResolvedValue({
      ok: true,
      events: [discordEvent({ name: "Heywood Social — Discord Edit" })],
    });

    const result = await reconcileDiscordEvents(true);
    expect(result.pushed).toBe(1);
    expect(mockModify).toHaveBeenCalledTimes(1);

    // The website's title is preserved (not clobbered by the Discord edit).
    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row.title).toBe("Heywood Social — Website Edit");
  });
});
