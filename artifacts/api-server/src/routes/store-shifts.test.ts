import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));
vi.mock("../lib/discord", async (orig) => {
  const actual = await orig<typeof import("../lib/discord")>();
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

import {
  db, stores, storeStock, storeEmployees, storeShifts,
  walletTransactions, users, saleOffers, botConfig,
} from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";
import { expireStaleShifts } from "../lib/shifts";

const app = buildTestApp();
const mockGetBalance = vi.mocked(getBalance);
const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockGetBalance.mockReset();
  mockPatch.mockReset();
  mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
});

async function setFlag(key: string, value: boolean) {
  await db.insert(botConfig).values({ key, value }).onConflictDoUpdate({ target: botConfig.key, set: { value } });
}
async function setEconomyMode(mode: "disabled" | "test" | "enabled") {
  await setFlag("economy_enabled", mode !== "disabled");
  await setFlag("master_live_mode", mode === "enabled");
  await setFlag("economy_live_mode", mode === "enabled");
}
async function fund(userId: string, amount: number) {
  await db.update(users).set({ walletBalance: amount }).where(eq(users.id, userId));
}

// A bar with shifts enabled, an owner (with owner character), and n employees.
async function seedBar(opts: { pct?: number; enabled?: boolean; employees?: number } = {}) {
  const owner = await createUser();
  const ownerChar = await createCharacter({ ownerId: owner.id });
  const [bar] = await db
    .insert(stores)
    .values({
      ownerId: owner.id,
      ownerCharacterId: ownerChar.id,
      name: "The Afterlife",
      balance: 0,
      shiftsEnabled: opts.enabled ?? true,
      shiftWagePct: opts.pct ?? 10,
    })
    .returning();
  const employees: { user: Awaited<ReturnType<typeof createUser>>; charId: number }[] = [];
  for (let i = 0; i < (opts.employees ?? 1); i++) {
    const u = await createUser();
    const c = await createCharacter({ ownerId: u.id });
    await db.insert(storeEmployees).values({ storeId: bar.id, characterId: c.id, role: "bartender", commissionPct: 20 });
    employees.push({ user: u, charId: c.id });
  }
  return { owner, ownerChar, bar, employees };
}

async function makeOffer(bar: { id: number }, opts: { price?: number; qty?: number; cost?: number; commissionPct?: number; sellerEmployeeId?: number | null; sellerCharacterId?: number | null } = {}) {
  const buyerUser = await createUser();
  const buyer = await createCharacter({ ownerId: buyerUser.id });
  const [stock] = await db
    .insert(storeStock)
    .values({ storeId: bar.id, name: "Synth-whiskey", price: opts.price ?? 100, cost: opts.cost ?? 0, quantity: 50 })
    .returning();
  const qty = opts.qty ?? 1;
  const unitPrice = opts.price ?? 100;
  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind: "store",
      storeId: bar.id,
      stockId: stock.id,
      itemName: stock.name,
      itemCategory: null,
      unitPrice,
      quantity: qty,
      totalPrice: unitPrice * qty,
      costBasis: (opts.cost ?? 0) * qty,
      buyerCharacterId: buyer.id,
      buyerUserId: buyerUser.id,
      sellerCharacterId: opts.sellerCharacterId ?? null,
      sellerEmployeeId: opts.sellerEmployeeId ?? null,
      commissionPct: opts.commissionPct ?? 0,
      createdById: buyerUser.id,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();
  await fund(buyerUser.id, 100_000);
  return { buyerUser, buyer, offer };
}

const clockIn = (storeId: number, userId: string, body: object = {}) =>
  request(app).post(`/api/stores/${storeId}/shifts/clock-in`).set("x-test-user", userId).send(body);
const clockOut = (storeId: number, userId: string) =>
  request(app).post(`/api/stores/${storeId}/shifts/clock-out`).set("x-test-user", userId);
const approve = (offerId: number, userId: string) =>
  request(app).post(`/api/offers/${offerId}/approve`).set("x-test-user", userId);

