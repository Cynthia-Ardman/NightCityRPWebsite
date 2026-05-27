import { Router, type IRouter } from "express";
import { eq, and, desc, or } from "drizzle-orm";
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
  if (c.archived) {
    res.status(400).json({ error: "Cannot activate an archived character" });
    return;
  }
  await db.update(users).set({ activeCharacterId: id }).where(eq(users.id, req.user!.id));
  res.json({ success: true, activeCharacterId: id });
});

router.post("/characters/:id/deactivate", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(characters).set({ archived: true, archivedAt: new Date() }).where(eq(characters.id, id));
  // If this was the active character, clear it
  const [u] = await db.select().from(users).where(eq(users.id, req.user!.id));
  if (u?.activeCharacterId === id) {
    await db.update(users).set({ activeCharacterId: null }).where(eq(users.id, req.user!.id));
  }
  res.json({ success: true, archived: true });
});

router.post("/characters/:id/reactivate", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(characters).set({ archived: false, archivedAt: null }).where(eq(characters.id, id));
  res.json({ success: true, archived: false });
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

// P2P inventory transfer (give or sell to another character).
// For mode=sell, UB authoritative debit of recipient + credit of sender must
// both succeed before the item moves; on credit failure the recipient is
// refunded so UB stays consistent (same compensation pattern as wallet/transfer).
router.post("/characters/:cid/inventory/:itemId/transfer", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const sender = await loadOwnedChar(req.user!.id, cid);
  if (!sender) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (sender.archived) {
    res.status(400).json({ error: "Cannot transfer from an archived character" });
    return;
  }
  const { toCharacterId, mode, quantity, price, memo } = req.body ?? {};
  if (!toCharacterId || (mode !== "give" && mode !== "sell")) {
    res.status(400).json({ error: "toCharacterId and mode (give|sell) required" });
    return;
  }
  if (toCharacterId === cid) {
    res.status(400).json({ error: "Cannot transfer to the same character" });
    return;
  }
  const qty = Math.max(1, Number(quantity) || 1);
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  if (qty > item.quantity) {
    res.status(400).json({ error: "Quantity exceeds available stock" });
    return;
  }
  const [to] = await db.select().from(characters).where(eq(characters.id, toCharacterId));
  if (!to) {
    res.status(404).json({ error: "Recipient not found" });
    return;
  }
  if (to.archived) {
    res.status(400).json({ error: "Recipient character is archived" });
    return;
  }
  if (!to.ownerId) {
    res.status(409).json({ error: "Recipient character is unclaimed (no owner)" });
    return;
  }
  const [toOwner] = await db.select().from(users).where(eq(users.id, to.ownerId));
  if (!toOwner) {
    res.status(409).json({ error: "Recipient owner account missing" });
    return;
  }

  // Optimistic concurrency: only proceed with the wallet half if the item row
  // hasn't been mutated between the read and now.
  let moneyDebited = false;
  if (mode === "sell") {
    const amount = Number(price);
    if (!amount || amount <= 0) {
      res.status(400).json({ error: "price (positive integer) required for sell" });
      return;
    }
    const buyerBal = await getBalance(toOwner.discordId);
    if (!buyerBal) {
      res.status(502).json({ error: "Wallet provider unavailable" });
      return;
    }
    if (buyerBal.cash < amount) {
      res.status(400).json({ error: "Recipient has insufficient funds" });
      return;
    }
    const debited = await patchBalance(toOwner.discordId, {
      cash: -amount,
      reason: memo ?? `Purchase: ${item.name} x${qty} from ${sender.name}`,
    });
    if (!debited) {
      res.status(502).json({ error: "Wallet provider rejected debit" });
      return;
    }
    moneyDebited = true;
    const credited = await patchBalance(req.user!.discordId, {
      cash: amount,
      reason: memo ?? `Sale: ${item.name} x${qty} to ${to.name}`,
    });
    if (!credited) {
      await patchBalance(toOwner.discordId, {
        cash: amount,
        reason: `Refund: credit to ${sender.name} failed`,
      });
      res.status(502).json({ error: "Wallet provider rejected credit; recipient refunded" });
      return;
    }
    await db.insert(walletTransactions).values([
      {
        characterId: cid,
        counterpartyCharacterId: to.id,
        counterpartyName: to.name,
        amount,
        kind: "shop",
        memo: memo ?? `Sold ${item.name} x${qty}`,
      },
      {
        characterId: to.id,
        counterpartyCharacterId: cid,
        counterpartyName: sender.name,
        amount: -amount,
        kind: "shop",
        memo: memo ?? `Bought ${item.name} x${qty}`,
      },
    ]);
  }

  // Move the item. If sender keeps any (partial transfer) decrement; otherwise delete.
  try {
    if (qty === item.quantity) {
      // Whole stack moves: reassign characterId. Preserve fields.
      await db
        .update(inventoryItems)
        .set({ characterId: to.id })
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
    } else {
      await db
        .update(inventoryItems)
        .set({ quantity: item.quantity - qty })
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
      await db.insert(inventoryItems).values({
        characterId: to.id,
        name: item.name,
        category: item.category,
        quantity: qty,
        notes: item.notes,
        equipped: false,
        pricePaid: mode === "sell" ? Number(price) : null,
        acquiredAt: new Date(),
      });
    }
  } catch (err) {
    // If item move fails after a successful sale, we cannot easily un-debit
    // (UB credit/debit are not atomic), so log and surface a 500.
    req.log.error({ err, itemId, cid, toCharacterId }, "inventory transfer DB write failed");
    if (moneyDebited) {
      res.status(500).json({ error: "Item move failed after wallet writes; please contact an admin." });
    } else {
      res.status(500).json({ error: "Item move failed" });
    }
    return;
  }

  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message:
      mode === "sell"
        ? `${sender.name} sold ${item.name} x${qty} to ${to.name} for €$${price}`
        : `${sender.name} gave ${item.name} x${qty} to ${to.name}`,
  });

  const [moved] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.characterId, to.id), eq(inventoryItems.name, item.name)))
    .orderBy(desc(inventoryItems.createdAt))
    .limit(1);
  res.json(moved ?? item);
});

