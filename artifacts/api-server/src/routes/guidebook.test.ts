import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, guidebookPages, guidebookPendingEdits } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

// Discord DMs are best-effort side effects on approve/reject; stub them so the
// review pipeline can be exercised without a bot token.
vi.mock("../lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/discord")>();
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

const app = buildTestApp();

async function makePage(section = "rules", title = "House Rules") {
  const [p] = await db
    .insert(guidebookPages)
    .values({ section, title, slug: title.toLowerCase().replace(/\s+/g, "-"), body: "Be cool." })
    .returning();
  return p;
}

describe("GET /guidebook", () => {
  it("anonymous callers only see publicRead pages", async () => {
    await makePage("rules", "Members Only Rules");
    const [pub] = await db
      .insert(guidebookPages)
      .values({ section: "rules", title: "Public Rules", slug: "public-rules", body: "Be cool.", publicRead: true })
      .returning();

    const res = await request(app).get("/api/guidebook");
    expect(res.status).toBe(200);
    const titles = res.body.sections.flatMap((s: { pages: Array<{ title: string }> }) =>
      s.pages.map((p) => p.title),
    );
    expect(titles).toContain("Public Rules");
    expect(titles).not.toContain("Members Only Rules");

    // Detail: public page readable, non-public 404s for anonymous callers.
    const detail = await request(app).get(`/api/guidebook/${pub.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.publicRead).toBe(true);
    const [priv] = await db.select().from(guidebookPages).where(eq(guidebookPages.title, "Members Only Rules"));
    const hidden = await request(app).get(`/api/guidebook/${priv.id}`);
    expect(hidden.status).toBe(404);
  });

  it("admins can toggle publicRead without marking the page edited-since-import", async () => {
    const admin = await createAdmin();
    const page = await makePage("rules", "Toggle Me");
    const res = await request(app)
      .patch(`/api/guidebook/${page.id}`)
      .set("x-test-user", admin.id)
      .send({ publicRead: true, title: page.title, body: page.body });
    expect(res.status).toBe(200);
    expect(res.body.publicRead).toBe(true);
    const [row] = await db.select().from(guidebookPages).where(eq(guidebookPages.id, page.id));
    expect(row.publicRead).toBe(true);
    // Re-sent-but-unchanged content fields must not flip editedSinceImport.
    expect(row.editedSinceImport).toBe(false);

    // A real content change still flips it.
    await request(app)
      .patch(`/api/guidebook/${page.id}`)
      .set("x-test-user", admin.id)
      .send({ body: "Changed body." });
    const [after] = await db.select().from(guidebookPages).where(eq(guidebookPages.id, page.id));
    expect(after.editedSinceImport).toBe(true);
  });

  it("returns the fixed section catalogue with pages grouped in", async () => {
    const user = await createUser();
    await makePage("rules", "House Rules");
    const res = await request(app).get("/api/guidebook").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    const rules = res.body.sections.find((s: { key: string }) => s.key === "rules");
    expect(rules).toBeTruthy();
    expect(rules.pages.map((p: { title: string }) => p.title)).toContain("House Rules");
  });

  it("hides staff-only fields (discordChannelId) from non-staff", async () => {
    const user = await createUser();
    await db
      .insert(guidebookPages)
      .values({ section: "rules", title: "Secret", slug: "secret", body: "x", discordChannelId: "12345" });
    const res = await request(app).get("/api/guidebook").set("x-test-user", user.id);
    const page = res.body.sections
      .flatMap((s: { pages: Array<{ title: string; discordChannelId: string | null }> }) => s.pages)
      .find((p: { title: string }) => p.title === "Secret");
    expect(page.discordChannelId).toBeNull();
  });
});

describe("fixer-proposed guidebook edits", () => {
  it("gates the proposal endpoints behind fixer/admin", async () => {
    const player = await createUser();
    const list = await request(app).get("/api/guidebook/edits").set("x-test-user", player.id);
    expect(list.status).toBe(403);
    const propose = await request(app)
      .post("/api/guidebook/edits")
      .set("x-test-user", player.id)
      .send({ kind: "create", diff: { section: "start_here", title: "Q" } });
    expect(propose.status).toBe(403);
  });

  it("lets a fixer submit a create proposal and requires title+section", async () => {
    const fixer = await createUser({ roles: ["fixer"] });

    const bad = await request(app)
      .post("/api/guidebook/edits")
      .set("x-test-user", fixer.id)
      .send({ kind: "create", diff: { body: "no title" } });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post("/api/guidebook/edits")
      .set("x-test-user", fixer.id)
      .send({ kind: "create", diff: { section: "start_here", title: "How do I play?", body: "Join." } });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("pending");
  });

  it("only an admin can approve, which materializes the page and marks it approved", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const admin = await createAdmin();

    const proposal = await request(app)
      .post("/api/guidebook/edits")
      .set("x-test-user", fixer.id)
      .send({ kind: "create", diff: { section: "start_here", title: "Approved Page", body: "Hi." } });
    const editId = proposal.body.id;

    const denied = await request(app)
      .post(`/api/guidebook/edits/${editId}/approve`)
      .set("x-test-user", fixer.id);
    expect(denied.status).toBe(403);

    const approved = await request(app)
      .post(`/api/guidebook/edits/${editId}/approve`)
      .set("x-test-user", admin.id);
    expect(approved.status).toBe(200);

    const [edit] = await db
      .select()
      .from(guidebookPendingEdits)
      .where(eq(guidebookPendingEdits.id, editId));
    expect(edit.status).toBe("approved");
    const pages = await db
      .select()
      .from(guidebookPages)
      .where(eq(guidebookPages.title, "Approved Page"));
    expect(pages).toHaveLength(1);
  });

  it("409s when approving an already-decided proposal", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const admin = await createAdmin();
    const proposal = await request(app)
      .post("/api/guidebook/edits")
      .set("x-test-user", fixer.id)
      .send({ kind: "create", diff: { section: "start_here", title: "Twice", body: "x" } });
    const editId = proposal.body.id;

    await request(app).post(`/api/guidebook/edits/${editId}/reject`).set("x-test-user", admin.id);
    const again = await request(app)
      .post(`/api/guidebook/edits/${editId}/approve`)
      .set("x-test-user", admin.id);
    expect(again.status).toBe(409);
  });
});
