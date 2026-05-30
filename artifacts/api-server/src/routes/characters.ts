import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, desc, or } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  characterUpdates,
  inventoryItems,
  inventoryEvents,
  walletTransactions,
  users,
  activityEvents,
  lifestyleTiers,
  housing,
  shopOpens,
  type Character,
} from "@workspace/db";
import { gte } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { createPendingEdit } from "./pending-edits";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { hasRole } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";

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
  await recordAudit({
    req,
    category: "character",
    action: "create",
    targetType: "character",
    targetId: c.id,
    message: `Created character ${c.name}`,
    after: { name: c.name, kind: c.kind, archetype: c.archetype },
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
  let lifestyleTier = null;
  if (c.lifestyleTierId != null) {
    const [t] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, c.lifestyleTierId));
    lifestyleTier = t ?? null;
  }
  res.json({ ...c, lifestyleTier, isActive: c.id === req.user!.activeCharacterId });
});

router.put("/characters/:id/lifestyle", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const raw = (req.body ?? {}).lifestyleTierId;
  let tierId: number | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    const parsed = parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
      res.status(400).json({ error: "lifestyleTierId must be an integer or null" });
      return;
    }
    const [t] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, parsed));
    if (!t) {
      res.status(404).json({ error: "Lifestyle tier not found" });
      return;
    }
    if (t.archived) {
      res.status(400).json({ error: "Lifestyle tier is archived" });
      return;
    }
    tierId = parsed;
  }
  const prevTierId = c.lifestyleTierId ?? null;
  const [u] = await db
    .update(characters)
    .set({ lifestyleTierId: tierId })
    .where(eq(characters.id, id))
    .returning();
  let lifestyleTier = null;
  if (u.lifestyleTierId != null) {
    const [t] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, u.lifestyleTierId));
    lifestyleTier = t ?? null;
  }
  if (prevTierId !== tierId) {
    const prevName = prevTierId
      ? (await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, prevTierId)))[0]?.name ?? `#${prevTierId}`
      : "none";
    const nextName = lifestyleTier?.name ?? "none";
    await db.insert(characterUpdates).values({
      characterId: id,
      authorId: req.user!.id,
      note: `Lifestyle changed: ${prevName} → ${nextName}`,
    });
  }
  res.json({ ...u, lifestyleTier, isActive: u.id === req.user!.activeCharacterId });
});

const LIFE_STATUSES = ["active", "dead", "missing", "loa", "retired"] as const;

const CharacterUpdateSchema = z
  .object({
    name: z.string().trim().min(1),
    archetype: z.string().nullable(),
    background: z.string().nullable(),
    portraitUrl: z.string().nullable(),
    portraitUrls: z.array(z.string()),
    statsImageUrls: z.array(z.string()),
    sheetData: z.object({
      preamble: z.string(),
      sections: z.record(z.string(), z.string()),
    }),
    lifeStatus: z.enum(LIFE_STATUSES),
    updateNote: z.string().trim().min(1).max(2000),
  })
  .partial()
  .strict();

// PATCH /characters/:id no longer auto-applies. Edits are queued as
// `pending_character_edits` rows requiring a majority of FIXER /
// CS_APPROVER / ADMIN reviewers (excluding the submitter) to approve
// before they hit the live `characters` row. See pending-edits.ts for
// the review/vote/apply pipeline. Returns 202 with the queued edit id.
router.patch("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await createPendingEdit({ character: c, submitter: req.user!, body: req.body });
  if (result.ok) {
    await recordAudit({
      req,
      category: "character",
      action: "edit_submitted",
      targetType: "character",
      targetId: id,
      message: `Edit queued for ${c.name} (pending fixer review)`,
      after: { pendingEditId: result.edit.id },
    });
  }
  if (!result.ok) {
    switch (result.error.kind) {
      case "no_changes":
        res.status(400).json({ error: "No changes detected" });
        return;
      case "edit_already_pending":
        res.status(409).json({ error: "A pending edit already exists for this character", pendingEditId: result.error.editId });
        return;
      case "invalid":
        res.status(400).json({ error: "Invalid update", details: result.error.details });
        return;
    }
  }
  res.status(202).json({
    pendingEditId: result.edit.id,
    characterId: id,
    status: "pending",
    submittedAt: result.edit.submittedAt,
    message: "Your edit was submitted for fixer review.",
  });
});