// Wallet
router.get("/characters/:id/wallet", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // UB is the source of truth — never fall back to a local-sum read.
  const ub = await getBalance(req.user!.discordId);
  if (!ub) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  res.json({ balance: ub.total, cash: ub.cash, bank: ub.bank, source: "unbelievaboat" });
});

router.get("/characters/:id/wallet/transactions", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Return character-scoped rows plus account-level history rows for the
  // owner (imported legacy ledger has userId set / characterId null).
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(
      or(
        eq(walletTransactions.characterId, id),
        eq(walletTransactions.userId, req.user!.id),
      ),
    )
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
  // Refuse to transfer into an unclaimed character — there is no UB account
  // to credit, so the sender's debit would have no offsetting credit.
  if (!to.ownerId) {
    res.status(409).json({ error: "Recipient character is unclaimed (no owner)" });
    return;
  }
  const [toOwner] = await db.select().from(users).where(eq(users.id, to.ownerId));
  if (!toOwner) {
    res.status(409).json({ error: "Recipient owner account missing" });
    return;
  }
  // UB is authoritative — require a successful balance read before attempting writes.
  const senderBal = await getBalance(req.user!.discordId);
  if (!senderBal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (senderBal.cash < amount) {
    res.status(400).json({ error: "Insufficient funds" });
    return;
  }
  // Debit sender via UB — must succeed.
  const debited = await patchBalance(req.user!.discordId, { cash: -amount, reason: memo ?? `Transfer to ${to.name}` });
  if (!debited) {
    res.status(502).json({ error: "Wallet provider rejected debit" });
    return;
  }
  const credited = await patchBalance(toOwner.discordId, { cash: amount, reason: memo ?? `From ${c.name}` });
  if (!credited) {
    // Compensate: refund sender to keep UB consistent.
    await patchBalance(req.user!.discordId, { cash: amount, reason: `Refund: credit to ${to.name} failed` });
    res.status(502).json({ error: "Wallet provider rejected credit; sender refunded" });
    return;
  }
  // Only after confirmed UB writes do we record local history.
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
  res.json(ub ?? { cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
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