describe("shift clock-in/out", () => {
  it("employee clocks in for a 4-hour shift; second clock-in 409s", async () => {
    const { bar, employees } = await seedBar();
    const res = await clockIn(bar.id, employees[0].user.id);
    expect(res.status).toBe(201);
    expect(res.body.characterId).toBe(employees[0].charId);
    const dur = new Date(res.body.scheduledEndAt).getTime() - new Date(res.body.clockInAt).getTime();
    expect(dur).toBe(4 * 60 * 60 * 1000);
    // Double clock-in — even at a DIFFERENT venue — 409s.
    expect((await clockIn(bar.id, employees[0].user.id)).status).toBe(409);
    const { bar: other } = await seedBar();
    expect((await clockIn(other.id, employees[0].user.id)).status).toBe(403); // not employed there
  });

  it("owner clocks in as their owner character", async () => {
    const { bar, owner, ownerChar } = await seedBar();
    const res = await clockIn(bar.id, owner.id);
    expect(res.status).toBe(201);
    expect(res.body.characterId).toBe(ownerChar.id);
  });

  it("strangers and staff cannot clock in; disabled venue 409s", async () => {
    const { bar, employees } = await seedBar();
    const stranger = await createUser();
    expect((await clockIn(bar.id, stranger.id)).status).toBe(403);
    const admin = await createAdmin();
    expect((await clockIn(bar.id, admin.id)).status).toBe(403);
    await db.update(stores).set({ shiftsEnabled: false }).where(eq(stores.id, bar.id));
    expect((await clockIn(bar.id, employees[0].user.id)).status).toBe(409);
  });

  it("reassigned owner cannot clock in as the FORMER owner's character", async () => {
    const { bar } = await seedBar();
    const newOwner = await createUser();
    // Staff reassigned ownerId but left ownerCharacterId pointing at the old
    // owner's character — fallback must not attribute a shift to it.
    await db.update(stores).set({ ownerId: newOwner.id }).where(eq(stores.id, bar.id));
    const res = await clockIn(bar.id, newOwner.id);
    expect(res.status).toBe(400); // asked to pick a character instead
    // With their own character explicitly, it works.
    const newChar = await createCharacter({ ownerId: newOwner.id });
    const ok = await clockIn(bar.id, newOwner.id, { characterId: newChar.id });
    expect(ok.status).toBe(201);
    expect(ok.body.characterId).toBe(newChar.id);
  });

  it("rejects clocking in with someone else's character", async () => {
    const { bar, employees } = await seedBar({ employees: 2 });
    const res = await clockIn(bar.id, employees[0].user.id, { characterId: employees[1].charId });
    expect(res.status).toBe(403);
  });

  it("clock-out closes the shift; without one it 404s; expiry auto-closes", async () => {
    const { bar, employees } = await seedBar();
    await clockIn(bar.id, employees[0].user.id);
    const out = await clockOut(bar.id, employees[0].user.id);
    expect(out.status).toBe(200);
    expect(out.body.clockOutAt).toBeTruthy();
    expect((await clockOut(bar.id, employees[0].user.id)).status).toBe(404);
    // Expired shift: sweep stamps clockOutAt = scheduledEndAt.
    const past = new Date(Date.now() - 60_000);
    const [row] = await db
      .insert(storeShifts)
      .values({ storeId: bar.id, characterId: employees[0].charId, userId: employees[0].user.id, clockInAt: new Date(Date.now() - 5 * 3_600_000), scheduledEndAt: past })
      .returning();
    await expireStaleShifts();
    const [swept] = await db.select().from(storeShifts).where(eq(storeShifts.id, row.id));
    expect(swept.clockOutAt?.getTime()).toBe(past.getTime());
  });

  it("GET /shifts/me returns my active shift (null when off)", async () => {
    const { bar, employees } = await seedBar();
    const me = employees[0].user;
    let res = await request(app).get("/api/shifts/me").set("x-test-user", me.id);
    expect(res.body.shift).toBeNull();
    await clockIn(bar.id, me.id);
    res = await request(app).get("/api/shifts/me").set("x-test-user", me.id);
    expect(res.body.shift.storeId).toBe(bar.id);
  });
});

