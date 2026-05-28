import { Router, type IRouter } from "express";
import { eq, and, desc, or, ilike, inArray, sql } from "drizzle-orm";
import { db, fixerNpcs, missionLog, characters, users, walletTransactions, activityEvents, inventoryItems, inventoryEvents } from "@workspace/db";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import { patchBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/fixer/npcs/mine", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const rows = await db.select().from(fixerNpcs).where(eq(fixerNpcs.fixerId, req.user!.id)).orderBy(desc(fixerNpcs.createdAt));
  res.json(rows);
});

router.get("/fixer/npcs", requireAuth, requireRole("FIXER"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: fixerNpcs.id,
      name: fixerNpcs.name,
      archetype: fixerNpcs.archetype,
      district: fixerNpcs.district,
      description: fixerNpcs.description,
      portraitUrl: fixerNpcs.portraitUrl,
      contact: fixerNpcs.contact,
      createdAt: fixerNpcs.createdAt,
      fixerName: users.username,
      fixerAvatarUrl: users.avatarUrl,
    })
    .from(fixerNpcs)
    .leftJoin(users, eq(users.id, fixerNpcs.fixerId))
    .orderBy(desc(fixerNpcs.createdAt));
  res.json(rows);
});

router.post("/fixer/npcs", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const { name, archetype, district, description, portraitUrl, contact } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [n] = await db
    .insert(fixerNpcs)
    .values({
      fixerId: req.user!.id,
      name,
      archetype: archetype ?? null,
      district: district ?? null,
      description: description ?? null,
      portraitUrl: portraitUrl ?? null,
      contact: contact ?? null,
    })
    .returning();
  res.status(201).json(n);
});

router.get("/fixer/npcs/:id", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [n] = await db.select().from(fixerNpcs).where(eq(fixerNpcs.id, id));
  if (!n) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(n);
});

router.patch("/fixer/npcs/:id", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [n] = await db.select().from(fixerNpcs).where(and(eq(fixerNpcs.id, id), eq(fixerNpcs.fixerId, req.user!.id)));
  if (!n) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, archetype, district, description, portraitUrl, contact } = req.body ?? {};
  const [u] = await db
    .update(fixerNpcs)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(archetype !== undefined ? { archetype } : {}),
      ...(district !== undefined ? { district } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(portraitUrl !== undefined ? { portraitUrl } : {}),
      ...(contact !== undefined ? { contact } : {}),
    })
    .where(eq(fixerNpcs.id, id))
    .returning();
  res.json(u);
});

// ===== Missions =====
router.get("/fixer/missions", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const characterId = req.query.characterId ? parseInt(String(req.query.characterId), 10) : null;
  const limit = Math.min(500, parseInt(String(req.query.limit ?? "100"), 10) || 100);
  const baseSel = db
    .select({
      id: missionLog.id,
      characterId: missionLog.characterId,
      characterName: characters.name,
      fixerId: missionLog.fixerId,
      fixerName: users.username,
      title: missionLog.title,
      summary: missionLog.summary,
      payoutEddies: missionLog.payoutEddies,
      status: missionLog.status,
      occurredAt: missionLog.occurredAt,
      createdAt: missionLog.createdAt,
    })
    .from(missionLog)
    .leftJoin(characters, eq(characters.id, missionLog.characterId))
    .leftJoin(users, eq(users.id, missionLog.fixerId));
  const rows = characterId
    ? await baseSel.where(eq(missionLog.characterId, characterId)).orderBy(desc(missionLog.createdAt)).limit(limit)
    : await baseSel.orderBy(desc(missionLog.createdAt)).limit(limit);
  res.json(rows);
});

