import { Router, type IRouter } from "express";
import { eq, and, desc, or, ilike, inArray } from "drizzle-orm";
import { db, fixerNpcs, characters, users, inventoryItems, inventoryEvents } from "@workspace/db";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";

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
