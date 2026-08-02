import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, missionActorPayments } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

describe("POST /missions/actor-payouts — general (character-tied) pay", () => {
  it("rejects general pay without a character", async () => {
    const fixer = await createFixer();
    const player = await createUser();
    const res = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send({ eventName: "Bounty", eventType: "general", userIds: [player.id], amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/character/i);
  });

  it("rejects a character that belongs to a different player", async () => {
    const fixer = await createFixer();
    const player = await createUser();
    const other = await createUser();
    const char = await createCharacter({ ownerId: other.id, approved: true });
    const res = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send({ eventName: "Bounty", eventType: "general", userIds: [player.id], amount: 100, characterId: char.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/belong/i);
  });

  it("rejects character-tied pay targeting multiple players", async () => {
    const fixer = await createFixer();
    const a = await createUser();
    const b = await createUser();
    const char = await createCharacter({ ownerId: a.id, approved: true });
    const res = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send({ eventName: "Bounty", eventType: "general", userIds: [a.id, b.id], amount: 100, characterId: char.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly one/i);
  });

  it("rejects characterId on non-general payouts", async () => {
    const fixer = await createFixer();
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id, approved: true });
    const res = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send({ eventName: "Sunday Session", userIds: [player.id], amount: 100, characterId: char.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/general/i);
  });

  it("dedupes an identical general payout fired twice in quick succession", async () => {
    const fixer = await createFixer();
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id, approved: true });
    const payload = {
      eventName: "Bounty: same tip twice",
      eventType: "general",
      userIds: [player.id],
      amount: 500,
      characterId: char.id,
    };
    const first = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.result.simulated).toBe(1);

    const second = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.result.skipped).toBe(1);
    expect(second.body.result.simulated).toBe(0);

    const rows = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.userId, player.id));
    expect(rows).toHaveLength(1);
  });

  it("records a general payout with character binding and surfaces it in the payout list", async () => {
    const fixer = await createFixer();
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id, approved: true });
    const res = await request(app)
      .post("/api/missions/actor-payouts")
      .set("x-test-user", fixer.id)
      .send({
        eventName: "Bounty: rogue netrunner tip-off",
        eventType: "general",
        userIds: [player.id],
        amount: 750,
        characterId: char.id,
      });
    expect(res.status).toBe(200);
    // Test mode (no live flags in the test DB) — recorded as simulated, no UB call.
    expect(res.body.result.simulated).toBe(1);

    const [row] = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.userId, player.id));
    expect(row.eventType).toBe("general");
    expect(row.characterId).toBe(char.id);
    expect(row.characterName).toBe(char.name);
    expect(row.amount).toBe(750);

    const ev = res.body.payouts.find((p: any) => p.eventType === "general");
    expect(ev).toBeTruthy();
    expect(ev.actors[0].characterName).toBe(char.name);
  });
});

describe("GET /fixer/players/:userId/characters", () => {
  it("is fixer/admin only", async () => {
    const user = await createUser();
    const res = await request(app).get(`/api/fixer/players/${user.id}/characters`).set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("lists a player's non-archived characters", async () => {
    const fixer = await createFixer();
    const player = await createUser();
    const c1 = await createCharacter({ ownerId: player.id, approved: true });
    const res = await request(app).get(`/api/fixer/players/${player.id}/characters`).set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toContain(c1.id);
    expect(res.body[0]).toHaveProperty("name");
    expect(res.body[0]).toHaveProperty("kind");
  });
});
