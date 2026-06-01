import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  db,
  walletTransactions,
  stores,
  auditLog,
  activityEvents,
  missions,
  missionAssignments,
  missionActorPayments,
  attendanceClaims,
  ripperdocs,
  characters,
} from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

describe("GET /fixer/players (search)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/fixer/players?q=foo").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("returns an empty array when q is blank", async () => {
    const fixer = await createFixer();
    const res = await request(app).get("/api/fixer/players?q=").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("matches by username and surfaces owned character names", async () => {
    const fixer = await createFixer();
    const target = await createUser({ username: "johnny_silverhand" });
    await createCharacter({ ownerId: target.id, name: "Samurai" });

    const res = await request(app).get("/api/fixer/players?q=silver").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    const row = res.body.find((p: { id: string }) => p.id === target.id);
    expect(row).toBeTruthy();
    expect(row.username).toBe("johnny_silverhand");
    expect(row.characterNames).toContain("Samurai");
  });

  it("matches a player by an owned character name", async () => {
    const fixer = await createFixer();
    const owner = await createUser({ username: "v_merc" });
    await createCharacter({ ownerId: owner.id, name: "Nightcity Legend" });

    const res = await request(app).get("/api/fixer/players?q=Nightcity").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: { id: string }) => p.id);
    expect(ids).toContain(owner.id);
  });
});