router.post("/fixer/missions", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const { title, characterId, summary, payoutEddies, status, occurredAt, pay } = req.body ?? {};
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "title required" });
    return;
  }
  const payout = Number(payoutEddies) || 0;
  let buyerCharId: number | null = characterId ? Number(characterId) : null;
  let creditedCharacter: { id: number; name: string; ownerDiscord: string } | null = null;
  // Optional UB movement: debit fixer's wallet, credit character's wallet.
  if (pay && payout > 0) {
    if (!buyerCharId) {
      res.status(400).json({ error: "characterId required when pay=true" });
      return;
    }
    const [c] = await db.select().from(characters).where(eq(characters.id, buyerCharId));
    if (!c) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    if (!c.ownerId) {
      res.status(400).json({ error: "Character is unclaimed; cannot credit wallet" });
      return;
    }
    const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
    if (!owner) {
      res.status(404).json({ error: "Character owner not found" });
      return;
    }
    const debit = await patchBalance(req.user!.discordId, { cash: -payout, reason: `Mission payout: ${title}` });
    if (!debit) {
      res.status(502).json({ error: "Wallet provider rejected fixer debit" });
      return;
    }
    const credit = await patchBalance(owner.discordId, { cash: payout, reason: `Mission payout: ${title}` });
    if (!credit) {
      // Refund the fixer; abandon the mission write.
      await patchBalance(req.user!.discordId, { cash: payout, reason: `Refund: payout credit failed for ${title}` });
      res.status(502).json({ error: "Wallet provider rejected character credit; fixer refunded" });
      return;
    }
    creditedCharacter = { id: c.id, name: c.name, ownerDiscord: owner.discordId };
    try {
      await db.insert(walletTransactions).values([
        {
          userId: req.user!.id,
          counterpartyCharacterId: c.id,
          counterpartyName: c.name,
          amount: -payout,
          kind: "mission",
          memo: `Mission: ${title}`,
        },
        {
          characterId: c.id,
          counterpartyName: req.user!.username,
          amount: payout,
          kind: "mission",
          memo: `Mission: ${title}`,
        },
      ]);
    } catch (err) {
      logger.error({ err }, "mission wallet ledger insert failed");
    }
  }
  const [m] = await db
    .insert(missionLog)
    .values({
      fixerId: req.user!.id,
      characterId: buyerCharId,
      title,
      summary: summary ?? null,
      payoutEddies: payout,
      status: status ?? "planned",
      occurredAt: occurredAt ? new Date(occurredAt) : null,
    })
    .returning();
  await db.insert(activityEvents).values({
    kind: "mission_logged",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: creditedCharacter
      ? `${req.user!.username} logged mission "${title}" and paid ${creditedCharacter.name} €$${payout}`
      : `${req.user!.username} logged mission "${title}"`,
  });
  res.status(201).json({
    ...m,
    characterName: creditedCharacter?.name ?? null,
    fixerName: req.user!.username,
  });
});

// ===== Cross-character inventory search (fixer/admin) =====
// Lets fixers and admins resolve "who has/had this item?" disputes. Searches
// across all live inventory items by name OR by current/past owner character
// name (matched via the events log). Returns the live item rows plus, for each
// past-owner hit, the matching event so the UI can show "owned by X then sold
// to Y" without a separate per-item drill-in.
router.get("/fixer/inventory-search", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  const owner = String(req.query.owner ?? "").trim();
  if (!q && !owner) {
    res.json({ items: [], pastOwners: [] });
    return;
  }
  // Live items matching name or current-character name.
  const liveConds: ReturnType<typeof ilike>[] = [];
  if (q) liveConds.push(ilike(inventoryItems.name, `%${q}%`));
  if (owner) liveConds.push(ilike(characters.name, `%${owner}%`));
  const live = await db
    .select({
      id: inventoryItems.id,
      instanceUuid: inventoryItems.instanceUuid,
      name: inventoryItems.name,
      category: inventoryItems.category,
      quantity: inventoryItems.quantity,
      characterId: inventoryItems.characterId,
      characterName: characters.name,
      ownerUserId: characters.ownerId,
      ownerUsername: users.username,
      acquiredAt: inventoryItems.acquiredAt,
      createdAt: inventoryItems.createdAt,
    })
    .from(inventoryItems)
    .leftJoin(characters, eq(characters.id, inventoryItems.characterId))
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(liveConds.length === 1 ? liveConds[0] : or(...liveConds))
    .orderBy(desc(inventoryItems.createdAt))
    .limit(200);
  // Past-owner hits via events log (only meaningful when an owner-name search
  // was supplied). Returns the event row plus the live item if it still exists.
  let pastOwners: Array<{ event: typeof inventoryEvents.$inferSelect; liveItem: typeof inventoryItems.$inferSelect | null }> = [];
  if (owner) {
    const matched = await db
      .select()
      .from(inventoryEvents)
      .where(
        or(
          ilike(inventoryEvents.fromCharacterName, `%${owner}%`),
          ilike(inventoryEvents.toCharacterName, `%${owner}%`),
        ),
      )
      .orderBy(desc(inventoryEvents.createdAt))
      .limit(200);
    // Filter further by q on item name, if supplied.
    const filtered = q ? matched.filter((e) => e.itemName.toLowerCase().includes(q.toLowerCase())) : matched;
    const uuids = Array.from(new Set(filtered.map((e) => e.instanceUuid)));
    const liveByUuid = new Map<string, typeof inventoryItems.$inferSelect>();
    if (uuids.length) {
      const rows = await db.select().from(inventoryItems).where(inArray(inventoryItems.instanceUuid, uuids));
      for (const r of rows) liveByUuid.set(r.instanceUuid, r);
    }
    pastOwners = filtered.map((e) => ({ event: e, liveItem: liveByUuid.get(e.instanceUuid) ?? null }));
  }
  res.json({ items: live, pastOwners });
});

export default router;
