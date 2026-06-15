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
import { reconcileVrchatCalendar, updateEvent, VRCHAT_SYNC_FLAG } from "./eventsService";
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

    const [after] = await db.select().from(events).where(eq(events.id, row.id));
    expect(after.vrchatCalendarId).toBe("cal-new");
    expect(after.vrchatSyncError).toBeNull();
    expect(after.vrchatSyncedHash).toBeTruthy();
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
