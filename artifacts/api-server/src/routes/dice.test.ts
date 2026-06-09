import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, diceRolls } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

describe("POST /dice/roll", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app).post("/api/dice/roll").send({ expression: "1d20" });
    expect(res.status).toBe(401);
  });

  it("rejects a missing or blank expression with 400", async () => {
    const user = await createUser();
    const blank = await request(app)
      .post("/api/dice/roll")
      .set("x-test-user", user.id)
      .send({ expression: "   " });
    expect(blank.status).toBe(400);

    const missing = await request(app)
      .post("/api/dice/roll")
      .set("x-test-user", user.id)
      .send({});
    expect(missing.status).toBe(400);
  });

  it("rejects an unparseable expression with 400", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/dice/roll")
      .set("x-test-user", user.id)
      .send({ expression: "not-dice" });
    expect(res.status).toBe(400);
  });

  it("rolls a pure-modifier expression deterministically and persists the row", async () => {
    const user = await createUser();
    // A modifier-only expression has no random component, so the total is fixed.
    const res = await request(app)
      .post("/api/dice/roll")
      .set("x-test-user", user.id)
      .send({ expression: "+5", label: "test roll" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.modifier).toBe(5);
    expect(res.body.label).toBe("test roll");

    const rows = await db.select().from(diceRolls);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(user.id);
  });

  it("rolls a real die within its range", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/dice/roll")
      .set("x-test-user", user.id)
      .send({ expression: "1d20" });
    expect(res.status).toBe(200);
    expect(res.body.rolls).toHaveLength(1);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBeLessThanOrEqual(20);
  });

  it("stamps the character name when a characterId is supplied", async () => {
    const user = await createUser();
    const char = await createCharacter({ ownerId: user.id, name: "V" });
    const res = await request(app)
      .post("/api/dice/roll")
      .set("x-test-user", user.id)
      .send({ expression: "+1", characterId: char.id });
    expect(res.status).toBe(200);
    expect(res.body.characterName).toBe("V");
    expect(res.body.characterId).toBe(char.id);
  });
});

describe("GET /dice/history", () => {
  it("returns only the caller's own rolls, newest first", async () => {
    const me = await createUser();
    const other = await createUser();
    await request(app).post("/api/dice/roll").set("x-test-user", other.id).send({ expression: "+1" });
    await request(app).post("/api/dice/roll").set("x-test-user", me.id).send({ expression: "+1", label: "first" });
    await request(app).post("/api/dice/roll").set("x-test-user", me.id).send({ expression: "+1", label: "second" });

    const res = await request(app).get("/api/dice/history").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((r: { userId: string }) => r.userId === me.id)).toBe(true);
    expect(res.body[0].label).toBe("second");
  });
});
