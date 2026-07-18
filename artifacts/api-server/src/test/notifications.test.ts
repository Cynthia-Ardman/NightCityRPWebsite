import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, notifications } from "@workspace/db";
import { buildTestApp } from "./app";
import { createUser } from "./testDb";
import { createNotification } from "../lib/notifications";

const app = buildTestApp();

async function seed(userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(notifications).values({
      userId,
      type: "test",
      title: `Notification ${i + 1}`,
      body: i % 2 === 0 ? `body ${i + 1}` : null,
      href: "/submissions",
    });
  }
}

describe("notifications API", () => {
  it("requires auth", async () => {
    expect((await request(app).get("/api/notifications")).status).toBe(401);
    expect((await request(app).get("/api/notifications/unread-count")).status).toBe(401);
    expect((await request(app).post("/api/notifications/mark-read")).status).toBe(401);
  });

  it("lists only the caller's notifications, newest first, with pagination", async () => {
    const u = await createUser();
    const other = await createUser();
    await seed(u.id, 25);
    await seed(other.id, 3);

    const res = await request(app).get("/api/notifications?limit=20").set("x-test-user", u.id);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(20);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.items[0].title).toBe("Notification 25");
    expect(res.body.nextCursor).toBeTypeOf("number");

    const page2 = await request(app)
      .get(`/api/notifications?limit=20&before=${res.body.nextCursor}`)
      .set("x-test-user", u.id);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(5);
    expect(page2.body.hasMore).toBe(false);
    // No cross-user leakage.
    for (const item of [...res.body.items, ...page2.body.items]) {
      expect(item.title).toMatch(/^Notification/);
    }
  });

  it("unread-count and mark-read (ids + all) are caller-scoped", async () => {
    const u = await createUser();
    const other = await createUser();
    await seed(u.id, 3);
    await seed(other.id, 2);

    const count = await request(app).get("/api/notifications/unread-count").set("x-test-user", u.id);
    expect(count.body.count).toBe(3);

    const list = await request(app).get("/api/notifications").set("x-test-user", u.id);
    const firstId = list.body.items[0].id as number;
    const otherList = await request(app).get("/api/notifications").set("x-test-user", other.id);
    const otherId = otherList.body.items[0].id as number;

    // Marking my id + someone else's id only touches mine.
    const marked = await request(app)
      .post("/api/notifications/mark-read")
      .set("x-test-user", u.id)
      .send({ ids: [firstId, otherId] });
    expect(marked.body.updated).toBe(1);

    const after = await request(app).get("/api/notifications/unread-count").set("x-test-user", u.id);
    expect(after.body.count).toBe(2);
    const otherCount = await request(app).get("/api/notifications/unread-count").set("x-test-user", other.id);
    expect(otherCount.body.count).toBe(2);

    // all:true clears the rest, and is idempotent.
    const all = await request(app)
      .post("/api/notifications/mark-read")
      .set("x-test-user", u.id)
      .send({ all: true });
    expect(all.body.updated).toBe(2);
    const again = await request(app)
      .post("/api/notifications/mark-read")
      .set("x-test-user", u.id)
      .send({ all: true });
    expect(again.body.updated).toBe(0);
  });

  it("createNotification writes a row and never throws on bad input", async () => {
    const u = await createUser();
    await createNotification({
      userId: u.id,
      type: "request_decision",
      title: "Approved: test",
      body: null,
      href: "/submissions",
    });
    const res = await request(app).get("/api/notifications").set("x-test-user", u.id);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].type).toBe("request_decision");
    expect(res.body.items[0].readAt).toBeNull();

    // Nonexistent user violates the FK — must swallow, not throw.
    await expect(
      createNotification({ userId: "no-such-user", type: "x", title: "y" }),
    ).resolves.toBeUndefined();
  });
});
