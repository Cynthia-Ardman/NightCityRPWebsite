import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, walletTransactions, stores, ripperdocs } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

describe("GET /me/wallet/transactions (player ledger scoping)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/me/wallet/transactions");
    expect(res.status).toBe(401);
  });

  it("returns the player's own userId-scoped and character-scoped transactions", async () => {
    const me = await createUser({ username: "v_merc" });
    const myChar = await createCharacter({ ownerId: me.id, name: "V" });

    // account-level (userId) row
    await db.insert(walletTransactions).values({ userId: me.id, amount: 500, kind: "deposit" });
    // character-scoped row for a character I own
    await db.insert(walletTransactions).values({ characterId: myChar.id, amount: -200, kind: "purchase" });

    const res = await request(app).get("/api/me/wallet/transactions").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);

    const userTx = res.body.find((t: { userId: string | null }) => t.userId === me.id);
    expect(userTx).toBeTruthy();
    expect(userTx.amount).toBe(500);

    const charTx = res.body.find((t: { characterId: number | null }) => t.characterId === myChar.id);
    expect(charTx).toBeTruthy();
    expect(charTx.amount).toBe(-200);
  });

  it("does NOT show another player's transactions", async () => {
    const me = await createUser({ username: "judy" });
    const other = await createUser({ username: "kerry" });
    const otherChar = await createCharacter({ ownerId: other.id, name: "Kerry Eurodyne" });

    // another player's account-level and character-scoped rows
    await db.insert(walletTransactions).values({ userId: other.id, amount: 999, kind: "deposit" });
    await db.insert(walletTransactions).values({ characterId: otherChar.id, amount: -50, kind: "purchase" });

    const res = await request(app).get("/api/me/wallet/transactions").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it("scopes to the caller even when both players have history", async () => {
    const me = await createUser({ username: "panam" });
    const other = await createUser({ username: "saul" });
    const myChar = await createCharacter({ ownerId: me.id, name: "Aldecaldo" });

    await db.insert(walletTransactions).values({ characterId: myChar.id, amount: 300, kind: "deposit" });
    await db.insert(walletTransactions).values({ userId: other.id, amount: 700, kind: "deposit" });

    const res = await request(app).get("/api/me/wallet/transactions").set("x-test-user", me.id);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].characterId).toBe(myChar.id);
    expect(res.body[0].amount).toBe(300);
  });

  it("populates counterpartyCharacterName for a player-to-player transfer", async () => {
    const me = await createUser({ username: "river" });
    const receiver = await createUser({ username: "kerry" });
    const myChar = await createCharacter({ ownerId: me.id, name: "River Ward" });
    const receiverChar = await createCharacter({ ownerId: receiver.id, name: "Kerry Eurodyne" });

    // a transfer FROM my character TO another player's character
    await db.insert(walletTransactions).values({
      characterId: myChar.id,
      amount: -500,
      kind: "transfer",
      counterpartyCharacterId: receiverChar.id,
    });

    const res = await request(app).get("/api/me/wallet/transactions").set("x-test-user", me.id);
    expect(res.status).toBe(200);

    const tx = res.body.find((t: { amount: number }) => t.amount === -500);
    expect(tx).toBeTruthy();
    expect(tx.counterpartyCharacterId).toBe(receiverChar.id);
    expect(tx.counterpartyCharacterName).toBe("Kerry Eurodyne");
  });

  it("links ledger rows to the right shop or clinic and leaves plain rows bare", async () => {
    const me = await createUser({ username: "judy" });
    const venueOwner = await createUser({ username: "tom" });
    const myChar = await createCharacter({ ownerId: me.id, name: "Judy Alvarez" });

    // a store and ripperdoc the player does NOT own
    const [store] = await db
      .insert(stores)
      .values({ ownerId: venueOwner.id, name: "Lizzie's Bar", balance: 5000 })
      .returning();
    const [ripperdoc] = await db
      .insert(ripperdocs)
      .values({ ownerId: venueOwner.id, name: "Vik's Clinic", balance: 3000 })
      .returning();

    // character-scoped purchase from a store the player does not own
    await db.insert(walletTransactions).values({
      characterId: myChar.id,
      amount: -150,
      kind: "store_withdraw",
      storeId: store.id,
    });
    // account-level withdraw at a ripperdoc
    await db.insert(walletTransactions).values({
      userId: me.id,
      amount: -400,
      kind: "ripperdoc_withdraw",
      ripperdocId: ripperdoc.id,
    });
    // a plain deposit with no linkable venue
    await db.insert(walletTransactions).values({ userId: me.id, amount: 100, kind: "deposit" });

    const res = await request(app).get("/api/me/wallet/transactions").set("x-test-user", me.id);
    expect(res.status).toBe(200);

    const storeTx = res.body.find((t: { kind: string }) => t.kind === "store_withdraw");
    expect(storeTx.counterpartyVenueKind).toBe("store");
    expect(storeTx.counterpartyVenueId).toBe(store.id);
    expect(storeTx.counterpartyVenueName).toBe("Lizzie's Bar");
    expect(storeTx.characterId).toBe(myChar.id);

    const ripperTx = res.body.find((t: { kind: string }) => t.kind === "ripperdoc_withdraw");
    expect(ripperTx.counterpartyVenueKind).toBe("ripperdoc");
    expect(ripperTx.counterpartyVenueId).toBe(ripperdoc.id);
    expect(ripperTx.counterpartyVenueName).toBe("Vik's Clinic");

    const plainTx = res.body.find((t: { kind: string }) => t.kind === "deposit");
    expect(plainTx.counterpartyVenueKind).toBeNull();
    expect(plainTx.counterpartyVenueId).toBeNull();
    expect(plainTx.counterpartyVenueName).toBeNull();
  });
});
