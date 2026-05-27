import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  inventoryItems,
  walletTransactions,
  users,
  activityEvents,
  type Character,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getBalance, patchBalance } from "../lib/unbelievaboat";

const router: IRouter = Router();

async function loadOwnedChar(userId: string, id: number): Promise<Character | null> {
  const [c] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, userId)));
  return c ?? null;
}

router.get("/characters", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.ownerId, req.user!.id))
    .orderBy(desc(characters.createdAt));
  res.json(rows.map((c) => ({ ...c, isActive: c.id === req.user!.activeCharacterId })));
});

router.post("/characters", requireAuth, async (req, res): Promise<void> => {
  const { name, kind, archetype, background, portraitUrl } = req.body ?? {};
  if (!name || !kind) {
    res.status(400).json({ error: "name and kind required" });
    return;
  }
  const [c] = await db
    .insert(characters)
    .values({
      ownerId: req.user!.id,
      name,
      kind,
      archetype: archetype ?? null,
      background: background ?? null,
      portraitUrl: portraitUrl ?? null,
    })
    .returning();
  await db.insert(characterStatus).values({ characterId: c.id });
  await db.insert(activityEvents).values({
    kind: "character_created",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} created ${c.name}`,
  });
  res.status(201).json({ ...c, isActive: false });
});

router.get("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ...c, isActive: c.id === req.user!.activeCharacterId });
});

router.patch("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, archetype, background, portraitUrl } = req.body ?? {};
  const [u] = await db
    .update(characters)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(archetype !== undefined ? { archetype } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(portraitUrl !== undefined ? { portraitUrl } : {}),
    })
    .where(eq(characters.id, id))
    .returning();
  res.json({ ...u, isActive: u.id === req.user!.activeCharacterId });
});

router.delete("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(characters).where(eq(characters.id, id));
  res.sendStatus(204);
});

router.post("/characters/:id/activate", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(users).set({ activeCharacterId: id }).where(eq(users.id, req.user!.id));
  res.json({ success: true, activeCharacterId: id });
});

// Inventory
router.get("/characters/:id/inventory", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, id));
  res.json(rows);
});

router.post("/characters/:id/inventory", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, category, quantity, notes, equipped } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [it] = await db
    .insert(inventoryItems)
    .values({
      characterId: id,
      name,
      category: category ?? null,
      quantity: quantity ?? 1,
      notes: notes ?? null,
      equipped: !!equipped,
    })
    .returning();
  res.status(201).json(it);
});

router.patch("/characters/:cid/inventory/:itemId", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const c = await loadOwnedChar(req.user!.id, cid);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, category, quantity, notes, equipped } = req.body ?? {};
  const [u] = await db
    .update(inventoryItems)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(equipped !== undefined ? { equipped } : {}),
    })
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)))
    .returning();
  if (!u) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  res.json(u);
});

router.delete("/characters/:cid/inventory/:itemId", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const c = await loadOwnedChar(req.user!.id, cid);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(inventoryItems).where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  res.sendStatus(204);
});

// Wallet
router.get("/characters/:id/wallet", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const ub = await getBalance(req.user!.discordId);
  if (ub) {
    res.json({ balance: ub.total, cash: ub.cash, bank: ub.bank, source: "unbelievaboat" });
    return;
  }
  // local fallback: sum from transactions
  const txs = await db.select().from(walletTransactions).where(eq(walletTransactions.characterId, id));
  const total = txs.reduce((s, t) => s + t.amount, 0);
  res.json({ balance: total, cash: total, bank: 0, source: "local" });
});

router.get("/characters/:id/wallet/transactions", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.characterId, id))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  res.json(rows);
});

router.post("/characters/:id/wallet/transfer", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { toCharacterId, amount, memo } = req.body ?? {};
  if (!toCharacterId || !amount || amount <= 0) {
    res.status(400).json({ error: "toCharacterId and positive amount required" });
    return;
  }
  const [to] = await db.select().from(characters).where(eq(characters.id, toCharacterId));
  if (!to) {
    res.status(404).json({ error: "Recipient not found" });
    return;
  }
  const [toOwner] = await db.select().from(users).where(eq(users.id, to.ownerId));
  // Move via UB API if both have discord ids
  await patchBalance(req.user!.discordId, { cash: -amount, reason: memo ?? `Transfer to ${to.name}` });
  if (toOwner) {
    await patchBalance(toOwner.discordId, { cash: amount, reason: memo ?? `From ${c.name}` });
  }
  await db.insert(walletTransactions).values([
    {
      characterId: id,
      counterpartyCharacterId: to.id,
      counterpartyName: to.name,
      amount: -amount,
      kind: "transfer_out",
      memo: memo ?? null,
    },
    {
      characterId: to.id,
      counterpartyCharacterId: c.id,
      counterpartyName: c.name,
      amount,
      kind: "transfer_in",
      memo: memo ?? null,
    },
  ]);
  const ub = await getBalance(req.user!.discordId);
  res.json(ub ?? { balance: 0, cash: 0, bank: 0, source: "local" });
});

// Status
router.get("/characters/:id/status", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [s] = await db.select().from(characterStatus).where(eq(characterStatus.characterId, id));
  res.json(s ?? { characterId: id, loa: false, attending: false, openShop: false });
});

router.patch("/characters/:id/status", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { loa, loaReturnsAt, attending, openShop, statusMessage } = req.body ?? {};
  const patch = {
    ...(loa !== undefined ? { loa } : {}),
    ...(loaReturnsAt !== undefined ? { loaReturnsAt: loaReturnsAt ? new Date(loaReturnsAt) : null } : {}),
    ...(attending !== undefined ? { attending } : {}),
    ...(openShop !== undefined ? { openShop } : {}),
    ...(statusMessage !== undefined ? { statusMessage } : {}),
  };
  const [existing] = await db.select().from(characterStatus).where(eq(characterStatus.characterId, id));
  let result;
  if (existing) {
    [result] = await db.update(characterStatus).set(patch).where(eq(characterStatus.characterId, id)).returning();
  } else {
    [result] = await db.insert(characterStatus).values({ characterId: id, ...patch }).returning();
  }
  res.json(result);
});

export default router;