describe("wage split on sale approval", () => {
  it("splits pct of the sale TOTAL evenly, floors, remainder stays in the venue", async () => {
    await setEconomyMode("enabled");
    const { bar, owner, employees } = await seedBar({ pct: 10, employees: 2 });
    await clockIn(bar.id, owner.id);
    await clockIn(bar.id, employees[0].user.id);
    await clockIn(bar.id, employees[1].user.id);
    // total 1003 → pool 10% = 100.3 → per worker floor(100.3/3)=33, wages 99.
    const { offer, buyerUser } = await makeOffer(bar, { price: 1003, qty: 1 });
    const res = await approve(offer.id, buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.shiftWagesPaid).toBe(99);
    expect(res.body.venueBalance).toBe(1003 - 99);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.shiftWagesAmount).toBe(99);
    expect(fresh.shiftWagesSettledAt).toBeTruthy();
    for (const w of [owner, employees[0].user, employees[1].user]) {
      const [u] = await db.select().from(users).where(eq(users.id, w.id));
      expect(u.walletBalance).toBe(33);
    }
    // Shift stats bumped.
    const shifts = await db.select().from(storeShifts).where(eq(storeShifts.storeId, bar.id));
    for (const s of shifts) {
      expect(s.earnedTotal).toBe(33);
      expect(s.salesCount).toBe(1);
    }
    // Ledger: ONE venue debit (-99) plus one +33 credit row per worker (the
    // applyWalletDelta credits also stamp storeId, hence 4 rows total).
    const ledger = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.storeId, bar.id), eq(walletTransactions.kind, "shift_wage")));
    expect(ledger).toHaveLength(4);
    const debits = ledger.filter((r) => r.amount < 0);
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(-99);
    expect(ledger.filter((r) => r.amount === 33)).toHaveLength(3);
  });

  it("suppresses employee commission while a shift is active", async () => {
    await setEconomyMode("enabled");
    const { bar, employees } = await seedBar({ pct: 10, employees: 1 });
    const clerk = employees[0];
    await clockIn(bar.id, clerk.user.id);
    const [emp] = await db.select().from(storeEmployees).where(eq(storeEmployees.storeId, bar.id));
    const { offer, buyerUser } = await makeOffer(bar, {
      price: 1000, qty: 1, commissionPct: 20, sellerEmployeeId: emp.id, sellerCharacterId: clerk.charId,
    });
    const res = await approve(offer.id, buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.commissionPaid).toBe(0);
    expect(res.body.shiftWagesPaid).toBe(100);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.commissionSettledAt).toBeNull();
    const [u] = await db.select().from(users).where(eq(users.id, clerk.user.id));
    expect(u.walletBalance).toBe(100); // wage only, no commission
  });

  it("commission behaves as before when nobody is on shift or pct is 0", async () => {
    await setEconomyMode("enabled");
    const { bar, employees } = await seedBar({ pct: 10, employees: 1 });
    const clerk = employees[0];
    const [emp] = await db.select().from(storeEmployees).where(eq(storeEmployees.storeId, bar.id));
    // Nobody clocked in → commission on profit as usual.
    const { offer, buyerUser } = await makeOffer(bar, {
      price: 1000, qty: 1, cost: 500, commissionPct: 20, sellerEmployeeId: emp.id, sellerCharacterId: clerk.charId,
    });
    const res = await approve(offer.id, buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.shiftWagesPaid ?? 0).toBe(0);
    expect(res.body.commissionPaid).toBe(100); // 20% of 500 profit
    // pct 0 with someone clocked in → also commission as usual.
    await db.update(stores).set({ shiftWagePct: 0 }).where(eq(stores.id, bar.id));
    await clockIn(bar.id, clerk.user.id);
    const second = await makeOffer(bar, {
      price: 1000, qty: 1, cost: 500, commissionPct: 20, sellerEmployeeId: emp.id, sellerCharacterId: clerk.charId,
    });
    const res2 = await approve(second.offer.id, second.buyerUser.id);
    expect(res2.body.commissionPaid).toBe(100);
    expect(res2.body.shiftWagesPaid ?? 0).toBe(0);
  });

  it("expired (but unswept) shifts earn nothing", async () => {
    await setEconomyMode("enabled");
    const { bar, employees } = await seedBar({ pct: 10 });
    // Manually insert a shift whose window already passed but was never swept.
    await db.insert(storeShifts).values({
      storeId: bar.id,
      characterId: employees[0].charId,
      userId: employees[0].user.id,
      clockInAt: new Date(Date.now() - 5 * 3_600_000),
      scheduledEndAt: new Date(Date.now() - 3_600_000),
    });
    const { offer, buyerUser } = await makeOffer(bar, { price: 1000 });
    const res = await approve(offer.id, buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.shiftWagesPaid ?? 0).toBe(0);
    const [u] = await db.select().from(users).where(eq(users.id, employees[0].user.id));
    expect(u.walletBalance).toBe(0);
  });

  it("re-approval retry does not double-pay (idempotent per shift)", async () => {
    await setEconomyMode("enabled");
    const { bar, employees } = await seedBar({ pct: 10 });
    await clockIn(bar.id, employees[0].user.id);
    const { offer, buyerUser } = await makeOffer(bar, { price: 1000 });
    expect((await approve(offer.id, buyerUser.id)).status).toBe(200);
    // Second approve hits the recovery path: wages already settled + credited,
    // idempotency key blocks a second credit.
    const again = await approve(offer.id, buyerUser.id);
    expect(again.status).toBe(409);
    const [u] = await db.select().from(users).where(eq(users.id, employees[0].user.id));
    expect(u.walletBalance).toBe(100);
    const shifts = await db.select().from(storeShifts).where(eq(storeShifts.storeId, bar.id));
    expect(shifts[0].earnedTotal).toBe(100);
    expect(shifts[0].salesCount).toBe(1);
  });

  it("Test mode moves no money and reserves nothing", async () => {
    await setEconomyMode("test");
    const { bar, employees } = await seedBar({ pct: 10 });
    await clockIn(bar.id, employees[0].user.id);
    const { offer, buyerUser } = await makeOffer(bar, { price: 1000 });
    const res = await approve(offer.id, buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.shiftWagesSettledAt).toBeNull();
    const [u] = await db.select().from(users).where(eq(users.id, employees[0].user.id));
    expect(u.walletBalance).toBe(0);
  });
});

