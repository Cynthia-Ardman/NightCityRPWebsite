import { describe, it, expect } from "vitest";
import { db, ripperdocs, stores, ripperdocEmployees, storeEmployees } from "@workspace/db";
import request from "supertest";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

// Guards the public clinic/store directory detail pages against a recurring
// regression: the backend once returned staff under an `employees` object
// array while the page expected a flat `employeeNames` string list, so the
// pages silently showed "No staff listed" even when staff existed. These
// tests assert the contract the frontend relies on — `employeeNames` is a
// populated string array, and the old `employees` shape is NOT present.

const app = buildTestApp();

async function makeRipperdoc(ownerId: string | null, name = "Vik's Clinic") {
  const [r] = await db.insert(ripperdocs).values({ ownerId: ownerId as string, name }).returning();
  return r;
}
async function makeStore(ownerId: string | null, name = "Chrome Bazaar") {
  const [s] = await db.insert(stores).values({ ownerId: ownerId as string, name }).returning();
  return s;
}

describe("GET /directory/ripperdocs/:id (public staff list)", () => {
  it("returns employeeNames as a populated string array, not an employees object array", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const vik = await createCharacter({ ownerId: owner.id, name: "Viktor Vektor" });
    const nina = await createCharacter({ ownerId: owner.id, name: "Nina Kraviz" });
    await db.insert(ripperdocEmployees).values([
      { ripperdocId: rip.id, characterId: vik.id, role: "ripperdoc" },
      { ripperdocId: rip.id, characterId: nina.id, role: "assistant" },
    ]);

    const res = await request(app).get(`/api/directory/ripperdocs/${rip.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.employeeNames)).toBe(true);
    expect(res.body.employeeNames).toEqual(
      expect.arrayContaining(["Viktor Vektor", "Nina Kraviz"]),
    );
    expect(res.body.employeeNames).toHaveLength(2);
    // The old object-array field must NOT come back — the page reads employeeNames.
    expect(res.body.employees).toBeUndefined();
  });

  it("returns an empty employeeNames array when the clinic has no staff", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app).get(`/api/directory/ripperdocs/${rip.id}`);
    expect(res.status).toBe(200);
    expect(res.body.employeeNames).toEqual([]);
  });

  it("404s for a clinic that does not exist", async () => {
    const res = await request(app).get(`/api/directory/ripperdocs/999999`);
    expect(res.status).toBe(404);
  });
});

describe("GET /directory/stores/:id (public staff list)", () => {
  it("returns employeeNames as a populated string array, not an employees object array", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const jin = await createCharacter({ ownerId: owner.id, name: "Jin Tanaka" });
    const rex = await createCharacter({ ownerId: owner.id, name: "Rex Powers" });
    await db.insert(storeEmployees).values([
      { storeId: store.id, characterId: jin.id, role: "clerk" },
      { storeId: store.id, characterId: rex.id, role: "manager" },
    ]);

    const res = await request(app).get(`/api/directory/stores/${store.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.employeeNames)).toBe(true);
    expect(res.body.employeeNames).toEqual(
      expect.arrayContaining(["Jin Tanaka", "Rex Powers"]),
    );
    expect(res.body.employeeNames).toHaveLength(2);
    expect(res.body.employees).toBeUndefined();
  });

  it("returns an empty employeeNames array when the store has no staff", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app).get(`/api/directory/stores/${store.id}`);
    expect(res.status).toBe(200);
    expect(res.body.employeeNames).toEqual([]);
  });

  it("404s for a store that does not exist", async () => {
    const res = await request(app).get(`/api/directory/stores/999999`);
    expect(res.status).toBe(404);
  });
});