router.get("/characters/:id/updates", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Anyone who can view the character detail (owner) can see its update log.
  // The public archive uses its own endpoint and does not include this yet.
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select({
      id: characterUpdates.id,
      characterId: characterUpdates.characterId,
      note: characterUpdates.note,
      createdAt: characterUpdates.createdAt,
      authorId: characterUpdates.authorId,
      authorName: users.username,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(characterUpdates)
    .leftJoin(users, eq(users.id, characterUpdates.authorId))
    .where(eq(characterUpdates.characterId, id))
    .orderBy(desc(characterUpdates.createdAt));
  res.json(rows);
});

// Permanent, irreversible deletion. ADMIN-only — players archive their own
// characters via /deactivate instead. All character-scoped rows (inventory,
// wallet, status, updates, housing, shop opens, …) are removed automatically
// by ON DELETE CASCADE foreign keys.
router.delete("/characters/:id", requireRole("ADMIN"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // active_character_id is a plain column (not a cascading FK), so clear any
  // user still pointing at this character before deleting it.
  await db.update(users).set({ activeCharacterId: null }).where(eq(users.activeCharacterId, id));
  await db.delete(characters).where(eq(characters.id, id));
  await recordAudit({
    req,
    category: "character",
    action: "deleted",
    targetType: "character",
    targetId: id,
    message: `${req.user!.username} permanently deleted ${c.name}`,
    before: { id: c.id, name: c.name, ownerId: c.ownerId },
  });
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
      ownerId: req.user!.id,
      name,
      category: category ?? null,
      quantity: quantity ?? 1,
      notes: notes ?? null,
      equipped: !!equipped,
    })
    .returning();
  await db.insert(characterUpdates).values({
    characterId: id,
    authorId: req.user!.id,
    note: `Added inventory item: ${name}${quantity && quantity > 1 ? ` ×${quantity}` : ""}${category ? ` [${category}]` : ""}`,
  });
  await recordInventoryEvent({
    instanceUuid: it.instanceUuid,
    kind: "created",
    actorId: req.user!.id,
    actorName: req.user!.username,
    toCharacterId: c.id,
    toCharacterName: c.name,
    itemName: it.name,
    quantity: it.quantity,
    reason: "Player added item to inventory",
  });
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
  const [before] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (!before) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
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
  // Log meaningful adjustments: rename, recategorize, requantify, or notes
  // change. Skip equip toggles (too chatty for the audit log).
  const changedFields: string[] = [];
  if (name !== undefined && name !== before.name) changedFields.push("name");
  if (category !== undefined && category !== before.category) changedFields.push("category");
  if (quantity !== undefined && quantity !== before.quantity) changedFields.push("quantity");
  if (notes !== undefined && notes !== before.notes) changedFields.push("notes");
  if (changedFields.length > 0) {
    await recordInventoryEvent({
      instanceUuid: before.instanceUuid,
      kind: "adjusted",
      actorId: req.user!.id,
      actorName: req.user!.username,
      toCharacterId: c.id,
      toCharacterName: c.name,
      itemName: u.name,
      quantity: u.quantity,
      reason: `Owner edited: ${changedFields.join(", ")}`,
      metadata: {
        before: { name: before.name, category: before.category, quantity: before.quantity, notes: before.notes },
        after: { name: u.name, category: u.category, quantity: u.quantity, notes: u.notes },
      },
    });
  }
  const diffs: string[] = [];
  if (name !== undefined && name !== before.name) diffs.push(`name: "${before.name}" → "${name}"`);
  if (quantity !== undefined && quantity !== before.quantity) diffs.push(`qty: ${before.quantity} → ${quantity}`);
  if (equipped !== undefined && equipped !== before.equipped) diffs.push(equipped ? "equipped" : "unequipped");
  if (category !== undefined && category !== before.category) diffs.push(`category: ${before.category ?? "—"} → ${category ?? "—"}`);
  if (notes !== undefined && notes !== before.notes) diffs.push("notes updated");
  if (diffs.length) {
    await db.insert(characterUpdates).values({
      characterId: cid,
      authorId: req.user!.id,
      note: `Inventory item "${u.name}": ${diffs.join(", ")}`,
    });
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
  const [doomed] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  await db.delete(inventoryItems).where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (doomed) {
    await db.insert(characterUpdates).values({
      characterId: cid,
      authorId: req.user!.id,
      note: `Removed inventory item: ${doomed.name}${doomed.quantity > 1 ? ` ×${doomed.quantity}` : ""}`,
    });
    await recordInventoryEvent({
      instanceUuid: doomed.instanceUuid,
      kind: "destroyed",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: c.id,
      fromCharacterName: c.name,
      itemName: doomed.name,
      quantity: doomed.quantity,
      reason: "Removed from inventory",
    });
  }
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

  // Move the item. If sender keeps any (partial transfer) decrement and insert
  // a new instance for the recipient (the split creates a new chain); otherwise
  // reassign characterId so the same instanceUuid persists across owners.
  let movedUuid: string = item.instanceUuid;
  let movedName: string = item.name;
  let splitParentUuid: string | null = null;
  try {
    if (qty === item.quantity) {
      // Whole stack moves: reassign characterId + ownerId. Preserve instanceUuid.
      await db
        .update(inventoryItems)
        .set({ characterId: to.id, ownerId: to.ownerId, equipped: false })
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
    } else {
      await db
        .update(inventoryItems)
        .set({ quantity: item.quantity - qty })
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
      const [inserted] = await db.insert(inventoryItems).values({
        characterId: to.id,
        ownerId: to.ownerId,
        name: item.name,
        category: item.category,
        quantity: qty,
        notes: item.notes,
        equipped: false,
        pricePaid: mode === "sell" ? Number(price) : null,
        acquiredAt: new Date(),
      }).returning();
      splitParentUuid = item.instanceUuid;
      movedUuid = inserted.instanceUuid;
      movedName = inserted.name;
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

  // Per-character audit log entries for both sender and recipient so the
  // transfer shows up in each character's UpdatesLog. Sender row is
  // authored by req.user; recipient row is authored by the recipient's
  // owner so it reads "<owner> received ..." in their feed.
  const senderNote =
    mode === "sell"
      ? `Sold ${item.name} x${qty} to ${to.name} for €$${Number(price)}`
      : `Gave ${item.name} x${qty} to ${to.name}`;
  const recipientNote =
    mode === "sell"
      ? `Bought ${item.name} x${qty} from ${sender.name} for €$${Number(price)}`
      : `Received ${item.name} x${qty} from ${sender.name}`;
  await db.insert(characterUpdates).values([
    { characterId: cid, authorId: req.user!.id, note: senderNote },
    { characterId: to.id, authorId: to.ownerId, note: recipientNote },
  ]);

  // Per-instance audit log. For a partial transfer we record two events:
  // a "split" against the source instance and a "created" for the new
  // recipient instance (so its chain begins at the split point). For a
  // whole-stack move there is one event against the persistent uuid.
  if (splitParentUuid) {
    await recordInventoryEvent({
      instanceUuid: splitParentUuid,
      kind: "split",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: sender.id,
      fromCharacterName: sender.name,
      itemName: item.name,
      quantity: qty,
      reason: `Split ${qty} of ${item.quantity} for ${mode} to ${to.name}`,
      metadata: { childInstanceUuid: movedUuid, mode, toCharacterId: to.id },
    });
    await recordInventoryEvent({
      instanceUuid: movedUuid,
      kind: mode === "sell" ? "sold" : "transferred",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: sender.id,
      fromCharacterName: sender.name,
      toCharacterId: to.id,
      toCharacterName: to.name,
      itemName: movedName,
      quantity: qty,
      price: mode === "sell" ? Number(price) : null,
      reason: memo ?? null,
      metadata: { splitFromInstanceUuid: splitParentUuid, mode },
    });
  } else {
    await recordInventoryEvent({
      instanceUuid: movedUuid,
      kind: mode === "sell" ? "sold" : "transferred",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: sender.id,
      fromCharacterName: sender.name,
      toCharacterId: to.id,
      toCharacterName: to.name,
      itemName: movedName,
      quantity: qty,
      price: mode === "sell" ? Number(price) : null,
      reason: memo ?? null,
      metadata: { mode },
    });
  }

  const [moved] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.instanceUuid, movedUuid));
  res.json(moved ?? item);
});

