import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";

// Currency provider is fully mocked: no test hits the real UB API.
vi.mock("../lib/unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));
// Discord network calls stubbed; role helpers stay real.
vi.mock("../lib/discord", async (orig) => {
  const actual = await orig<typeof import("../lib/discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn().mockResolvedValue("dm-id"),
    postToChannel: vi.fn().mockResolvedValue("msg-id"),
    createGuildScheduledEvent: vi.fn(async () => ({ ok: true, id: "evt-1" })),
    modifyGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
    deleteGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
  };
});

import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";
import { db, botConfig, users, walletTransactions, eventCheckinStaff } from "@workspace/db";
import { patchBalance } from "../lib/unbelievaboat";

const app = buildTestApp();
const mockPatch = vi.mocked(patchBalance);

const future = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3600_000).toISOString();

async function setFlag(key: string, value: boolean): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: String(value) } });
}

async function enableEconomy(): Promise<void> {
  await setFlag("economy_enabled", true);
  await setFlag("master_live_mode", true);
  await setFlag("economy_live_mode", true);
}

async function seedWallet(userId: string, balance: number): Promise<void> {
  await db.update(users).set({ walletBalance: balance, lastSyncedUbBalance: balance }).where(eq(users.id, userId));
}

async function createTicketedEvent(
  actorId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ eventId: number; typeId: number }> {
  const res = await request(app)
    .post("/api/events")
    .set("x-test-user", actorId)
    .send({
      title: "Afterlife Rave",
      startAt: future(24),
      endAt: future(28),
      ticketTypes: [{ name: "GA", price: 100, quantity: 2 }],
      ...overrides,
    });
  expect(res.status).toBe(201);
  const types = res.body.ticketTypes as Array<{ id: number }>;
  expect(types?.length).toBeGreaterThan(0);
  return { eventId: res.body.id as number, typeId: types[0].id };
}

beforeEach(() => {
  mockPatch.mockReset();
  mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
});

describe("event tickets — purchase", () => {
  it("debits the buyer and credits the runner (event creator by default), exactly once per leg", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const buyer = await createUser();
    await seedWallet(buyer.id, 500);
    await seedWallet(admin.id, 0);
    const { eventId, typeId } = await createTicketedEvent(admin.id);

    const res = await request(app)
      .post(`/api/events/${eventId}/tickets`)
      .set("x-test-user", buyer.id)
      .send({ ticketTypeId: typeId });
    expect(res.status).toBe(201);
    expect(res.body.walletStatus).toBe("synced");
    expect(res.body.ticket).toMatchObject({ status: "purchased", pricePaid: 100, payoutStatus: "paid" });

    const [b] = await db.select().from(users).where(eq(users.id, buyer.id));
    const [r] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(b.walletBalance).toBe(400);
    expect(r.walletBalance).toBe(100);

    const ticketId = res.body.ticket.id as number;
    const debit = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `event-ticket:${ticketId}:debit`));
    const credit = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `event-ticket:${ticketId}:credit`));
    expect(debit).toHaveLength(1);
    expect(credit).toHaveLength(1);
  });

  it("rejects an overdraw with 400 and frees the capacity slot", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const poor = await createUser();
    await seedWallet(poor.id, 10);
    const { eventId, typeId } = await createTicketedEvent(admin.id);

    const res = await request(app)
      .post(`/api/events/${eventId}/tickets`)
      .set("x-test-user", poor.id)
      .send({ ticketTypeId: typeId });
    expect(res.status).toBe(400);

    // Capacity was not consumed: a funded buyer can still buy both.
    const rich = await createUser();
    await seedWallet(rich.id, 1000);
    const a = await request(app).post(`/api/events/${eventId}/tickets`).set("x-test-user", rich.id).send({ ticketTypeId: typeId });
    const b = await request(app).post(`/api/events/${eventId}/tickets`).set("x-test-user", rich.id).send({ ticketTypeId: typeId });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("enforces quantity — third ticket of a 2-cap type is 409 Sold out", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const buyer = await createUser();
    await seedWallet(buyer.id, 1000);
    const { eventId, typeId } = await createTicketedEvent(admin.id);

    await request(app).post(`/api/events/${eventId}/tickets`).set("x-test-user", buyer.id).send({ ticketTypeId: typeId });
    await request(app).post(`/api/events/${eventId}/tickets`).set("x-test-user", buyer.id).send({ ticketTypeId: typeId });
    const third = await request(app)
      .post(`/api/events/${eventId}/tickets`)
      .set("x-test-user", buyer.id)
      .send({ ticketTypeId: typeId });
    expect(third.status).toBe(409);
  });

  it("sink mode debits the buyer but never credits a runner", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const buyer = await createUser();
    await seedWallet(buyer.id, 500);
    await seedWallet(admin.id, 0);
    const { eventId, typeId } = await createTicketedEvent(admin.id, { ticketPayoutMode: "sink" });

    const res = await request(app)
      .post(`/api/events/${eventId}/tickets`)
      .set("x-test-user", buyer.id)
      .send({ ticketTypeId: typeId });
    expect(res.status).toBe(201);
    expect(res.body.ticket.payoutStatus).toBe("none");

    const [r] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(r.walletBalance).toBe(0);
    const ticketId = res.body.ticket.id as number;
    const credit = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `event-ticket:${ticketId}:credit`));
    expect(credit).toHaveLength(0);
  });
});

