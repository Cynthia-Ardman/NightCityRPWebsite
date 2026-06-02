import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, loreEntries, lorePendingEdits, loreImportDrafts } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

// Best-effort fixer DMs on approve/reject must never reach the real Discord API
// in tests; stub the sender so decisions resolve without network.
vi.mock("../lib/discord", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

async function seedEntry(overrides: Partial<typeof loreEntries.$inferInsert> = {}) {
  const [e] = await db
    .insert(loreEntries)
    .values({
      category: "corporation",
      name: "Arasaka",
      slug: `arasaka-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      publicBody: "A megacorporation.",
      fixerBody: "Secret: the board answers to Saburo's ghost.",
      sources: [{ label: "Lore Bible", url: "https://example.com/arasaka" }] as never,
      ...overrides,
    })
    .returning();
  return e;
}

describe("GET /directory/lore/:id (fixer-only content gating)", () => {
  it("hides fixerBody and sources from a non-staff player", async () => {
    const player = await createUser();
    const entry = await seedEntry();

    const res = await request(app)
      .get(`/api/directory/lore/${entry.id}`)
      .set("x-test-user", player.id);

    expect(res.status).toBe(200);
    expect(res.body.publicBody).toBe("A megacorporation.");
    // The sensitive fields must never reach a non-staff caller.
    expect(res.body.fixerBody).toBeNull();
    expect(res.body.sources).toEqual([]);
    expect(res.body.canViewFixer).toBe(false);
    // But the player can still SEE that restricted content exists.
    expect(res.body.hasFixerContent).toBe(true);
  });

  it("returns full fixerBody and sources to a fixer", async () => {
    const fixer = await createFixer();
    const entry = await seedEntry();

    const res = await request(app)
      .get(`/api/directory/lore/${entry.id}`)
      .set("x-test-user", fixer.id);

    expect(res.status).toBe(200);
    expect(res.body.fixerBody).toBe("Secret: the board answers to Saburo's ghost.");
    expect(res.body.sources).toEqual([{ label: "Lore Bible", url: "https://example.com/arasaka" }]);
    expect(res.body.canViewFixer).toBe(true);
  });

  it("returns full fixerBody and sources to an admin", async () => {
    const admin = await createAdmin();
    const entry = await seedEntry();

    const res = await request(app)
      .get(`/api/directory/lore/${entry.id}`)
      .set("x-test-user", admin.id);

    expect(res.status).toBe(200);
    expect(res.body.fixerBody).toBe("Secret: the board answers to Saburo's ghost.");
    expect(res.body.sources.length).toBe(1);
    expect(res.body.canViewFixer).toBe(true);
  });
});

describe("Fixer proposals create pending edits, not live entries", () => {
  it("a fixer create-proposal stages a pending edit and publishes nothing", async () => {
    const fixer = await createFixer();

    const res = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "create",
        diff: {
          category: "gang",
          name: "Maelstrom",
          publicBody: "Chrome-obsessed gang.",
          fixerBody: "Leadership rotates after every cyberpsycho incident.",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.kind).toBe("create");

    // Nothing is live yet.
    const live = await db.select().from(loreEntries).where(eq(loreEntries.name, "Maelstrom"));
    expect(live.length).toBe(0);

    // The pending edit row exists and is owned by the fixer.
    const pending = await db
      .select()
      .from(lorePendingEdits)
      .where(eq(lorePendingEdits.id, res.body.id));
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].submittedBy).toBe(fixer.id);
  });

  it("forbids a non-staff player from proposing edits", async () => {
    const player = await createUser();
    const res = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", player.id)
      .send({ kind: "create", diff: { category: "gang", name: "Nope" } });
    expect(res.status).toBe(403);
  });

  it("a fixer edit-proposal snapshots the targeted fields without touching the live entry", async () => {
    const fixer = await createFixer();
    const entry = await seedEntry({ name: "Militech", publicBody: "Arms manufacturer." });

    const res = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "edit",
        loreEntryId: entry.id,
        diff: { publicBody: "The largest arms manufacturer in the world." },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.beforeSnapshot).toMatchObject({ publicBody: "Arms manufacturer." });

    // The live entry is unchanged until an admin approves.
    const [stillLive] = await db.select().from(loreEntries).where(eq(loreEntries.id, entry.id));
    expect(stillLive.publicBody).toBe("Arms manufacturer.");
  });
});

describe("Admin approval publishes a pending edit", () => {
  it("forbids a fixer from approving (admin-only)", async () => {
    const fixer = await createFixer();
    const proposal = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({ kind: "create", diff: { category: "faction", name: "NCPD" } });
    expect(proposal.status).toBe(201);

    const res = await request(app)
      .post(`/api/directory/lore/edits/${proposal.body.id}/approve`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(403);

    // Still pending, still no live entry.
    const [row] = await db
      .select()
      .from(lorePendingEdits)
      .where(eq(lorePendingEdits.id, proposal.body.id));
    expect(row.status).toBe("pending");
    const live = await db.select().from(loreEntries).where(eq(loreEntries.name, "NCPD"));
    expect(live.length).toBe(0);
  });

  it("admin approve of a create-proposal publishes a live entry", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();

    const proposal = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "create",
        diff: {
          category: "gang",
          name: "Tyger Claws",
          publicBody: "A gang operating out of Japantown.",
          fixerBody: "Pay protection to the Arasaka remnant.",
        },
      });
    expect(proposal.status).toBe(201);

    const res = await request(app)
      .post(`/api/directory/lore/edits/${proposal.body.id}/approve`)
      .set("x-test-user", admin.id)
      .send({ decisionSummary: "Looks good." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.appliedEntryId).toBeTruthy();

    // The proposal is now approved.
    const [edit] = await db
      .select()
      .from(lorePendingEdits)
      .where(eq(lorePendingEdits.id, proposal.body.id));
    expect(edit.status).toBe("approved");
    expect(edit.decidedById).toBe(admin.id);

    // A live entry now exists with the proposed content.
    const [live] = await db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.id, res.body.appliedEntryId));
    expect(live).toBeTruthy();
    expect(live.name).toBe("Tyger Claws");
    expect(live.category).toBe("gang");
    expect(live.publicBody).toBe("A gang operating out of Japantown.");
    expect(live.fixerBody).toBe("Pay protection to the Arasaka remnant.");
  });

  it("round-trips imageUrl through a create-proposal approval and GET", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();
    const img = "/api/storage/objects/lore-arasaka-tower.png";

    const proposal = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "create",
        diff: {
          category: "corporation",
          name: "Biotechnica",
          publicBody: "Agricultural megacorp.",
          imageUrl: img,
        },
      });
    expect(proposal.status).toBe(201);

    const res = await request(app)
      .post(`/api/directory/lore/edits/${proposal.body.id}/approve`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);

    const [live] = await db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.id, res.body.appliedEntryId));
    expect(live.imageUrl).toBe(img);

    // And it is exposed back through the read API.
    const get = await request(app)
      .get(`/api/directory/lore/${res.body.appliedEntryId}`)
      .set("x-test-user", fixer.id);
    expect(get.status).toBe(200);
    expect(get.body.imageUrl).toBe(img);
  });

  it("carries imageUrl through an import-draft create approval", async () => {
    const admin = await createAdmin();
    const img = "/api/storage/objects/lore-import-night-corp.png";
    const [draft] = await db
      .insert(loreImportDrafts)
      .values({
        groupKey: `nightcorp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        proposedName: "Night Corp",
        proposedCategory: "corporation",
        publicBody: "An imported megacorp.",
        imageUrl: img,
      })
      .returning();

    const res = await request(app)
      .post(`/api/directory/lore/import/drafts/${draft.id}/approve`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBe(img);

    const [live] = await db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.id, res.body.id));
    expect(live.imageUrl).toBe(img);
  });

  it("admin approve of an edit-proposal applies the diff to the existing entry", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();
    const entry = await seedEntry({ name: "Kang Tao", publicBody: "Smart-weapon corp." });

    const proposal = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "edit",
        loreEntryId: entry.id,
        diff: { publicBody: "A Chinese smart-weapon manufacturer." },
      });
    expect(proposal.status).toBe(201);

    const res = await request(app)
      .post(`/api/directory/lore/edits/${proposal.body.id}/approve`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);

    const [updated] = await db.select().from(loreEntries).where(eq(loreEntries.id, entry.id));
    expect(updated.publicBody).toBe("A Chinese smart-weapon manufacturer.");
  });

  it("rejecting a pending edit leaves nothing live and a double-decision 409s", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();

    const proposal = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({ kind: "create", diff: { category: "misc", name: "Rumor Mill" } });
    expect(proposal.status).toBe(201);

    const reject = await request(app)
      .post(`/api/directory/lore/edits/${proposal.body.id}/reject`)
      .set("x-test-user", admin.id)
      .send({ decisionSummary: "Not canon." });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");

    const live = await db.select().from(loreEntries).where(eq(loreEntries.name, "Rumor Mill"));
    expect(live.length).toBe(0);

    // A subsequent approve of the already-decided proposal must conflict.
    const late = await request(app)
      .post(`/api/directory/lore/edits/${proposal.body.id}/approve`)
      .set("x-test-user", admin.id)
      .send({});
    expect(late.status).toBe(409);
  });
});
