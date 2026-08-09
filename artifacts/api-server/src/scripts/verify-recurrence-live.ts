// One-off live verification for task #387: confirm a website-set weekly repeat
// actually shows up on the real Discord scheduled event, that interval changes
// and rule removal follow, and that the reconcile cron would not churn.
//
// Run with:  ALLOW_EXTERNAL_WRITES=1 npx tsx src/scripts/verify-recurrence-live.ts
//
// Creates ONE temporary scheduled event in the guild, exercises the three
// transitions, then deletes it (Discord + dev DB row). Idempotent-ish: any
// failure still attempts cleanup.
import { db, events, users, type EventRecurrenceRule } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  listGuildScheduledEvents,
  deleteGuildScheduledEvent,
  type DiscordRecurrence,
} from "../lib/discord";
import { syncEventDiscordEvent } from "../lib/eventsService";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exitCode = 1;
  throw new Error(msg);
}

// Mirror of eventsService.recurrenceEqual (module-private) — the exact
// predicate the reconcile cron uses to decide whether to push. If this says
// equal, reconcile will not churn the rule.
function recurrenceEqual(
  a: EventRecurrenceRule | DiscordRecurrence | null | undefined,
  b: EventRecurrenceRule | DiscordRecurrence | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const wd = (x: number[] | null | undefined) =>
    x ? [...x].sort((m, n) => m - n).join(",") : "";
  return (
    a.frequency === b.frequency &&
    a.interval === b.interval &&
    (a.count ?? null) === (b.count ?? null) &&
    (a.until ?? null) === (b.until ?? null) &&
    wd(a.byWeekday) === wd(b.byWeekday)
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchDiscord(discordEventId: string) {
  // Discord can be eventually-consistent; retry a couple of times.
  for (let i = 0; i < 3; i++) {
    const list = await listGuildScheduledEvents();
    if (!list.ok) fail(`listGuildScheduledEvents: ${list.error}`);
    const d = list.events.find((e) => e.id === discordEventId);
    if (d) return d;
    await sleep(3000);
  }
  return null;
}

async function main() {
  if (process.env.ALLOW_EXTERNAL_WRITES !== "1") {
    fail("Run with ALLOW_EXTERNAL_WRITES=1 (writes are deployment-gated).");
  }
  const [creator] = await db.select({ id: users.id }).from(users).limit(1);
  if (!creator) fail("no users in dev DB for createdById FK");

  // Future start: next Wednesday 18:00 UTC-ish (just 9 days out at 18:00).
  const start = new Date(Date.now() + 9 * 86400000);
  start.setUTCHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60_000);

  const WEEKLY: EventRecurrenceRule = { frequency: 2, interval: 1, byWeekday: null, count: null, until: null };
  const BIWEEKLY: EventRecurrenceRule = { frequency: 2, interval: 2, byWeekday: null, count: null, until: null };

  const [row] = await db
    .insert(events)
    .values({
      title: "[TEST task387] recurrence verification — ignore",
      eventType: "community",
      location: "Night City",
      description: "Temporary automated verification event; will self-delete.",
      startAt: start,
      endAt: end,
      needsNpcs: false,
      recurrenceRule: WEEKLY,
      createdById: creator.id,
    })
    .returning();
  console.log("DB row", row.id, "start", start.toISOString());

  let discordEventId: string | null = null;
  try {
    // --- Step 1: create with weekly rule ---
    const s1 = await syncEventDiscordEvent(row, true);
    if (s1.discordSyncError || !s1.discordEventId) fail(`create sync: ${s1.discordSyncError}`);
    discordEventId = s1.discordEventId;
    await db.update(events).set({
      discordEventId,
      discordSyncError: null,
      discordSyncedHash: s1.discordSyncedHash,
      discordSyncedAt: s1.discordSyncedAt,
    }).where(eq(events.id, row.id));
    const d1 = await fetchDiscord(discordEventId);
    if (!d1) fail("created event not found on Discord");
    console.log("Step1 Discord recurrence:", JSON.stringify(d1.recurrence));
    if (!d1.recurrence || d1.recurrence.frequency !== 2 || d1.recurrence.interval !== 1) {
      fail("Discord does not show weekly recurrence after create");
    }
    console.log("Step1 reconcile-equal (no churn)?", recurrenceEqual(WEEKLY, d1.recurrence));

    // --- Step 2: change interval to 2 (modify path) ---
    const [row2] = await db.update(events).set({ recurrenceRule: BIWEEKLY }).where(eq(events.id, row.id)).returning();
    const s2 = await syncEventDiscordEvent(row2, true);
    if (s2.discordSyncError) fail(`interval modify sync: ${s2.discordSyncError}`);
    const d2 = await fetchDiscord(discordEventId);
    if (!d2) fail("event vanished after interval modify");
    console.log("Step2 Discord recurrence:", JSON.stringify(d2.recurrence));
    if (!d2.recurrence || d2.recurrence.interval !== 2) fail("Discord did not follow interval change to 2");
    console.log("Step2 reconcile-equal (no churn)?", recurrenceEqual(BIWEEKLY, d2.recurrence));

    // --- Step 3: remove the repeat (recurrence_rule: null on modify) ---
    const [row3] = await db.update(events).set({ recurrenceRule: null, excludedOccurrences: [] }).where(eq(events.id, row.id)).returning();
    const s3 = await syncEventDiscordEvent(row3, true);
    if (s3.discordSyncError) fail(`clear-rule modify sync: ${s3.discordSyncError}`);
    const d3 = await fetchDiscord(discordEventId);
    if (!d3) fail("event vanished after clearing rule");
    console.log("Step3 Discord recurrence:", JSON.stringify(d3.recurrence));
    if (d3.recurrence !== null) fail("Discord still shows a recurrence after clearing");
    console.log("Step3 reconcile-equal (no churn)?", recurrenceEqual(null, d3.recurrence));

    console.log("ALL STEPS PASSED");
  } finally {
    // Cleanup: remove the Discord event and the dev DB row.
    if (discordEventId) {
      const del = await deleteGuildScheduledEvent(discordEventId);
      console.log("cleanup discord delete:", JSON.stringify(del));
    }
    await db.delete(events).where(eq(events.id, row.id));
    console.log("cleanup db row deleted");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
