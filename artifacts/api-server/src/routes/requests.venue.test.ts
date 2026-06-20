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

import { db, customRequests, stores, ripperdocs, housing, inventoryItems, auditLog, catalogGuns, storeStock, catalogRent } from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-id");
});

// Test reviewers hold the cs-approver role (the approver pool that casts counted
// votes — only CS_APPROVERs are eligible) plus the fixer role for staff-view
// paths.
function createFixer() {
  return createUser({ roles: ["fixer", "cs approver"] });
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

  it("a repeat approve by the same voter toggles their vote off and reverts to pending; nothing materializes before close", async () => {
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
    expect(first.body.status).toBe("approved");

    // Voting stays open on a staged (approved) ticket: re-casting the same vote
    // toggles it off, dropping the tally below majority and walking the ticket
    // back to pending. No 409 — but still no double-apply (effects are deferred).
    const second = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("pending");

    // Still deferred — nothing materialized at any point.
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

// Staff associate a store/ripperdoc with an existing business lease from the
// venue management page (PATCH housingId). The association validates the lease
// is kind="business", pins the venue location to the lease address, and is
// listed via GET /business-leases. A null housingId clears it.
describe("Venue ↔ lease association (staff)", () => {
  async function createBusinessLease(args: { characterId: number; address: string; monthlyRent?: number }) {
    const [row] = await db
      .insert(housing)
      .values({
        characterId: args.characterId,
        address: args.address,
        monthlyRent: args.monthlyRent ?? 1500,
        kind: "business",
      })
      .returning();
    return row;
  }

  async function createStore(ownerId: string, characterId: number) {
    const [row] = await db
      .insert(stores)
      .values({ ownerId, ownerCharacterId: characterId, name: "Test Shop", location: "Old Address" })
      .returning();
    return row;
  }

  it("GET /business-leases lists business leases for staff and 403s players", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const lease = await createBusinessLease({ characterId: char.id, address: "Watson Plaza 12" });

    const denied = await request(app).get("/api/business-leases").set("x-test-user", owner.id);
    expect(denied.status).toBe(403);

    const res = await request(app).get("/api/business-leases").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number; address: string }>).map((l) => l.id);
    expect(ids).toContain(lease.id);
  });

  it("associates a store with a business lease and pins its location", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const lease = await createBusinessLease({ characterId: char.id, address: "Kabuki Market 7" });
    const store = await createStore(owner.id, char.id);

    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id)
      .send({ housingId: lease.id });
    expect(res.status).toBe(200);

    const [updated] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(updated.housingId).toBe(lease.id);
    expect(updated.location).toBe("Kabuki Market 7");

    expect(res.body.lease).toBeTruthy();
    expect(res.body.lease.id).toBe(lease.id);
  });

  it("clears a store's lease association with null housingId", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const lease = await createBusinessLease({ characterId: char.id, address: "Heywood Row 3" });
    const store = await createStore(owner.id, char.id);

    await request(app).patch(`/api/stores/${store.id}`).set("x-test-user", fixer.id).send({ housingId: lease.id });
    const clear = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id)
      .send({ housingId: null });
    expect(clear.status).toBe(200);

    const [updated] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(updated.housingId).toBeNull();
    // Location is left intact when clearing.
    expect(updated.location).toBe("Heywood Row 3");
  });

  it("400s when the housingId is not a business lease", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const [residential] = await db
      .insert(housing)
      .values({ characterId: char.id, address: "Home Sweet Home", monthlyRent: 800, kind: "residential" })
      .returning();
    const store = await createStore(owner.id, char.id);

    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id)
      .send({ housingId: residential.id });
    expect(res.status).toBe(400);

    const [unchanged] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(unchanged.housingId).toBeNull();
  });

  it("ignores housingId from a non-staff caller (association is staff-only)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const lease = await createBusinessLease({ characterId: char.id, address: "Santo Domingo 5" });
    const store = await createStore(owner.id, char.id);

    // The owner may PATCH their own store, but housingId is not in their
    // allowed field set — it is silently stripped, so no association happens.
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", owner.id)
      .send({ housingId: lease.id });
    expect(res.status).toBe(200);

    const [unchanged] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(unchanged.housingId).toBeNull();
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

  it("materializes a housing lease on close, using params supplied at close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, reqId } = await submit(owner.id, "property");
    const vote = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", fixer.id)
      .send({ vote: "approve" });
    expect(vote.status).toBe(200);
    expect(await db.select().from(housing)).toHaveLength(0);

    const res = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ monthlyRent: 1500, district: "Watson", tier: "T2" });
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^housing:\d+$/);
    const leases = await db.select().from(housing);
    expect(leases).toHaveLength(1);
    expect(leases[0].characterId).toBe(char.id);
    expect(leases[0].monthlyRent).toBe(1500);
    // District + tier (fixer-decided at close) persist on the off-map lease.
    expect(leases[0].district).toBe("Watson");
    expect(leases[0].tier).toBe("T2");
  });

  it("400s closing a property request without district/tier, and creates no lease", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submit(owner.id, "property");
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ monthlyRent: 1500 });
    expect(close.status).toBe(400);
    expect(close.body.error).toMatch(/district/i);
    expect(await db.select().from(housing)).toHaveLength(0);
  });

  it("materializes a gun inventory item on close, packing the fixer-decided classification into notes", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, reqId } = await submit(owner.id, "gun");
    const vote = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(vote.status).toBe(200);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const res = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "M", manufacturer: "Militech" });
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^inventory:/);
    const items = await db.select().from(inventoryItems);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("gun");
    expect(items[0].characterId).toBe(char.id);
    expect(items[0].ownerId).toBe(owner.id);
    // Mechanical classification packed with the staff editor's " · " convention.
    expect(items[0].notes).toMatch(/Manufacturer: Militech/);
    expect(items[0].notes).toMatch(/Category: Power/);
    expect(items[0].notes).toMatch(/Type: Pistol/);
    expect(items[0].notes).toMatch(/Fire: Semi-Auto/);
    expect(items[0].notes).toMatch(/Power: M/);
  });

  it("400s closing a gun request without its classification, and creates no inventory item", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submit(owner.id, "gun");
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ category: "Power" });
    expect(close.status).toBe(400);
    expect(close.body.error).toMatch(/weaponType/i);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });

  it("materializes a cyberware inventory item with a CWP + slot token on close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, reqId } = await submit(owner.id, "cyberware");
    const vote = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(vote.status).toBe(200);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const res = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ cwp: 4, slot: "Neural" });
    expect(res.status).toBe(200);
    expect(res.body.appliedRef).toMatch(/^inventory:/);
    const items = await db.select().from(inventoryItems);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("cyberware");
    expect(items[0].characterId).toBe(char.id);
    expect(items[0].notes).toMatch(/CWP 4/);
    // Slot (fixer-decided) appended in the parseable "· slot: <x>" form.
    expect(items[0].notes).toMatch(/slot: Neural/);
  });

  it("400s closing a cyberware request without a slot, and creates no inventory item", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submit(owner.id, "cyberware");
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ cwp: 4 });
    expect(close.status).toBe(400);
    expect(close.body.error).toMatch(/slot/i);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });
});

