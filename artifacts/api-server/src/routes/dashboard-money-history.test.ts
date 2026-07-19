import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, walletTransactions, botBalanceHistory, botRentPaymentEvents } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

const app = buildTestApp();

type Entry = {
  source: "bot" | "portal";
  date: string;
  at: string;
  amount: number | null;
  label: string | null;
};

describe("GET /me/rent-history (merged bot + portal rent)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/me/rent-history");
    expect(res.status).toBe(401);
  });

  it("includes portal rent-style charges alongside bot history, excluding importer mirrors", async () => {
    const me = await createUser({ username: "renter" });

    // Bot ledger rent charge (boundary).
    await db.insert(botBalanceHistory).values({
      userId: me.id,
      ts: new Date("2026-05-01T07:00:00Z"),
      cashDelta: -500,
      bankDelta: 0,
      reason: "Flat monthly fee",
    });
    // Older channel row — kept.
    await db.insert(botRentPaymentEvents).values({
      messageId: "rent-old",
      userId: me.id,
      ts: new Date("2025-11-01T07:00:00Z"),
      kind: "baseline",
      label: "Baseline living cost",
      amount: 500,
    });
    // Portal-native rent charges from the monthly billing cron.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "baseline",
      amount: -500,
      memo: "Baseline living cost — July",
      createdAt: new Date("2026-07-01T07:00:00Z"),
    });
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "rent",
      amount: -1200,
      memo: "Housing rent — Kabuki apt",
      createdAt: new Date("2026-07-01T07:05:00Z"),
    });
    // Importer mirror (kind='historical') — must NOT double-count the ledger row.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "historical",
      category: "rent",
      amount: -500,
      memo: "[legacy-bal:1] Flat monthly fee",
      createdAt: new Date("2026-05-01T07:00:00Z"),
    });
    // Unrelated portal transaction — not rent, excluded from this view.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "transfer",
      amount: -50,
      memo: "eddies to a friend",
      createdAt: new Date("2026-07-02T07:00:00Z"),
    });

    const res = await request(app).get("/api/me/rent-history").set("x-test-user", me.id);
    expect(res.status).toBe(200);

    const entries = res.body.entries as Entry[];
    expect(res.body.totalCount).toBe(4);
    expect(res.body.botCount).toBe(2);
    expect(res.body.portalCount).toBe(2);
    expect(entries[0].source).toBe("portal");
    expect(entries.map((e) => e.label)).toContain("Housing rent — Kabuki apt");
    expect(entries.some((e) => (e.label ?? "").includes("[legacy-bal:"))).toBe(false);
  });
});

describe("GET /me/financial-history (merged bot ledger + portal wallet)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/me/financial-history");
    expect(res.status).toBe(401);
  });

  it("merges portal wallet movement with the bot ledger, excluding historical mirrors", async () => {
    const me = await createUser({ username: "moneybags" });

    await db.insert(botBalanceHistory).values({
      userId: me.id,
      ts: new Date("2026-05-10T07:00:00Z"),
      cashDelta: 0,
      bankDelta: 250,
      reason: "Attendance reward",
    });
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "mission_pay",
      amount: 1500,
      memo: "Mission payout: The Night Watch",
      createdAt: new Date("2026-07-05T07:00:00Z"),
    });
    // Importer mirror of the bot ledger — excluded.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "historical",
      amount: 250,
      memo: "[legacy-bal:2] Attendance reward",
      createdAt: new Date("2026-05-10T07:00:00Z"),
    });

    const res = await request(app).get("/api/me/financial-history").set("x-test-user", me.id);
    expect(res.status).toBe(200);

    const entries = res.body.entries as Entry[];
    expect(res.body.totalCount).toBe(2);
    expect(res.body.botCount).toBe(1);
    expect(res.body.portalCount).toBe(1);
    expect(entries[0]).toMatchObject({
      source: "portal",
      amount: 1500,
      label: "Mission payout: The Night Watch",
    });
    expect(entries[1]).toMatchObject({ source: "bot", amount: 250 });
  });
});