describe("event tickets — refund & attendance", () => {
  async function buy(eventId: number, typeId: number, buyerId: string): Promise<number> {
    const res = await request(app)
      .post(`/api/events/${eventId}/tickets`)
      .set("x-test-user", buyerId)
      .send({ ticketTypeId: typeId });
    expect(res.status).toBe(201);
    return res.body.ticket.id as number;
  }

  it("buyer refund returns the money (both refund legs ledgered); a stranger cannot refund it", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const buyer = await createUser();
    const stranger = await createUser();
    await seedWallet(buyer.id, 500);
    await seedWallet(admin.id, 0);
    const { eventId, typeId } = await createTicketedEvent(admin.id);
    const ticketId = await buy(eventId, typeId, buyer.id);

    const denied = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/refund`)
      .set("x-test-user", stranger.id);
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/refund`)
      .set("x-test-user", buyer.id);
    expect(ok.status).toBe(200);
    expect(ok.body.ticket.status).toBe("refunded");

    const [b] = await db.select().from(users).where(eq(users.id, buyer.id));
    const [r] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(b.walletBalance).toBe(500);
    expect(r.walletBalance).toBe(0);

    // Refund is not repeatable.
    const again = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/refund`)
      .set("x-test-user", buyer.id);
    expect(again.status).toBe(409);

    // A refunded ticket can never be checked in (status guard in the UPDATE).
    const checkin = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/attendance`)
      .set("x-test-user", admin.id)
      .send({ attended: true });
    expect(checkin.status).toBe(409);
  });

  it("check-in is manager/staff-gated, idempotent, undoable — and blocks refunds while attended", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const buyer = await createUser();
    const staffer = await createUser();
    await seedWallet(buyer.id, 500);
    const { eventId, typeId } = await createTicketedEvent(admin.id);
    const ticketId = await buy(eventId, typeId, buyer.id);

    // A random player (even the buyer) cannot check in.
    const denied = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/attendance`)
      .set("x-test-user", buyer.id)
      .send({ attended: true });
    expect(denied.status).toBe(403);

    // Manager designates check-in staff; the staffer can then mark attendance.
    const put = await request(app)
      .put(`/api/events/${eventId}/checkin-staff`)
      .set("x-test-user", admin.id)
      .send({ userIds: [staffer.id] });
    expect(put.status).toBe(200);
    const rows = await db.select().from(eventCheckinStaff).where(eq(eventCheckinStaff.eventId, eventId));
    expect(rows.map((r) => r.userId)).toEqual([staffer.id]);

    const checkin = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/attendance`)
      .set("x-test-user", staffer.id)
      .send({ attended: true });
    expect(checkin.status).toBe(200);
    expect(checkin.body.ticket.attendedAt).toBeTruthy();

    // Idempotent repeat keeps the ORIGINAL attendedAt.
    const repeat = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/attendance`)
      .set("x-test-user", staffer.id)
      .send({ attended: true });
    expect(repeat.status).toBe(200);
    expect(repeat.body.ticket.attendedAt).toBe(checkin.body.ticket.attendedAt);

    // Refund is blocked while attended…
    const blocked = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/refund`)
      .set("x-test-user", buyer.id);
    expect(blocked.status).toBe(409);

    // …and allowed again after an undo.
    const undo = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/attendance`)
      .set("x-test-user", staffer.id)
      .send({ attended: false });
    expect(undo.status).toBe(200);
    expect(undo.body.ticket.attendedAt).toBeNull();

    const refund = await request(app)
      .post(`/api/events/${eventId}/tickets/${ticketId}/refund`)
      .set("x-test-user", buyer.id);
    expect(refund.status).toBe(200);
  });

  it("cancelling the event auto-refunds purchased, un-attended tickets", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const buyer = await createUser();
    await seedWallet(buyer.id, 500);
    await seedWallet(admin.id, 0);
    const { eventId, typeId } = await createTicketedEvent(admin.id);
    await buy(eventId, typeId, buyer.id);

    const cancel = await request(app).delete(`/api/events/${eventId}`).set("x-test-user", admin.id);
    expect(cancel.status).toBe(200);
    expect(cancel.body.ticketRefunds).toMatchObject({ refunded: 1 });

    const [b] = await db.select().from(users).where(eq(users.id, buyer.id));
    expect(b.walletBalance).toBe(500);

    const mine = await request(app).get("/api/me/tickets").set("x-test-user", buyer.id);
    expect(mine.status).toBe(200);
    expect(mine.body[0]).toMatchObject({ status: "refunded", eventStatus: "cancelled" });
  });
});
