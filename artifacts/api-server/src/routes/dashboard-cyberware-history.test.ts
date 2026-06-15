import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  db,
  walletTransactions,
  botBalanceHistory,
  botRentPaymentEvents,
  botCyberwareWeeklyRuns,
  auditLog,
} from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

type Entry = {
  source: "bot" | "portal";
  type: "meds" | "checkup";
  date: string;
  at: string;
  amount: number | null;
  label: string;
};

describe("GET /me/cyberware-history (merged meds + checkup history)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/me/cyberware-history");
    expect(res.status).toBe(401);
  });

  it("merges bot + portal meds and checkups without double-counting, tagged by era", async () => {
    const me = await createUser({ username: "medusa" });
    const myChar = await createCharacter({ ownerId: me.id, name: "Medusa" });

    // Bot ledger (authoritative recent source). Earliest ledger ts = boundary.
    await db.insert(botBalanceHistory).values({
      userId: me.id,
      ts: new Date("2026-05-11T07:00:00Z"),
      cashDelta: -39,
      bankDelta: 0,
      reason: "Cyberware meds week 1",
    });

    // Bot channel row OLDER than the ledger boundary — kept.
    await db.insert(botRentPaymentEvents).values({
      messageId: "msg-old",
      userId: me.id,
      ts: new Date("2025-12-01T07:00:00Z"),
      kind: "cyberware_meds",
      label: "Cyberware meds week 7",
      amount: 1000,
    });
    // Bot channel row ON the ledger boundary day — superseded by the ledger and
    // dropped to avoid double-counting the same charge.
    await db.insert(botRentPaymentEvents).values({
      messageId: "msg-dup",
      userId: me.id,
      ts: new Date("2026-05-11T07:00:00Z"),
      kind: "cyberware_meds",
      label: "Cyberware meds week 1",
      amount: 39,
    });

    // Portal-native weekly meds — included, tagged portal.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "meds",
      amount: -195,
      memo: "Weekly cyberpsychosis meds (high)",
      createdAt: new Date("2026-06-15T05:00:00Z"),
    });
    // Legacy importer mirror of the bot ledger (kind='historical') — must be
    // EXCLUDED so it does not double-count the ledger row above.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "historical",
      category: "cyberware",
      amount: -39,
      memo: "[legacy-bal:364] Cyberware meds week 1",
      createdAt: new Date("2026-05-11T07:00:00Z"),
    });

    // Bot-era checkup (weekly run lists this user's Discord id).
    await db.insert(botCyberwareWeeklyRuns).values({
      runAt: new Date("2025-10-13T07:00:00Z"),
      checkupIds: [me.id],
    });
    // Portal-era checkup (audit row for a character this user owns).
    await db.insert(auditLog).values({
      category: "character",
      action: "checkup",
      targetType: "character",
      targetId: String(myChar.id),
      message: "Ripperdoc checkup for Medusa",
      createdAt: new Date("2026-05-28T07:00:00Z"),
    });

    const res = await request(app).get("/api/me/cyberware-history").set("x-test-user", me.id);
    expect(res.status).toBe(200);

    const entries = res.body.entries as Entry[];
    // ledger(1) + old channel(1) + portal meds(1) + bot checkup(1) + portal checkup(1)
    expect(res.body.totalCount).toBe(5);
    expect(res.body.botCount).toBe(3);
    expect(res.body.portalCount).toBe(2);

    // The boundary-day charge appears exactly once (the ledger row, not the
    // duplicated channel row).
    const boundaryDay = entries.filter((e) => e.date === "2026-05-11");
    expect(boundaryDay).toHaveLength(1);
    expect(boundaryDay[0].amount).toBe(-39);
    expect(boundaryDay[0].source).toBe("bot");

    // Portal meds present and tagged portal.
    const portalMeds = entries.find((e) => e.amount === -195);
    expect(portalMeds).toBeTruthy();
    expect(portalMeds!.source).toBe("portal");
    expect(portalMeds!.type).toBe("meds");

    // Legacy mirror row is never surfaced.
    expect(entries.every((e) => !(e.label ?? "").includes("[legacy-bal:"))).toBe(true);

    // Both eras' checkups appear as money-less markers.
    const checkups = entries.filter((e) => e.type === "checkup");
    expect(checkups).toHaveLength(2);
    expect(checkups.every((e) => e.amount === null)).toBe(true);
    expect(checkups.some((e) => e.source === "bot")).toBe(true);
    expect(checkups.some((e) => e.source === "portal")).toBe(true);

    // Entries are newest-first.
    const ats = entries.map((e) => e.at);
    expect([...ats].sort((a, b) => b.localeCompare(a))).toEqual(ats);
  });

  it("keeps a genuine portal meds charge that lands on a bot-ledger day", async () => {
    const me = await createUser({ username: "v_solo" });

    await db.insert(botBalanceHistory).values({
      userId: me.id,
      ts: new Date("2026-06-01T07:00:00Z"),
      cashDelta: -312,
      bankDelta: 0,
      reason: "Cyberware meds week 4",
    });
    // Portal charge on the SAME day as a bot ledger row but a different event —
    // must NOT be suppressed.
    await db.insert(walletTransactions).values({
      userId: me.id,
      kind: "meds",
      amount: -100,
      memo: "Weekly cyberpsychosis meds (correction)",
      createdAt: new Date("2026-06-01T12:00:00Z"),
    });

    const res = await request(app).get("/api/me/cyberware-history").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    const entries = res.body.entries as Entry[];
    expect(entries.find((e) => e.amount === -312)?.source).toBe("bot");
    expect(entries.find((e) => e.amount === -100)?.source).toBe("portal");
    expect(res.body.totalCount).toBe(2);
  });

  it("works for a user with no owned characters (no portal checkup branch)", async () => {
    const me = await createUser({ username: "loner" });
    await db.insert(botBalanceHistory).values({
      userId: me.id,
      ts: new Date("2025-09-01T07:00:00Z"),
      cashDelta: -20,
      bankDelta: 0,
      reason: "Cyberware meds week 2",
    });

    const res = await request(app).get("/api/me/cyberware-history").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(1);
    expect(res.body.botCount).toBe(1);
    expect(res.body.portalCount).toBe(0);
  });
});