// ===== Per-item chain of custody =====
// Returns an item by its stable instanceUuid, plus the full event chain.
// Scope: the current owner of the live item, OR any FIXER/ADMIN. If the
// instance no longer exists (consumed/destroyed) only fixers/admins can
// view it — there is no current player owner to authorize against.
router.get("/inventory-items/:uuid", requireAuth, async (req, res): Promise<void> => {
  const uuidParam = String(req.params.uuid);
  if (!/^[0-9a-f-]{36}$/i.test(uuidParam)) {
    res.status(400).json({ error: "Invalid instance uuid" });
    return;
  }
  const [live] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.instanceUuid, uuidParam));
  const isStaff = hasRole(req.user!.roles, "ADMIN") || hasRole(req.user!.roles, "FIXER");
  if (!live && !isStaff) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (live && !isStaff) {
    // Owner check — match by characterId belonging to the caller.
    if (live.characterId == null) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const owned = await loadOwnedChar(req.user!.id, live.characterId);
    if (!owned) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  const events = await db
    .select()
    .from(inventoryEvents)
    .where(eq(inventoryEvents.instanceUuid, uuidParam))
    .orderBy(inventoryEvents.createdAt);
  let currentCharacter: { id: number; name: string } | null = null;
  if (live?.characterId != null) {
    const [c] = await db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(eq(characters.id, live.characterId));
    currentCharacter = c ?? null;
  }
  res.json({ item: live ?? null, currentCharacter, events });
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
    // Compensate: refund sender to keep UB consistent. If the refund itself
    // fails the sender has been debited with no offsetting credit and no
    // record — surface a loud, structured log so an operator can reconcile by
    // hand, and tell the caller the truth rather than a clean refund message.
    const refund = await patchBalance(req.user!.discordId, { cash: amount, reason: `Refund: credit to ${to.name} failed` });
    if (!refund) {
      logger.error(
        { fromDiscordId: req.user!.discordId, toCharacterId: to.id, amount },
        "TRANSFER_REFUND_FAILED: sender debited but credit AND refund failed — manual reconciliation required",
      );
      res.status(502).json({ error: "Transfer failed and refund failed; contact staff for reconciliation." });
      return;
    }
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
  await recordAudit({
    req,
    category: "wallet",
    action: "transfer",
    targetType: "character",
    targetId: id,
    message: `${c.name} → ${to.name}: ${amount}`,
    after: { fromCharacterId: id, toCharacterId: to.id, amount, memo: memo ?? null },
  });
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
  const flips: string[] = [];
  if (loa !== undefined && loa !== (existing?.loa ?? false)) flips.push(loa ? "set LOA" : "returned from LOA");
  if (attending !== undefined && attending !== (existing?.attending ?? false)) flips.push(attending ? "marked attending" : "no longer attending");
  if (openShop !== undefined && openShop !== (existing?.openShop ?? false)) flips.push(openShop ? "opened shop" : "closed shop");
  if (statusMessage !== undefined && statusMessage !== (existing?.statusMessage ?? null)) flips.push("updated status message");
  if (loaReturnsAt !== undefined) {
    const prevMs = existing?.loaReturnsAt ? new Date(existing.loaReturnsAt).getTime() : null;
    const nextMs = loaReturnsAt ? new Date(loaReturnsAt).getTime() : null;
    if (prevMs !== nextMs) {
      flips.push(nextMs ? `LOA return date set to ${new Date(nextMs).toISOString().slice(0, 10)}` : "cleared LOA return date");
    }
  }
  if (flips.length) {
    await db.insert(characterUpdates).values({
      characterId: id,
      authorId: req.user!.id,
      note: `Status: ${flips.join(", ")}`,
    });
  }
  res.json(result);
});