describe("close param-bypass guard (params now entered at close)", () => {
  async function submitApproved(ownerId: string, fixerId: string, type: string) {
    const char = await createCharacter({ ownerId });
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", ownerId)
      .send({ type, characterId: char.id, title: `${type} item`, description: "desc" });
    const reqId = submit.body.id as number;
    const vote = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", fixerId)
      .send({ vote: "approve" });
    expect(vote.status).toBe(200);
    return { char, reqId };
  }

  it("400s closing an approved property request with no params, and creates no lease", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submitApproved(owner.id, fixer.id, "property");

    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(close.status).toBe(400);
    expect(close.body.error).toMatch(/monthlyRent/i);
    expect(await db.select().from(housing)).toHaveLength(0);

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("approved");
    expect(row.appliedRef).toBeNull();
  });

  it("400s closing an approved cyberware request with no params, and creates no inventory item", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submitApproved(owner.id, fixer.id, "cyberware");

    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(close.status).toBe(400);
    expect(close.body.error).toMatch(/cwp/i);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("approved");
    expect(row.appliedRef).toBeNull();
  });
});

describe("POST /requests/:id/vote reject (venue)", () => {
  it("records the reviewer note, creates no venue, and defers the player DM to close", async () => {
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

    // Reaching the reject threshold no longer instantly notifies the player —
    // staff can still reopen / change votes. The DM fires only at close, with
    // the optional closing message taking priority over the vote note.
    expect(mockDm).not.toHaveBeenCalled();

    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", fixer.id)
      .send({ note: "Try a spot further from the competition." });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(mockDm).toHaveBeenCalledTimes(1);
    const dmBody = mockDm.mock.calls[0][1] as string;
    expect(dmBody).toContain("rejected");
    expect(dmBody).toContain("Try a spot further from the competition.");
  });
});