describe("shift settings & report", () => {
  it("owner sets shiftWagePct (clamped); only staff toggle shiftsEnabled", async () => {
    const { bar, owner } = await seedBar();
    let res = await request(app).patch(`/api/stores/${bar.id}`).set("x-test-user", owner.id).send({ shiftWagePct: 250 });
    expect(res.status).toBe(200);
    let [s] = await db.select().from(stores).where(eq(stores.id, bar.id));
    expect(s.shiftWagePct).toBe(100);
    res = await request(app).patch(`/api/stores/${bar.id}`).set("x-test-user", owner.id).send({ shiftsEnabled: false });
    expect(res.status).toBe(403);
    const admin = await createAdmin();
    res = await request(app).patch(`/api/stores/${bar.id}`).set("x-test-user", admin.id).send({ shiftsEnabled: false });
    expect(res.status).toBe(200);
    [s] = await db.select().from(stores).where(eq(stores.id, bar.id));
    expect(s.shiftsEnabled).toBe(false);
  });

  it("report: owner sees history + totals; employee sees active crew + own history; stranger 403s", async () => {
    const { bar, owner, employees } = await seedBar({ employees: 2 });
    await clockIn(bar.id, employees[0].user.id);
    // employee[1] worked earlier and clocked out.
    await clockIn(bar.id, employees[1].user.id);
    await clockOut(bar.id, employees[1].user.id);
    const ownerView = await request(app).get(`/api/stores/${bar.id}/shifts`).set("x-test-user", owner.id);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.shifts).toHaveLength(2);
    expect(ownerView.body.totals).toBeDefined();
    const empView = await request(app).get(`/api/stores/${bar.id}/shifts`).set("x-test-user", employees[0].user.id);
    expect(empView.status).toBe(200);
    // Active crew (their own active shift) but NOT employee[1]'s closed shift.
    expect(empView.body.shifts).toHaveLength(1);
    expect(empView.body.totals).toBeUndefined();
    const stranger = await createUser();
    expect((await request(app).get(`/api/stores/${bar.id}/shifts`).set("x-test-user", stranger.id)).status).toBe(403);
  });
});
