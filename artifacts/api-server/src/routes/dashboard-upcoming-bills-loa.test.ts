import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, characterStatus, inventoryItems, housing } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

// The upcoming-bills projection must mirror the billing crons' LOA rules:
// the self-service character_status.loa toggle pauses meds, baseline
// (personal fees), and RESIDENTIAL lease rent — business leases keep billing.
// Without this the dashboard shows "due soon" lines the crons never charge
// (the exact confusion that triggered a player LOA complaint).
describe("GET /dashboard/upcoming-bills — self-service LOA parity", () => {
  async function setup(opts: { loa: boolean }) {
    const me = await createUser();
    const c = await createCharacter({ ownerId: me.id, name: "Chromed" });
    // 9 CWP of cyberware → medium band, billable if not excluded.
    await db.insert(inventoryItems).values({
      characterId: c.id,
      name: "Cyberarm",
      category: "cyberware",
      quantity: 1,
      notes: "CWP 9 · slot: arm",
    });
    // Backdate the implicit checkup so the 7-day suppression guard doesn't
    // zero the projection for reasons unrelated to LOA.
    await db.execute(
      `update characters set created_at = now() - interval '30 days', last_checkup_at = now() - interval '21 days' where id = ${c.id}`,
    );
    if (opts.loa) {
      await db.insert(characterStatus).values({ characterId: c.id, loa: true });
    }
    return { me, c };
  }

  it("projects meds + baseline for an active character", async () => {
    const { me } = await setup({ loa: false });
    const res = await request(app).get("/api/dashboard/upcoming-bills").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body.meds.length).toBe(1);
    expect(res.body.rent.length).toBeGreaterThan(0);
  });

  it("suppresses meds and baseline when the character is on self-service LOA", async () => {
    const { me } = await setup({ loa: true });
    const res = await request(app).get("/api/dashboard/upcoming-bills").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body.meds).toEqual([]);
    expect(res.body.rent).toEqual([]);
    expect(res.body.totals.nextMedsWeekly).toBe(0);
  });

  it("excludes paused residential lease rent from the Next Rent total but keeps business leases billing", async () => {
    const { me, c } = await setup({ loa: true });
    await db.insert(housing).values({
      characterId: c.id,
      address: "Apt 4B, Megabuilding H10",
      monthlyRent: 3000,
      kind: "residential",
    });
    await db.insert(housing).values({
      characterId: c.id,
      address: "Corner Shop, Japantown",
      monthlyRent: 1200,
      kind: "business",
    });
    const res = await request(app).get("/api/dashboard/upcoming-bills").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    const byAddress = Object.fromEntries(
      res.body.leases.map((l: { address: string; pausedForLoa: boolean }) => [l.address, l.pausedForLoa]),
    );
    expect(byAddress["Apt 4B, Megabuilding H10"]).toBe(true);
    expect(byAddress["Corner Shop, Japantown"]).toBe(false);
    // Only the business lease counts toward the headline total.
    expect(res.body.totals.nextRent).toBe(1200);
  });
});
