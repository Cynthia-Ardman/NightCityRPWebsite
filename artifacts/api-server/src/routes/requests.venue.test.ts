import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn(async () => "dm-id"),
  };
});

import { db, customRequests, stores, ripperdocs, housing, inventoryItems, auditLog, catalogGuns, storeStock } from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-id");
});

function createFixer() {
  return createUser({ roles: ["fixer"] });
}

const VENUE_BODY = {
  title: "Watson Wholesale",
  purpose: "General goods",
  location: "Watson, Northside",
  description: "A corner shop for the neighborhood.",
};

describe("POST /requests (venue submit validation)", () => {
  it("400s a store request missing purpose/location/description", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Watson Wholesale" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/purpose, location, and description/i);
  });

  it("404s when the character is not owned by the caller", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const char = await createCharacter({ ownerId: stranger.id });
    const res = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    expect(res.status).toBe(404);
  });

  it("201s and stashes purpose/location in details for a store", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("store");
    expect(res.body.status).toBe("pending");
    expect(res.body.title).toBe("Watson Wholesale");
    expect(res.body.description).toBe(VENUE_BODY.description);
    expect(res.body.details).toMatchObject({ purpose: VENUE_BODY.purpose, location: VENUE_BODY.location });
  });

  it("201s for a ripperdoc request", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "ripperdoc", characterId: char.id, ...VENUE_BODY, title: "Vik's Clinic" });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("ripperdoc");
  });
});

describe("POST /requests/:id/vote (venue materialization)", () => {
  it("defers store creation to close, then audit-logs and DMs", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    const reqId = submit.body.id as number;

    const res = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", fixer.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    // Staged lifecycle: approval defers the effect (no store, no DM yet).
    expect(res.body.appliedRef).toBeNull();
    expect(await db.select().from(stores)).toHaveLength(0);
    expect(mockDm).not.toHaveBeenCalled();

    // Close commits the store and notifies the requester.
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(close.body.appliedRef).toMatch(/^store:\d+$/);

    const createdStores = await db.select().from(stores);
    expect(createdStores).toHaveLength(1);
    const s = createdStores[0];
    expect(s.ownerId).toBe(owner.id);
    expect(s.ownerCharacterId).toBe(char.id);
    expect(s.name).toBe("Watson Wholesale");
    expect(s.purpose).toBe(VENUE_BODY.purpose);
    expect(s.location).toBe(VENUE_BODY.location);
    expect(s.description).toBe(VENUE_BODY.description);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_vote_approve"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].category).toBe("shop");

    expect(mockDm).toHaveBeenCalledTimes(1);
  });

  it("vote is idempotent: a second approve 409s and creates no store before close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    const reqId = submit.body.id as number;

    const first = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(second.status).toBe(409);

    // Still deferred — nothing materialized until close.
    expect(await db.select().from(stores)).toHaveLength(0);
  });

  it("creates a ripperdoc on close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "ripperdoc", characterId: char.id, ...VENUE_BODY, title: "Vik's Clinic" });
    const reqId = submit.body.id as number;

    const vote = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(vote.status).toBe(200);
    expect(await db.select().from(ripperdocs)).toHaveLength(0);

    const res = await request(app).post(`/api/review/request/${reqId}/close`).set("x-test-user", fixer.id).send({});
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^ripperdoc:\d+$/);

    const docs = await db.select().from(ripperdocs);
    expect(docs).toHaveLength(1);
    expect(docs[0].ownerId).toBe(owner.id);
    expect(docs[0].ownerCharacterId).toBe(char.id);
    expect(docs[0].name).toBe("Vik's Clinic");
  });

  it("assigns venue ownership to the character owner, not the admin submitter", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    // Admin submits on behalf of another player's character.
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", admin.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    expect(submit.status).toBe(201);

    const vote = await request(app)
      .post(`/api/requests/${submit.body.id}/vote`)
      .set("x-test-user", fixer.id)
      .send({ vote: "approve" });
    expect(vote.status).toBe(200);

    const res = await request(app)
      .post(`/api/review/request/${submit.body.id}/close`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(200);

    const createdStores = await db.select().from(stores);
    expect(createdStores).toHaveLength(1);
    expect(createdStores[0].ownerId).toBe(owner.id);
    expect(createdStores[0].ownerId).not.toBe(admin.id);
    expect(createdStores[0].ownerCharacterId).toBe(char.id);
  });

  it("403s when the approver is not fixer/admin", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    const res = await request(app)
      .post(`/api/requests/${submit.body.id}/vote`)
      .set("x-test-user", owner.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);
  });
});