describe("On-map venue requests (building reservation)", () => {
  async function makeBusinessBuilding(name = "Watson Tower", rent = 2500) {
    const [b] = await db
      .insert(catalogRent)
      .values({ name, district: "Watson", tier: "Tier 2", monthlyRent: rent, kind: "business" })
      .returning();
    return b;
  }

  it("lists only unleased, unreserved business buildings", async () => {
    const owner = await createUser();
    const free = await makeBusinessBuilding("Free Tower");
    const residential = await db
      .insert(catalogRent)
      .values({ name: "Apt 1A", district: "Watson", monthlyRent: 800, kind: "residential" })
      .returning();
    const res = await request(app)
      .get("/api/catalog/rent/available-business")
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((b) => b.id);
    expect(ids).toContain(free.id);
    expect(ids).not.toContain(residential[0].id);
  });

  it("rejects an on-map submit for a non-business building", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const [res] = await db
      .insert(catalogRent)
      .values({ name: "Flat", district: "Watson", monthlyRent: 800, kind: "residential" })
      .returning();
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Shop", purpose: "Goods", description: "desc", locationKind: "on_map", listingId: res.id });
    expect(submit.status).toBe(400);
  });

  it("reserves the building on submit and excludes it from availability", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const building = await makeBusinessBuilding();
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Shop", purpose: "Goods", description: "A store.", locationKind: "on_map", listingId: building.id });
    expect(submit.status).toBe(201);
    expect(submit.body.details).toMatchObject({ locationKind: "on_map", listingId: building.id });

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, submit.body.id));
    expect(row.reservedListingId).toBe(building.id);

    // No longer offered to anyone else.
    const avail = await request(app).get("/api/catalog/rent/available-business").set("x-test-user", owner.id);
    expect((avail.body as { id: number }[]).map((b) => b.id)).not.toContain(building.id);

    // And marked occupied in the catalog.
    const cat = await request(app).get("/api/catalog/rent").set("x-test-user", owner.id);
    const catRow = (cat.body as { id: number; occupied: boolean }[]).find((l) => l.id === building.id);
    expect(catRow?.occupied).toBe(true);
  });

  it("409s a second on-map submit for an already-reserved building", async () => {
    const owner = await createUser();
    const other = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const char2 = await createCharacter({ ownerId: other.id });
    const building = await makeBusinessBuilding();
    const first = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Shop", purpose: "Goods", description: "A store.", locationKind: "on_map", listingId: building.id });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/requests")
      .set("x-test-user", other.id)
      .send({ type: "ripperdoc", characterId: char2.id, title: "Clinic", purpose: "Health", description: "A clinic.", locationKind: "on_map", listingId: building.id });
    expect(second.status).toBe(409);
  });

  it("commits a business lease and pins the venue location on close", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const building = await makeBusinessBuilding("Northside Plaza", 3200);
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Plaza Goods", purpose: "Goods", description: "A store.", locationKind: "on_map", listingId: building.id });
    const reqId = submit.body.id as number;

    const vote = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "approve" });
    expect(vote.status).toBe(200);
    // No lease yet — staged until close.
    expect(await db.select().from(housing)).toHaveLength(0);

    const close = await request(app).post(`/api/review/request/${reqId}/close`).set("x-test-user", fixer.id).send({});
    expect(close.status).toBe(200);
    expect(close.body.appliedRef).toMatch(/^store:\d+$/);

    const leases = await db.select().from(housing);
    expect(leases).toHaveLength(1);
    expect(leases[0].characterId).toBe(char.id);
    expect(leases[0].listingId).toBe(building.id);
    expect(leases[0].kind).toBe("business");
    expect(leases[0].monthlyRent).toBe(3200);

    const [store] = await db.select().from(stores);
    expect(store.location).toBe("Northside Plaza — Watson");
  });

  it("frees the reservation when the request is rejected", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });
    const building = await makeBusinessBuilding();
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Shop", purpose: "Goods", description: "A store.", locationKind: "on_map", listingId: building.id });
    const reqId = submit.body.id as number;

    const reject = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", fixer.id).send({ vote: "reject", note: "no" });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");

    // Building is available again and no lease was created.
    const avail = await request(app).get("/api/catalog/rent/available-business").set("x-test-user", owner.id);
    expect((avail.body as { id: number }[]).map((b) => b.id)).toContain(building.id);
    expect(await db.select().from(housing)).toHaveLength(0);
  });

  it("rejects an on-map submit for an already-leased building", async () => {
    const owner = await createUser();
    const tenant = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const tenantChar = await createCharacter({ ownerId: tenant.id, approved: true });
    const building = await makeBusinessBuilding();
    const admin = await createAdmin();
    const lease = await request(app)
      .post("/api/housing/lease")
      .set("x-test-user", admin.id)
      .send({ catalogRentId: building.id, characterId: tenantChar.id });
    expect(lease.status).toBe(201);

    const avail = await request(app).get("/api/catalog/rent/available-business").set("x-test-user", owner.id);
    expect((avail.body as { id: number }[]).map((b) => b.id)).not.toContain(building.id);

    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Shop", purpose: "Goods", description: "A store.", locationKind: "on_map", listingId: building.id });
    expect(submit.status).toBe(409);
  });

  it("blocks a self-lease of a reserved building", async () => {
    const owner = await createUser();
    const other = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const char2 = await createCharacter({ ownerId: other.id, approved: true });
    const building = await makeBusinessBuilding();
    const submit = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Shop", purpose: "Goods", description: "A store.", locationKind: "on_map", listingId: building.id });
    expect(submit.status).toBe(201);

    // A staff lease attempt on the reserved building is rejected as occupied.
    const admin = await createAdmin();
    const lease = await request(app)
      .post("/api/housing/lease")
      .set("x-test-user", admin.id)
      .send({ catalogRentId: building.id, characterId: char2.id });
    expect(lease.status).toBe(409);
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
