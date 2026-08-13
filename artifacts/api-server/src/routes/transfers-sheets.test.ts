import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import { db, characterSheets, walletTransactions, catalogCyberware, users } from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockGet = vi.mocked(getBalance);
const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
});

const bal = (cash: number) => ({ cash, bank: 0, total: cash, source: "unbelievaboat" as const });

// Website wallet is the source of truth; give a user local funds directly.
async function fund(userId: string, amount: number) {
  await db.update(users).set({ walletBalance: amount, lastSyncedUbBalance: amount }).where(eq(users.id, userId));
}
const walletOf = async (userId: string) =>
  (await db.select().from(users).where(eq(users.id, userId)))[0].walletBalance;

describe("POST /characters/:id/wallet/transfer", () => {
  it("404 when the sender character is not owned by the caller", async () => {
    const owner = await createUser();
    const other = await createUser();
    const char = await createCharacter({ ownerId: other.id });
    const res = await request(app)
      .post(`/api/characters/${char.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: 999, amount: 10 });
    expect(res.status).toBe(404);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("400 when amount is missing or non-positive", async () => {
    const owner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 0 });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("404 when the recipient character does not exist", async () => {
    const owner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: 987654, amount: 10 });
    expect(res.status).toBe(404);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("409 and NO debit when the recipient is unclaimed (no owner)", async () => {
    const owner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: null });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50 });
    expect(res.status).toBe(409);
    // The key safety property: we must bail before touching the wallet.
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
    const ledger = await db.select().from(walletTransactions);
    expect(ledger).toHaveLength(0);
  });

  it("400 when the sender has no local funds and UB cannot be reached for the self-heal", async () => {
    // Website wallet is empty and the live-UB self-heal can't fetch a balance,
    // so the transfer is refused as insufficient funds — never a partial move.
    mockGet.mockResolvedValue(null);
    const owner = await createUser();
    const recipientOwner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50 });
    expect(res.status).toBe(400);
    const ledger = await db.select().from(walletTransactions);
    expect(ledger).toHaveLength(0);
  });

  it("400 on insufficient funds", async () => {
    mockGet.mockResolvedValue(bal(10));
    const owner = await createUser();
    const recipientOwner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50 });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("refunds the sender and 502s when the recipient credit fails", async () => {
    const owner = await createUser();
    const recipientOwner = await createUser();
    await fund(owner.id, 500);
    // Force the +50 recipient credit to fail: the recipient wallet is pinned
    // near the max balance so the credit would overflow it.
    await fund(recipientOwner.id, 2_147_483_620);
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50 });
    expect(res.status).toBe(502);
    // Sender fully refunded; recipient untouched — no money vanished.
    expect(await walletOf(owner.id)).toBe(500);
    expect(await walletOf(recipientOwner.id)).toBe(2_147_483_620);
    const inn = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "transfer_in"));
    expect(inn).toHaveLength(0);
  });

  it("writes paired ledger rows on a successful transfer", async () => {
    const owner = await createUser();
    const recipientOwner = await createUser();
    await fund(owner.id, 500);
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50, memo: "rent" });
    expect(res.status).toBe(200);

    const out = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "transfer_out"));
    const inn = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "transfer_in"));
    expect(out).toHaveLength(1);
    expect(inn).toHaveLength(1);
    expect(out[0].amount).toBe(-50);
    expect(out[0].characterId).toBe(from.id);
    expect(inn[0].amount).toBe(50);
    expect(inn[0].characterId).toBe(to.id);
  });

  it("is idempotent: a retry with the same idempotencyKey does not move eddies twice", async () => {
    const owner = await createUser();
    const recipientOwner = await createUser();
    await fund(owner.id, 500);
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const body = { toCharacterId: to.id, amount: 50, memo: "rent", idempotencyKey: "dup-key-1" };

    const first = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send(body);
    expect(first.status).toBe(200);
    expect(await walletOf(owner.id)).toBe(450);

    const second = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send(body);
    expect(second.status).toBe(200);

    // The retry must short-circuit: no additional wallet movement, and still
    // exactly one paired set of ledger rows.
    expect(await walletOf(owner.id)).toBe(450);
    const out = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "transfer_out"));
    const inn = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "transfer_in"));
    expect(out).toHaveLength(1);
    expect(inn).toHaveLength(1);
  });
});

async function seedPendingSheet(ownerId: string, data: Record<string, unknown>) {
  const [s] = await db
    .insert(characterSheets)
    .values({ ownerId, name: "Test Sheet", status: "pending", data })
    .returning();
  return s;
}

describe("PATCH /sheets/:id — 6-CWP cap re-enforcement on in-review edits", () => {
  it("rejects a pending-sheet edit that pushes custom cyberware over 6 CWP", async () => {
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .patch(`/api/sheets/${sheet.id}`)
      .set("x-test-user", owner.id)
      .send({ data: { sheetType: "PC", cyberware: [{ name: "Custom Implant", points: 10 }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/CWP|cyberware points/i);
    // Data must NOT have been persisted.
    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect((after.data as Record<string, unknown>).cyberware).toBeUndefined();
  });

  it("rejects negative custom CWP (cannot offset over-cap entries)", async () => {
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .patch(`/api/sheets/${sheet.id}`)
      .set("x-test-user", owner.id)
      .send({
        data: {
          sheetType: "PC",
          cyberware: [
            { name: "A", points: 8 },
            { name: "B", points: -4 },
          ],
        },
      });
    expect(res.status).toBe(400);
  });

  it("ignores a tampered client `points` on a catalog item — catalog CWP is authoritative", async () => {
    // The whole point of the cap being tamper-proof: a catalog-matched install
    // costs what the catalog says, not what the client claims. A crafted payload
    // sending points:0 for an 8-CWP catalog item must still be rejected.
    await db.insert(catalogCyberware).values({ name: "Mantis Blades", slot: "arms", cwp: "8" });
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .patch(`/api/sheets/${sheet.id}`)
      .set("x-test-user", owner.id)
      .send({ data: { sheetType: "PC", cyberware: [{ name: "Mantis Blades", points: 0 }] } });
    expect(res.status).toBe(400);
    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect((after.data as Record<string, unknown>).cyberware).toBeUndefined();
  });

  it("accepts a pending-sheet edit at or under the 6-CWP cap", async () => {
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .patch(`/api/sheets/${sheet.id}`)
      .set("x-test-user", owner.id)
      .send({ data: { sheetType: "PC", cyberware: [{ name: "Small Implant", points: 5 }] } });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect((after.data as { cyberware: unknown[] }).cyberware).toHaveLength(1);
  });
});

describe("sheets lifecycle: submit + decision gating", () => {
  it("403 when a non-owner tries to submit a sheet", async () => {
    const owner = await createUser();
    const other = await createUser();
    const [draft] = await db
      .insert(characterSheets)
      .values({ ownerId: owner.id, name: "Draft", status: "draft", data: { sheetType: "PC" } })
      .returning();
    const res = await request(app)
      .post(`/api/sheets/${draft.id}/submit`)
      .set("x-test-user", other.id)
      .send({});
    expect(res.status).toBe(403);
  });

  it("409 when submitting a sheet that is not in a submittable state", async () => {
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/submit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(res.status).toBe(409);
  });

  it("403 when a non-approver posts a vote", async () => {
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", owner.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);
  });

  it("400 on an invalid vote value", async () => {
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await seedPendingSheet(approver.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", approver.id)
      .send({ vote: "maybe" });
    expect(res.status).toBe(400);
  });

  it("approves a pending sheet and stamps the decider", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", approver.id)
      .send({ vote: "approve", note: "lgtm" });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("approved");
    expect(after.decisionBy).toBe(approver.id);
    expect(after.decidedAt).not.toBeNull();
  });
});

describe("POST /sheets — draft bypasses submission validation", () => {
  it("400 when name or data is missing", async () => {
    const owner = await createUser();
    const res = await request(app).post("/api/sheets").set("x-test-user", owner.id).send({ name: "x" });
    expect(res.status).toBe(400);
  });

  it("201 for a draft even with otherwise-incomplete data", async () => {
    const owner = await createUser();
    const res = await request(app)
      .post("/api/sheets")
      .set("x-test-user", owner.id)
      .send({ name: "WIP", status: "draft", data: { sheetType: "PC" } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
  });
});

describe("wallet transfers — user targets & account-level sender", () => {
  it("400 when both toCharacterId and toUserId are given", async () => {
    const owner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: 1, toUserId: "x", amount: 10 });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("transfers to a bare player account via toUserId (no character)", async () => {
    const owner = await createUser();
    const recipient = await createUser();
    await fund(owner.id, 500);
    const from = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toUserId: recipient.id, amount: 100 });
    expect(res.status).toBe(200);
    expect(await walletOf(owner.id)).toBe(400);
    expect(await walletOf(recipient.id)).toBe(100);
    const rows = await db.select().from(walletTransactions);
    const inLeg = rows.find((r) => r.kind === "transfer_in");
    expect(inLeg?.userId).toBe(recipient.id);
    expect(inLeg?.characterId).toBeNull();
  });

  it("409 when toUserId does not exist", async () => {
    const owner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toUserId: "does-not-exist", amount: 10 });
    expect(res.status).toBe(409);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("POST /wallet/transfer sends from the account with no character context", async () => {
    const sender = await createUser();
    const recipientOwner = await createUser();
    await fund(sender.id, 500);
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post("/api/wallet/transfer")
      .set("x-test-user", sender.id)
      .send({ toCharacterId: to.id, amount: 100 });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBeDefined();
    const rows = await db.select().from(walletTransactions);
    const outLeg = rows.find((r) => r.kind === "transfer_out");
    expect(outLeg?.userId).toBe(sender.id);
    expect(outLeg?.characterId).toBeNull();
    const inLeg = rows.find((r) => r.kind === "transfer_in");
    expect(inLeg?.characterId).toBe(to.id);
  });

  it("account-level idempotency: same key does not double-move", async () => {
    const sender = await createUser();
    const recipient = await createUser();
    await fund(sender.id, 500);
    const key = "abc-123";
    const first = await request(app)
      .post("/api/wallet/transfer")
      .set("x-test-user", sender.id)
      .send({ toUserId: recipient.id, amount: 100, idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(await walletOf(sender.id)).toBe(400);
    const second = await request(app)
      .post("/api/wallet/transfer")
      .set("x-test-user", sender.id)
      .send({ toUserId: recipient.id, amount: 100, idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(await walletOf(sender.id)).toBe(400);
    expect(await walletOf(recipient.id)).toBe(100);
  });
});
