import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// Discord network calls are stubbed; the self-heal pushes an unsynced session via
// createGuildScheduledEvent. getMissionContext is mocked so each test controls
// whether the shared Live switch is on.
vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    createGuildScheduledEvent: vi.fn(async () => ({ ok: true, id: "evt-heal-1" })),
    modifyGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
    deleteGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
  };
});

vi.mock("./missionsConfig", async (importActual) => {
  const actual = await importActual<typeof import("./missionsConfig")>();
  return {
    ...actual,
    getMissionContext: vi.fn(async () => ({ live: false })),
  };
});

import { db, events } from "@workspace/db";
import { createGuildScheduledEvent } from "../lib/discord";
import { getMissionContext } from "./missionsConfig";
import { backfillMainSessions } from "./eventsService";

const mockCreate = vi.mocked(createGuildScheduledEvent);
const mockCtx = vi.mocked(getMissionContext);

const DAY = 24 * 60 * 60 * 1000;
const SESSION_LEN = 4 * 60 * 60 * 1000;

// Seed three session rows and return the unsynced future one's id:
//  - a PAST unsynced row (must never be healed — it's already happened)
//  - a FUTURE unsynced row (the gap to heal)
//  - the LATEST row, synced and beyond the 90-day horizon so no NEW rows are
//    created — proving the heal runs even when coverage already reaches horizon.
async function seedSessions(): Promise<number> {
  await db.delete(events).where(eq(events.eventType, "session"));
  const now = Date.now();
  const mk = (title: string, startMs: number, discordEventId: string | null) => ({
    title,
    eventType: "session" as const,
    location: "Night City",
    description: "Main Session",
    startAt: new Date(startMs),
    endAt: new Date(startMs + SESSION_LEN),
    status: "scheduled" as const,
    needsNpcs: true,
    discordEventId,
  });
  await db.insert(events).values(mk("Main Session 69", now - 7 * DAY, null));
  const [future] = await db
    .insert(events)
    .values(mk("Main Session 70", now + 10 * DAY, null))
    .returning({ id: events.id });
  await db.insert(events).values(mk("Main Session 80", now + 100 * DAY, "evt-80"));
  return future.id;
}

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async () => ({ ok: true, id: "evt-heal-1" }));
  mockCtx.mockReset();
  mockCtx.mockResolvedValue({ live: false } as Awaited<ReturnType<typeof getMissionContext>>);
});

describe("backfillMainSessions — self-heals website-only session rows", () => {
  it("pushes a future unsynced session to Discord when Live and links the row", async () => {
    const futureId = await seedSessions();
    mockCtx.mockResolvedValue({ live: true } as Awaited<ReturnType<typeof getMissionContext>>);

    const r = await backfillMainSessions({ horizonDays: 90 });

    // Latest row is beyond the horizon, so nothing new is created — but the gap
    // row below it is still healed.
    expect(r.created).toBe(0);
    expect(r.healed).toBe(1);
    expect(r.healedTitles).toEqual(["Main Session 70"]);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(events).where(eq(events.id, futureId));
    expect(row.discordEventId).toBe("evt-heal-1");
  });

  it("does not touch Discord in Test mode (Live off)", async () => {
    const futureId = await seedSessions();
    mockCtx.mockResolvedValue({ live: false } as Awaited<ReturnType<typeof getMissionContext>>);

    const r = await backfillMainSessions({ horizonDays: 90 });

    expect(r.healed).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    const [row] = await db.select().from(events).where(eq(events.id, futureId));
    expect(row.discordEventId).toBeNull();
  });

  it("dryRun reports the would-heal count without writing to Discord", async () => {
    const futureId = await seedSessions();
    mockCtx.mockResolvedValue({ live: true } as Awaited<ReturnType<typeof getMissionContext>>);

    const r = await backfillMainSessions({ horizonDays: 90, dryRun: true });

    expect(r.healed).toBe(1);
    expect(r.healedTitles).toEqual(["Main Session 70"]);
    expect(mockCreate).not.toHaveBeenCalled();
    const [row] = await db.select().from(events).where(eq(events.id, futureId));
    expect(row.discordEventId).toBeNull();
  });
});
