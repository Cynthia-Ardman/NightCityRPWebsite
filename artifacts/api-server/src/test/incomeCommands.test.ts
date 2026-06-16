import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, botConfig, incomeCommandUses } from "@workspace/db";
import { buildTestApp } from "./app";
import request from "supertest";
import { createUser } from "./testDb";

const app = buildTestApp();

// Put the economy in TEST (dry-run) mode: kill switch ON, but the `economy`
// LiveSystem stays OFF (default), so applyWalletDelta returns a dry_run result
// without touching UnbelievaBoat. That lets us exercise the WORK payout +
// cooldown machinery with zero external calls.
async function enableEconomyTestMode() {
  await db
    .insert(botConfig)
    .values({ key: "economy_enabled", value: true })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: true } });
}

function work(userId: string) {
  return request(app).post("/api/economy/income/work").set("x-test-user", userId).send({});
}

describe("income WORK command", () => {
  beforeEach(async () => {
    await enableEconomyTestMode();
  });

  it("pays a random 100–200 and records the cooldown", async () => {
    const u = await createUser();
    const res = await work(u.id);
    expect(res.status).toBe(200);
    expect(res.body.command).toBe("work");
    expect(res.body.outcome).toBe("earned");
    expect(res.body.amount).toBeGreaterThanOrEqual(100);
    expect(res.body.amount).toBeLessThanOrEqual(200);
    expect(typeof res.body.cooldownEndsAt).toBe("string");

    const [row] = await db
      .select()
      .from(incomeCommandUses)
      .where(and(eq(incomeCommandUses.userId, u.id), eq(incomeCommandUses.command, "work")));
    expect(row).toBeTruthy();
  });

  it("rejects a second WORK within the cooldown window (429)", async () => {
    const u = await createUser();
    const first = await work(u.id);
    expect(first.status).toBe(200);

    const second = await work(u.id);
    expect(second.status).toBe(429);
    expect(typeof second.body.cooldownEndsAt).toBe("string");
  });

  it("does not consume a cooldown when the economy is disabled", async () => {
    // Flip the kill switch OFF so applyWalletDelta returns status "disabled".
    await db
      .insert(botConfig)
      .values({ key: "economy_enabled", value: false })
      .onConflictDoUpdate({ target: botConfig.key, set: { value: false } });

    const u = await createUser();
    const res = await work(u.id);
    // The economy-disabled case returns a specific 503 (Service Unavailable)
    // with an admin-actionable message; other failures use 502.
    expect(res.status).toBe(503);

    // Reservation must be rolled back so the player can retry once it's back on.
    const rows = await db
      .select()
      .from(incomeCommandUses)
      .where(and(eq(incomeCommandUses.userId, u.id), eq(incomeCommandUses.command, "work")));
    expect(rows.length).toBe(0);
  });
});
