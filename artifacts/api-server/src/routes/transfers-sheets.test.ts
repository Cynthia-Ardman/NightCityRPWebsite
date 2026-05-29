import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import { db, characterSheets, walletTransactions, catalogCyberware } from "@workspace/db";
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

  it("502 when the wallet provider cannot return the sender balance", async () => {
    mockGet.mockResolvedValue(null);
    const owner = await createUser();
    const recipientOwner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50 });
    expect(res.status).toBe(502);
    expect(mockPatch).not.toHaveBeenCalled();
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
    mockGet.mockResolvedValue(bal(500));
    // debit ok, credit fails, refund ok
    mockPatch
      .mockResolvedValueOnce(bal(450))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(bal(500));
    const owner = await createUser();
    const recipientOwner = await createUser();
    const from = await createCharacter({ ownerId: owner.id });
    const to = await createCharacter({ ownerId: recipientOwner.id });
    const res = await request(app)
      .post(`/api/characters/${from.id}/wallet/transfer`)
      .set("x-test-user", owner.id)
      .send({ toCharacterId: to.id, amount: 50 });
    expect(res.status).toBe(502);
    expect(mockPatch).toHaveBeenCalledTimes(3); // debit, credit, refund
    // Verify each leg hit the right account with the right sign — a refund to
    // the wrong identity or amount would leave UB inconsistent.
    expect(mockPatch.mock.calls[0][0]).toBe(owner.discordId);
    expect(mockPatch.mock.calls[0][1]).toMatchObject({ cash: -50 });
    expect(mockPatch.mock.calls[1][0]).toBe(recipientOwner.discordId);
    expect(mockPatch.mock.calls[1][1]).toMatchObject({ cash: 50 });
    // Refund must return the debited amount to the SENDER.
    expect(mockPatch.mock.calls[2][0]).toBe(owner.discordId);
    expect(mockPatch.mock.calls[2][1]).toMatchObject({ cash: 50 });
    const ledger = await db.select().from(walletTransactions);
    expect(ledger).toHaveLength(0);
  });

  it("writes paired ledger rows on a successful transfer", async () => {
    mockGet.mockResolvedValue(bal(500));
    mockPatch.mockResolvedValue(bal(450));
    const owner = await createUser();
    const recipientOwner = await createUser();
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

  it("403 when a non-approver posts a decision", async () => {
    const owner = await createUser();
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/decision`)
      .set("x-test-user", owner.id)
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
  });

  it("400 on an invalid decision value", async () => {
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await seedPendingSheet(approver.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/decision`)
      .set("x-test-user", approver.id)
      .send({ decision: "maybe" });
    expect(res.status).toBe(400);
  });

  it("approves a pending sheet and stamps the decider", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await seedPendingSheet(owner.id, { sheetType: "PC" });
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/decision`)
      .set("x-test-user", approver.id)
      .send({ decision: "approved", note: "lgtm" });
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