// Open-shop: a character with an active `business` lease can press this
// once per UTC day. The button drives passive income on the next
// monthly_rent run — see SHOP_T0_PAYOUTS / SHOP_TIER_PLUS_MULT in
// lib/jobs.ts. The UNIQUE (characterId, openedOn) index in `shop_opens`
// is the idempotency guarantee; we still pre-count in this month so the
// UI can honestly show "X / 4 paying opens this month" without round-trip
// math on the client.
router.get("/characters/:id/shop", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const leases = await db
    .select()
    .from(housing)
    .where(and(eq(housing.characterId, id), eq(housing.kind, "business")));
  // Start of current UTC month.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const opens = await db
    .select()
    .from(shopOpens)
    .where(and(eq(shopOpens.characterId, id), gte(shopOpens.openedAt, monthStart)))
    .orderBy(desc(shopOpens.openedAt));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  const openedToday = opens.some((o) => o.openedOn === today);
  res.json({
    characterId: id,
    businessLeases: leases.map((l) => ({
      id: l.id,
      listingId: l.listingId,
      address: l.address,
      monthlyRent: l.monthlyRent,
    })),
    canOpen: leases.length > 0,
    openedToday,
    opensThisMonth: opens.length,
    opensCountedForIncome: Math.min(opens.length, 4),
    history: opens.slice(0, 12).map((o) => ({
      openedOn: o.openedOn,
      openedAt: o.openedAt,
      listingId: o.listingId,
    })),
  });
});

