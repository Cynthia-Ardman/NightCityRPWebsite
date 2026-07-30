import { describe, it, expect } from "vitest";
import request from "supertest";

import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

const app = buildTestApp();

// Reproduces: player submits a sheet with cyberware, then edits it while
// pending — can they change/remove cyberware?
describe("pending sheet cyberware edits", () => {
  it("owner can change and remove cyberware on their pending sheet", async () => {
    const owner = await createUser();
    const data = {
      sheetType: "PC",
      fullName: "Test Runner",
      pronouns: "they/them",
      occupation: "Merc",
      archetype: "Solo",
      gender: "n/a",
      physicalDescription: "Tall.",
      psychProfile: "Calm.",
      background: "Grew up in Watson.",
      age: 27,
      skills: "Handguns 5",
      portraitUrls: ["https://example.com/p.png"],
      statsImageUrls: ["https://example.com/s.png"],
      cyberware: [
        { slot: "Ocular System", name: "SmartEyes", points: 2, notes: "" },
        { slot: "Neural", name: "Netrunner Suite (Level 1)", points: 1, notes: "" },
      ],
    };
    const created = await request(app)
      .post("/api/sheets")
      .set("x-test-user", owner.id)
      .send({ name: "Test Runner", data });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    expect(created.body.status).toBe("pending");

    const loaded = await request(app).get(`/api/sheets/${id}`).set("x-test-user", owner.id);
    expect(loaded.status).toBe(200);

    // Change: swap items, remove one.
    const patch1 = await request(app)
      .patch(`/api/sheets/${id}`)
      .set("x-test-user", owner.id)
      .send({
        name: "Test Runner",
        data: { ...data, cyberware: [{ slot: "Neural", name: "Memory Bank", points: 2, notes: "" }] },
        baseUpdatedAt: loaded.body.updatedAt,
      });
    expect(patch1.status, JSON.stringify(patch1.body)).toBe(200);
    expect(patch1.body.data.cyberware).toHaveLength(1);
    expect(patch1.body.data.cyberware[0].name).toBe("Memory Bank");

    // Remove all cyberware.
    const patch2 = await request(app)
      .patch(`/api/sheets/${id}`)
      .set("x-test-user", owner.id)
      .send({
        name: "Test Runner",
        data: { ...data, cyberware: [] },
        baseUpdatedAt: patch1.body.updatedAt,
      });
    expect(patch2.status, JSON.stringify(patch2.body)).toBe(200);
    expect(patch2.body.data.cyberware).toHaveLength(0);
  });
});
