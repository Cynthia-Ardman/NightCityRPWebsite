import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

import { db, characters, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

describe("PATCH /characters/:id/kind", () => {
  it("403 for a regular player (even the owner)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", owner.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(403);
  });

  it("fixer can convert a PC to an NPC (and back), with audit trail", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "pc" });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("npc");
    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.kind).toBe("npc");
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, String(char.id)));
    expect(audits.some((a) => a.action === "set_kind")).toBe(true);
    const back = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(back.status).toBe(200);
    expect(back.body.kind).toBe("pc");
  });

  it("400 for an invalid kind", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const char = await createCharacter({ ownerId: fixer.id });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "monster" });
    expect(res.status).toBe(400);
  });

  it("no-op when the kind already matches", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const char = await createCharacter({ ownerId: fixer.id, kind: "npc" });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, String(char.id)));
    expect(audits.some((a) => a.action === "set_kind")).toBe(false);
  });

  it("409 when converting an over-cap NPC to PC", async () => {
    const { inventoryItems } = await import("@workspace/db");
    const fixer = await createUser({ roles: ["fixer"] });
    const char = await createCharacter({ ownerId: fixer.id, kind: "npc" });
    await db.insert(inventoryItems).values({
      characterId: char.id,
      ownerId: fixer.id,
      name: "Heavy Chrome",
      category: "cyberware",
      quantity: 1,
      notes: "CWP 20 · Installed at Rook's on 2026-01-01",
    });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/CWP/);
    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.kind).toBe("npc");
  });

  it("404 for an unknown character", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app)
      .patch(`/api/characters/999999/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(404);
  });
});