router.post("/characters/:id/open-shop", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const leases = await db
    .select()
    .from(housing)
    .where(and(eq(housing.characterId, id), eq(housing.kind, "business")));
  if (leases.length === 0) {
    res.status(403).json({ error: "Character has no active business lease" });
    return;
  }
  // If the body specifies a leaseId, validate it belongs to this character;
  // otherwise default to the first business lease.
  const requestedLeaseId = Number(req.body?.leaseId);
  const lease = requestedLeaseId
    ? leases.find((l) => l.id === requestedLeaseId)
    : leases[0];
  if (!lease) {
    res.status(400).json({ error: "Lease not owned by this character" });
    return;
  }
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  try {
    const [row] = await db
      .insert(shopOpens)
      .values({
        characterId: id,
        listingId: lease.listingId,
        openedOn: today,
        notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      })
      .returning();
    await db.insert(activityEvents).values({
      kind: "shop_opened",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${c.name} opened shop at ${lease.address}`,
    });
    await recordAudit({
      req,
      category: "shop",
      action: "open",
      targetType: "character",
      targetId: id,
      message: `${c.name} opened shop at ${lease.address}`,
      after: { leaseId: lease.id, address: lease.address, openedOn: today },
    });
    res.json({
      characterId: id,
      openedOn: row.openedOn,
      openedAt: row.openedAt,
      leaseAddress: lease.address,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Shop already opened today", openedOn: today });
      return;
    }
    throw err;
  }
});

export default router;
