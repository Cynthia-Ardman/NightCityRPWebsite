import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

// VRChat group-calendar mirror. The unofficial calendar API is stubbed so we can
// assert which write (create/update/delete) the sync logic chose, and Discord's
// network calls are stubbed too because the shared CRUD paths run the Discord
// sync first. Creds read as configured so only the kill-switch + deployment gate
// (toggled per test) decide whether the mirror runs.
vi.mock("./vrchatClient", async (importActual) => {
  const actual = await importActual<typeof import("./vrchatClient")>();
  return {
    ...actual,
    createGroupCalendarEvent: vi.fn(async () => "cal-new"),
    updateGroupCalendarEvent: vi.fn(async () => undefined),
    deleteGroupCalendarEvent: vi.fn(async () => undefined),
    vrchatCredsConfigured: vi.fn(() => true),
    recordSessionError: vi.fn(async () => undefined),
  };
});

vi.mock("./discord", async (importActual) => {
  const actual = await importActual<typeof import("./discord")>();
  return {
    ...actual,
    listGuildScheduledEvents: vi.fn(async () => ({ ok: true, events: [] })),
    createGuildScheduledEvent: vi.fn(async () => ({ ok: true, id: "evt" })),
    modifyGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
    deleteGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
  };
});

import { db, events, botConfig } from "@workspace/db";
import {
  createGroupCalendarEvent,
  updateGroupCalendarEvent,
  deleteGroupCalendarEvent,
} from "./vrchatClient";
import {
  reconcileVrchatCalendar,
  createEvent,
  updateEvent,
  syncEventVrchatCalendar,
  syncEventDiscordEvent,
  VRCHAT_SYNC_FLAG,
} from "./eventsService";
import {
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
} from "./discord";
import { truncateAll, createAdmin } from "../test/testDb";

const mockCreate = vi.mocked(createGroupCalendarEvent);
const mockUpdate = vi.mocked(updateGroupCalendarEvent);
const mockDelete = vi.mocked(deleteGroupCalendarEvent);

const future = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3600_000);

async function setSyncFlag(enabled: boolean) {
  await db
    .insert(botConfig)
    .values({ key: VRCHAT_SYNC_FLAG, value: enabled as never })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: enabled as never } });
}

beforeEach(async () => {
  await truncateAll();
  mockCreate.mockClear();
  mockUpdate.mockClear();
  mockDelete.mockClear();
  // Open the deployment write-gate so only the kill-switch flag decides.
  process.env.ALLOW_EXTERNAL_WRITES = "1";
});

afterAll(() => {
  delete process.env.ALLOW_EXTERNAL_WRITES;
});

