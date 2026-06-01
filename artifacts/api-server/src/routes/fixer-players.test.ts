import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, walletTransactions, stores } from "@workspace/db";
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
});
