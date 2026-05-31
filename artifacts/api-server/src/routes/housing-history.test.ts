import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, catalogRent } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

// The Property Catalog history endpoint exposes a listing's tenant, rent ledger
// and occupancy timeline — a staff-only view. These tests lock the gate so a
// future change can't silently expose it to players or 500 on a missing row.
const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

async function createListing(opts: { name?: string } = {}) {
  const [row] = await db
    .insert(catalogRent)
    .values({
      name: opts.name ?? "Megabuilding H10 #42",
      district: "Watson",
      tier: "Housing Tier 2",
      monthlyRent: 1500,
      kind: "residential",
    })
    .returning();
  return row;
}

describe("GET /housing/listings/:id/history (staff-only)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const listing = await createListing();
    const res = await request(app).get(`/api/housing/listings/${listing.id}/history`);
    expect(res.status).toBe(401);
  });

  it("forbids non-staff callers with 403", async () => {
    const player = await createUser();
    const listing = await createListing();
    const res = await request(app)
      .get(`/api/housing/listings/${listing.id}/history`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(403);
  });

  it("allows fixers and admins with 200", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();
    const listing = await createListing();

    const fr = await request(app)
      .get(`/api/housing/listings/${listing.id}/history`)
      .set("x-test-user", fixer.id);
    const ar = await request(app)
      .get(`/api/housing/listings/${listing.id}/history`)
      .set("x-test-user", admin.id);

    expect(fr.status).toBe(200);
    expect(ar.status).toBe(200);
    expect(fr.body.listing.id).toBe(listing.id);
    expect(fr.body.listing.name).toBe(listing.name);
    // Vacant listing: shape is present even with no tenant/payments/timeline.
    expect(fr.body.currentTenant).toBeNull();
    expect(Array.isArray(fr.body.payments)).toBe(true);
    expect(Array.isArray(fr.body.timeline)).toBe(true);
  });

  it("returns 404 for a missing listing (staff caller)", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/housing/listings/999999/history")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing listing even for a fixer", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .get("/api/housing/listings/999999/history")
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(404);
  });

  it("rejects a missing listing for a non-staff caller as 403 (gate before lookup)", async () => {
    // Authorization is checked before the listing lookup, so a player probing a
    // non-existent id must not learn whether it exists.
    const player = await createUser();
    const res = await request(app)
      .get("/api/housing/listings/999999/history")
      .set("x-test-user", player.id);
    expect(res.status).toBe(403);
  });
});