// Regression guard for the approve-handler lock fix: the row was previously
// locked with a raw `SELECT *` cast to the camelCase type, leaving characterId
// undefined and 400-ing EVERY approve type. These exercise the legacy types so
// the typed `.for("update")` read can't silently regress.
describe("POST /requests/:id/vote (legacy types regression)", () => {
  async function submit(ownerId: string, type: string, extra: Record<string, unknown> = {}) {
    const char = await createCharacter({ ownerId });
    const res = await request(app)
      .post("/api/requests")
      .set("x-test-user", ownerId)
      .send({ type, characterId: char.id, title: `${type} item`, description: "desc", ...extra });
    return { char, reqId: res.body.id as number, status: res.status };
  }

  it("materializes a housing lease on close, carrying decision params from the vote", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, reqId } = await submit(owner.id, "property");
    const vote = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", fixer.id)
      .send({ vote: "approve", monthlyRent: 1500 });
    expect(vote.status).toBe(200);
    expect(await db.select().from(housing)).toHaveLength(0);

    const res = await request(app).post(`/api/review/request/${reqId}/close`).set("x-test-user", fixer.id).send({});
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^housing:\d+$/);
    const leases = await db.select().from(housing);
    expect(leases).toHaveLength(1);
    expect(leases[0].characterId).toBe(char.id);
    expect(leases[0].monthlyRent).toBe(1500);
  });

  it("materializes a gun inventory item on close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, reqId } = await submit(owner.id, "gun");
    const vote = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(vote.status).toBe(200);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const res = await request(app).post(`/api/review/request/${reqId}/close`).set("x-test-user", fixer.id).send({});
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^inventory:/);
    const items = await db.select().from(inventoryItems);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("gun");
    expect(items[0].characterId).toBe(char.id);
    expect(items[0].ownerId).toBe(owner.id);
  });

  it("materializes a cyberware inventory item with a CWP token on close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, reqId } = await submit(owner.id, "cyberware");
    const vote = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve", cwp: 4 });
    expect(vote.status).toBe(200);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const res = await request(app).post(`/api/review/request/${reqId}/close`).set("x-test-user", fixer.id).send({});
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^inventory:/);
    const items = await db.select().from(inventoryItems);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("cyberware");
    expect(items[0].characterId).toBe(char.id);
    expect(items[0].notes).toMatch(/CWP 4/);
  });
});

describe("POST /requests/:id/vote reject (venue)", () => {
  it("records the reviewer note, creates no venue, and DMs", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, ...VENUE_BODY });
    const reqId = submit.body.id as number;

    const res = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", fixer.id)
      .send({ vote: "reject", note: "Too close to an existing store." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.reviewerNote).toBe("Too close to an existing store.");

    const createdStores = await db.select().from(stores);
    expect(createdStores).toHaveLength(0);

    const row = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row[0].status).toBe("rejected");
    expect(row[0].appliedRef).toBeNull();

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_vote_reject"));
    expect(audits).toHaveLength(1);
    expect(audits[0].category).toBe("shop");

    expect(mockDm).toHaveBeenCalledTimes(1);
  });
});

describe("POST /requests/:id/stock-decision (owner authorization)", () => {
  async function makeStockCostRequest(ownerId: string, fixerId: string, balance = 10000) {
    await createCharacter({ ownerId });
    const [store] = await db
      .insert(stores)
      .values({ ownerId, name: "Liberty Arms", balance })
      .returning();
    const [gun] = await db
      .insert(catalogGuns)
      .values({ name: "Overture", price: 100, wholesalePrice: 40 })
      .returning();
    const res = await request(app)
      .post(`/api/stores/${store.id}/purchase`)
      .set("x-test-user", fixerId)
      .send({ catalogId: gun.id, qty: 2, unitCost: 500 });
    expect(res.status).toBe(201);
    expect(res.body.pendingApproval).toBe(true);
    return { store, requestId: res.body.requestId as number };
  }

  it("blocks the OLD owner from approving after the venue is reassigned", async () => {
    const oldOwner = await createUser();
    const newOwner = await createUser();
    const fixer = await createFixer();
    const { store, requestId } = await makeStockCostRequest(oldOwner.id, fixer.id);

    // Staff reassigns the venue to a different owner.
    await db.update(stores).set({ ownerId: newOwner.id }).where(eq(stores.id, store.id));

    const res = await request(app)
      .post(`/api/requests/${requestId}/stock-decision`)
      .set("x-test-user", oldOwner.id)
      .send({ decision: "approve" });
    expect(res.status).toBe(403);

    // Nothing was spent and no stock was added.
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(10000);
    expect(await db.select().from(storeStock).where(eq(storeStock.storeId, store.id))).toHaveLength(0);
    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, requestId));
    expect(row.status).toBe("pending");
  });

  it("lets the NEW owner approve after reassignment, debiting their balance", async () => {
    const oldOwner = await createUser();
    const newOwner = await createUser();
    const fixer = await createFixer();
    const { store, requestId } = await makeStockCostRequest(oldOwner.id, fixer.id);

    await db.update(stores).set({ ownerId: newOwner.id }).where(eq(stores.id, store.id));

    const res = await request(app)
      .post(`/api/requests/${requestId}/stock-decision`)
      .set("x-test-user", newOwner.id)
      .send({ decision: "approve" });
    expect(res.status).toBe(200);

    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(9000); // 10000 - (500 * 2)
    expect(await db.select().from(storeStock).where(eq(storeStock.storeId, store.id))).toHaveLength(1);
    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, requestId));
    expect(row.status).toBe("approved");
  });

  it("404s if the venue was deleted before the decision", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { store, requestId } = await makeStockCostRequest(owner.id, fixer.id);

    await db.delete(stores).where(eq(stores.id, store.id));

    const res = await request(app)
      .post(`/api/requests/${requestId}/stock-decision`)
      .set("x-test-user", owner.id)
      .send({ decision: "approve" });
    expect(res.status).toBe(404);
  });
});