describe("VRChat calendar mirror — gating is a true no-op", () => {
  it("leaves the stored vrchat* columns untouched on an edit when the kill-switch is OFF", async () => {
    await setSyncFlag(false);
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values({
        title: "Heywood Social",
        eventType: "social",
        startAt: future(24),
        endAt: future(26),
        status: "scheduled",
        needsNpcs: false,
        createdById: admin.id,
        // Pre-existing mirror state that must survive a gated edit.
        vrchatCalendarId: "cal-old",
        vrchatSyncError: "boom",
        vrchatSyncedHash: "stale-hash",
      })
      .returning();

    await updateEvent(row.id, { title: "Heywood Social — New Theme" });

    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.title).toBe("Heywood Social — New Theme"); // the edit still applied
    // ...but the VRChat mirror state is left exactly as it was (no clobber).
    expect(after.vrchatCalendarId).toBe("cal-old");
    expect(after.vrchatSyncError).toBe("boom");
    expect(after.vrchatSyncedHash).toBe("stale-hash");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("reconcileVrchatCalendar — backfill + teardown", () => {
  it("creates a calendar entry for an upcoming qualifying row that has none", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values({
        title: "Main Session",
        eventType: "session",
        startAt: future(48),
        endAt: future(52),
        status: "scheduled",
        needsNpcs: false,
        createdById: admin.id,
      })
      .returning();

    const res = await reconcileVrchatCalendar();
    expect(res.synced).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Backfill must be silent: a bulk reconcile would otherwise ping the whole
    // group once per event.
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sendCreationNotification: false }),
    );

    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.vrchatCalendarId).toBe("cal-new");
    expect(after.vrchatSyncError).toBeNull();
    expect(after.vrchatSyncedHash).toBeTruthy();
  });

  it("notifies the group when a brand-new event is created inline (not a backfill)", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();

    await createEvent(
      {
        title: "Fresh Social",
        eventType: "social",
        location: null,
        description: null,
        imageUrl: null,
        startAt: future(48),
        endAt: future(50),
        needsNpcs: false,
        npcBlurb: null,
      },
      admin.id,
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sendCreationNotification: true }),
    );
  });

  it("tears down a stale entry for a row cancelled while sync was disabled", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values({
        title: "Cancelled Social",
        eventType: "social",
        startAt: future(24),
        endAt: future(26),
        status: "cancelled", // no longer qualifies, but still carries a mirror id
        needsNpcs: false,
        createdById: admin.id,
        vrchatCalendarId: "cal-1",
        vrchatSyncedHash: "h",
      })
      .returning();

    const res = await reconcileVrchatCalendar();
    expect(mockDelete).toHaveBeenCalledWith("cal-1");
    expect(res.synced).toBe(1);

    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.vrchatCalendarId).toBeNull();
  });

  it("tears down a stale entry for a row retyped to a non-qualifying type", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values({
        title: "Now An Other",
        eventType: "other", // retyped away from session/social
        startAt: future(24),
        endAt: future(26),
        status: "scheduled",
        needsNpcs: false,
        createdById: admin.id,
        vrchatCalendarId: "cal-2",
        vrchatSyncedHash: "h",
      })
      .returning();

    await reconcileVrchatCalendar();
    expect(mockDelete).toHaveBeenCalledWith("cal-2");

    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.vrchatCalendarId).toBeNull();
  });

  it("does not overwrite a calendar id claimed by a concurrent path; deletes its own orphan", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values({
        title: "Main Session",
        eventType: "session",
        startAt: future(48),
        endAt: future(52),
        status: "scheduled",
        needsNpcs: false,
        createdById: admin.id,
      })
      .returning();

    // Simulate a concurrent writer (CRUD path) claiming the row's calendar id
    // AFTER reconcile read it as null but BEFORE reconcile persists its own
    // freshly-minted id. The guarded conditional update must then lose, and the
    // orphaned "loser-cal" event must be torn down.
    mockCreate.mockImplementationOnce(async () => {
      await db
        .update(events)
        .set({ vrchatCalendarId: "winner-cal", vrchatSyncedHash: "h" })
        .where(eq(events.id, row.id));
      return "loser-cal";
    });

    await reconcileVrchatCalendar();

    expect(mockDelete).toHaveBeenCalledWith("loser-cal");
    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.vrchatCalendarId).toBe("winner-cal"); // winner preserved, not clobbered
  });

  it("pushes NEXT-occurrence times for a recurring event whose base start is past", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();
    // Weekly open-ended series whose base start slipped into the past — the
    // mirror must push the next FUTURE occurrence, not the stale base times.
    const base = new Date(Date.now() - 10 * 86400000);
    const end = new Date(base.getTime() + 4 * 3600_000);
    await db.insert(events).values({
      title: "Weekly Social",
      eventType: "social",
      startAt: base,
      endAt: end,
      status: "scheduled",
      needsNpcs: false,
      createdById: admin.id,
      recurrenceRule: { frequency: 2, interval: 1, byWeekday: null, count: null, until: null },
    });

    const res = await reconcileVrchatCalendar();
    expect(res).toEqual({ synced: 1, failed: 0 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const input = mockCreate.mock.calls[0][0] as { startsAt: string; endsAt: string };
    // Future start, a whole number of weeks after the base, duration preserved.
    expect(new Date(input.startsAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
    const weeks = (new Date(input.startsAt).getTime() - base.getTime()) / (7 * 86400000);
    expect(weeks).toBeCloseTo(Math.round(weeks), 6);
    expect(new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime()).toBe(
      end.getTime() - base.getTime(),
    );
  });

  it("is a no-op when the kill-switch is OFF", async () => {
    await setSyncFlag(false);
    const admin = await createAdmin();
    await db.insert(events).values({
      title: "Main Session",
      eventType: "session",
      startAt: future(48),
      endAt: future(52),
      status: "scheduled",
      needsNpcs: false,
      createdById: admin.id,
    });

    const res = await reconcileVrchatCalendar();
    expect(res).toEqual({ synced: 0, failed: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("ended recurring series — sync skips the doomed external write", () => {
  // A weekly series whose count is fully exhausted: base 5 weeks in the past,
  // only 2 occurrences. There is no upcoming occurrence to shift onto, so any
  // external write would carry past times and 400 against both mirrors.
  function endedSeriesRow(admin: { id: string }, extra: Record<string, unknown> = {}) {
    const base = new Date(Date.now() - 35 * 86400000);
    return {
      title: "Finished Series",
      eventType: "social" as const,
      startAt: base,
      endAt: new Date(base.getTime() + 2 * 3600_000),
      status: "scheduled" as const,
      needsNpcs: false,
      createdById: admin.id,
      recurrenceRule: {
        frequency: 2,
        interval: 1,
        byWeekday: null,
        count: 2,
        until: null,
      },
      ...extra,
    };
  }

  it("VRChat: skips the write and clears a stale sync error", async () => {
    await setSyncFlag(true);
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values(
        endedSeriesRow(admin, {
          vrchatCalendarId: "cal-ended",
          vrchatSyncedHash: "stale",
          vrchatSyncError: "400 Calendar Entry must start in the future",
        }),
      )
      .returning();

    const sync = await syncEventVrchatCalendar(row);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    // The mirror entry is left alone; the stale error is cleared.
    expect(sync).toEqual({ vrchatCalendarId: "cal-ended", vrchatSyncError: null });
  });

  it("Discord: skips the write and clears a stale sync error", async () => {
    vi.mocked(createGuildScheduledEvent).mockClear();
    vi.mocked(modifyGuildScheduledEvent).mockClear();
    vi.mocked(deleteGuildScheduledEvent).mockClear();
    const admin = await createAdmin();
    const [row] = await db
      .insert(events)
      .values(
        endedSeriesRow(admin, {
          discordEventId: "disc-ended",
          discordSyncError: "400 cannot schedule event in the past",
        }),
      )
      .returning();

    const sync = await syncEventDiscordEvent(row, true);
    expect(vi.mocked(createGuildScheduledEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(modifyGuildScheduledEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteGuildScheduledEvent)).not.toHaveBeenCalled();
    expect(sync).toEqual({ discordEventId: "disc-ended", discordSyncError: null });
  });
});