describe("GET /fixer/players/:userId/activity (aggregation)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const res = await request(app).get(`/api/fixer/players/${user.id}/activity`).set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("404s for an unknown player", async () => {
    const admin = await createAdmin();
    const res = await request(app).get("/api/fixer/players/does-not-exist/activity").set("x-test-user", admin.id);
    expect(res.status).toBe(404);
  });

  it("aggregates characters, wallet (by userId and characterId), and owned stores", async () => {
    const admin = await createAdmin();
    const target = await createUser({ username: "panam" });
    const char = await createCharacter({ ownerId: target.id, name: "Aldecaldo" });

    // userId-level wallet row
    await db.insert(walletTransactions).values({ userId: target.id, amount: 500, kind: "deposit" });
    // character-scoped wallet row
    await db.insert(walletTransactions).values({ characterId: char.id, amount: -200, kind: "purchase" });

    const [store] = await db
      .insert(stores)
      .values({ ownerId: target.id, name: "Aldecaldo Wares", balance: 1000 })
      .returning();

    const res = await request(app).get(`/api/fixer/players/${target.id}/activity`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);

    expect(res.body.player.id).toBe(target.id);
    expect(res.body.player.username).toBe("panam");

    const charNames = res.body.characters.map((c: { name: string }) => c.name);
    expect(charNames).toContain("Aldecaldo");

    expect(res.body.walletTransactions.length).toBe(2);
    const charTx = res.body.walletTransactions.find((t: { characterId: number | null }) => t.characterId === char.id);
    expect(charTx).toBeTruthy();
    expect(charTx.characterName).toBe("Aldecaldo");

    const storeNames = res.body.stores.map((s: { name: string }) => s.name);
    expect(storeNames).toContain("Aldecaldo Wares");
    expect(res.body.stores.find((s: { id: number }) => s.id === store.id).balance).toBe(1000);

    // Empty groups are present as arrays
    expect(Array.isArray(res.body.auditEntries)).toBe(true);
    expect(Array.isArray(res.body.missions)).toBe(true);
    expect(Array.isArray(res.body.attendanceClaims)).toBe(true);
  });

  it("does not leak another player's wallet transactions", async () => {
    const admin = await createAdmin();
    const a = await createUser({ username: "alt_a" });
    const b = await createUser({ username: "alt_b" });
    await db.insert(walletTransactions).values({ userId: b.id, amount: 999, kind: "deposit" });

    const res = await request(app).get(`/api/fixer/players/${a.id}/activity`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.walletTransactions.length).toBe(0);
  });

  it("surfaces a non-empty, well-shaped row for every activity group", async () => {
    const admin = await createAdmin();
    const target = await createUser({ username: "river" });
    const fixer = await createFixer({ username: "wakako" });
    const char = await createCharacter({ ownerId: target.id, name: "Detective Ward" });

    // audit edit performed by the player
    await db.insert(auditLog).values({
      category: "character",
      action: "update",
      actorId: target.id,
      actorName: "river",
      targetType: "character",
      targetId: String(char.id),
      message: "Edited their dossier",
    });

    // activity event attributed to the player
    await db.insert(activityEvents).values({
      kind: "login",
      actorId: target.id,
      actorName: "river",
      message: "Logged in",
    });

    // a mission with a player assignment joined to it
    const [mission] = await db
      .insert(missions)
      .values({ title: "The Heist", tier: 2, startAt: new Date("2026-05-20T18:00:00Z") })
      .returning();
    await db.insert(missionAssignments).values({
      missionId: mission.id,
      userId: target.id,
      characterId: char.id,
      paymentStatus: "paid",
      payAmount: 1500,
      paidAt: new Date("2026-05-20T21:00:00Z"),
    });

    // actor payment (player acted in another mission/event)
    await db.insert(missionActorPayments).values({
      missionId: mission.id,
      missionName: "The Heist",
      userId: target.id,
      userName: "river",
      characterName: "Detective Ward",
      fixerName: "wakako",
      fixerId: fixer.id,
      amount: 800,
      paymentStatus: "paid",
      missionDate: new Date("2026-05-20T18:00:00Z"),
      paidAt: new Date("2026-05-20T21:05:00Z"),
    });

    // weekly attendance claim
    await db.insert(attendanceClaims).values({
      userId: target.id,
      weekStart: "2026-05-18",
      amount: 250,
    });

    // a ripperdoc clinic owned by the player
    await db.insert(ripperdocs).values({
      ownerId: target.id,
      name: "Ward Cybernetics",
      location: "Watson",
      balance: 4200,
    });

    const res = await request(app).get(`/api/fixer/players/${target.id}/activity`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);

    // audit
    expect(res.body.auditEntries.length).toBeGreaterThan(0);
    const audit = res.body.auditEntries[0];
    expect(audit.category).toBe("character");
    expect(audit.action).toBe("update");
    expect(audit.message).toBe("Edited their dossier");
    expect(new Date(audit.createdAt).toISOString()).toBe(audit.createdAt);

    // activity events
    expect(res.body.activityEvents.length).toBeGreaterThan(0);
    const event = res.body.activityEvents[0];
    expect(event.kind).toBe("login");
    expect(event.message).toBe("Logged in");
    expect(new Date(event.createdAt).toISOString()).toBe(event.createdAt);

    // missions (joined mission title + character name)
    expect(res.body.missions.length).toBeGreaterThan(0);
    const missionRow = res.body.missions.find((m: { missionId: number }) => m.missionId === mission.id);
    expect(missionRow).toBeTruthy();
    expect(missionRow.missionTitle).toBe("The Heist");
    expect(missionRow.characterName).toBe("Detective Ward");
    expect(missionRow.paymentStatus).toBe("paid");
    expect(missionRow.payAmount).toBe(1500);
    expect(new Date(missionRow.missionStartAt).toISOString()).toBe(missionRow.missionStartAt);
    expect(new Date(missionRow.paidAt).toISOString()).toBe(missionRow.paidAt);

    // actor payments
    expect(res.body.actorPayments.length).toBeGreaterThan(0);
    const actor = res.body.actorPayments[0];
    expect(actor.missionName).toBe("The Heist");
    expect(actor.characterName).toBe("Detective Ward");
    expect(actor.fixerName).toBe("wakako");
    expect(actor.amount).toBe(800);
    expect(new Date(actor.missionDate).toISOString()).toBe(actor.missionDate);
    expect(new Date(actor.paidAt).toISOString()).toBe(actor.paidAt);

    // attendance claims
    expect(res.body.attendanceClaims.length).toBeGreaterThan(0);
    const claim = res.body.attendanceClaims[0];
    expect(claim.weekStart).toBe("2026-05-18");
    expect(claim.amount).toBe(250);
    expect(new Date(claim.claimedAt).toISOString()).toBe(claim.claimedAt);

    // ripperdocs
    expect(res.body.ripperdocs.length).toBeGreaterThan(0);
    const clinic = res.body.ripperdocs.find((r: { name: string }) => r.name === "Ward Cybernetics");
    expect(clinic).toBeTruthy();
    expect(clinic.location).toBe("Watson");
    expect(clinic.balance).toBe(4200);
    expect(new Date(clinic.createdAt).toISOString()).toBe(clinic.createdAt);
  });

  it("does not misattribute a character-scoped wallet row after ownership transfer", async () => {
    const admin = await createAdmin();
    const seller = await createUser({ username: "seller" });
    const buyer = await createUser({ username: "buyer" });
    const char = await createCharacter({ ownerId: seller.id, name: "Transferred Merc" });

    // character-scoped wallet row earned while the seller owned the character
    await db.insert(walletTransactions).values({ characterId: char.id, amount: -300, kind: "purchase" });

    // transfer the character to the buyer
    await db.update(characters).set({ ownerId: buyer.id }).where(eq(characters.id, char.id));

    // seller no longer owns the character: the row must NOT appear in their dossier
    const sellerRes = await request(app).get(`/api/fixer/players/${seller.id}/activity`).set("x-test-user", admin.id);
    expect(sellerRes.status).toBe(200);
    expect(sellerRes.body.walletTransactions.length).toBe(0);

    // buyer now owns the character: the row follows the character to its current owner
    const buyerRes = await request(app).get(`/api/fixer/players/${buyer.id}/activity`).set("x-test-user", admin.id);
    expect(buyerRes.status).toBe(200);
    const buyerTx = buyerRes.body.walletTransactions.find((t: { characterId: number | null }) => t.characterId === char.id);
    expect(buyerTx).toBeTruthy();
    expect(buyerTx.characterName).toBe("Transferred Merc");
    expect(buyerTx.amount).toBe(-300);
  });
});
