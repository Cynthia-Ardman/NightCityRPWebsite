import { Router, type IRouter } from "express";
import { eq, and, desc, or, ilike, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  fixerNpcs,
  characters,
  users,
  inventoryItems,
  inventoryEvents,
  auditLog,
  activityEvents,
  walletTransactions,
  missions,
  missionAssignments,
  missionActorPayments,
  attendanceClaims,
  stores,
  ripperdocs,
} from "@workspace/db";
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
  // Scope to the requesting fixer — NPCs are private to the fixer that created
  // them, so a fixer must not be able to read another fixer's roster by id.
  // (Mirrors the ownership filter already used by the PATCH route below.)
  const [n] = await db
    .select()
    .from(fixerNpcs)
    .where(and(eq(fixerNpcs.id, id), eq(fixerNpcs.fixerId, req.user!.id)));
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

// Player lookup search (fixer/admin). Matches players by username / global
// name, or by the name of any character they currently own. Returns a small
// list with the owned-character names for disambiguation.
router.get("/fixer/players", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json([]);
    return;
  }
  const like = `%${q}%`;
  const directUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(or(ilike(users.username, like), ilike(users.globalName, like)))
    .limit(50);
  const charOwners = await db
    .select({ ownerId: characters.ownerId })
    .from(characters)
    .where(and(ilike(characters.name, like), isNotNull(characters.ownerId)))
    .limit(200);
  const idSet = new Set<string>();
  for (const u of directUsers) idSet.add(u.id);
  for (const c of charOwners) if (c.ownerId) idSet.add(c.ownerId);
  const ids = Array.from(idSet);
  if (ids.length === 0) {
    res.json([]);
    return;
  }
  const userRows = await db.select().from(users).where(inArray(users.id, ids));
  const charRows = await db
    .select({ id: characters.id, name: characters.name, ownerId: characters.ownerId })
    .from(characters)
    .where(inArray(characters.ownerId, ids));
  const charsByOwner = new Map<string, string[]>();
  for (const c of charRows) {
    if (!c.ownerId) continue;
    const list = charsByOwner.get(c.ownerId) ?? [];
    list.push(c.name);
    charsByOwner.set(c.ownerId, list);
  }
  const results = userRows
    .map((u) => ({
      id: u.id,
      username: u.username,
      globalName: u.globalName,
      avatarUrl: u.avatarUrl,
      roles: u.roles,
      characterNames: charsByOwner.get(u.id) ?? [],
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
  res.json(results);
});

// Aggregated read-only activity profile for one player (fixer/admin). Gathers
// audit-log edits, attendance/mission participation, wallet transactions,
// owned stores/ripperdocs, and notable activity events into one response so a
// fixer can audit everything a player has done from a single page.
router.get("/fixer/players/:userId/activity", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const LIMIT = 200;
  const chars = await db.select().from(characters).where(eq(characters.ownerId, userId));
  const charIds = chars.map((c) => c.id);
  const charNameById = new Map(chars.map((c) => [c.id, c.name]));

  const [auditRows, activityRows, walletRows, missionRows, actorRows, attendRows, storeRows, ripperRows] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        category: auditLog.category,
        action: auditLog.action,
        message: auditLog.message,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.actorId, userId))
      .orderBy(desc(auditLog.createdAt))
      .limit(LIMIT),
    db
      .select({ id: activityEvents.id, kind: activityEvents.kind, message: activityEvents.message, createdAt: activityEvents.createdAt })
      .from(activityEvents)
      .where(eq(activityEvents.actorId, userId))
      .orderBy(desc(activityEvents.createdAt))
      .limit(LIMIT),
    db
      .select({
        id: walletTransactions.id,
        characterId: walletTransactions.characterId,
        amount: walletTransactions.amount,
        kind: walletTransactions.kind,
        memo: walletTransactions.memo,
        source: walletTransactions.source,
        counterpartyName: walletTransactions.counterpartyName,
        counterpartyCharacterId: walletTransactions.counterpartyCharacterId,
        storeId: walletTransactions.storeId,
        ripperdocId: walletTransactions.ripperdocId,
        createdAt: walletTransactions.createdAt,
      })
      .from(walletTransactions)
      .where(
        charIds.length
          ? or(eq(walletTransactions.userId, userId), inArray(walletTransactions.characterId, charIds))
          : eq(walletTransactions.userId, userId),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(LIMIT),
    db
      .select({
        id: missionAssignments.id,
        missionId: missionAssignments.missionId,
        missionTitle: missions.title,
        missionStartAt: missions.startAt,
        characterId: missionAssignments.characterId,
        attendanceCreditedAt: missionAssignments.attendanceCreditedAt,
        paymentStatus: missionAssignments.paymentStatus,
        payAmount: missionAssignments.payAmount,
        paidAt: missionAssignments.paidAt,
        createdAt: missionAssignments.createdAt,
      })
      .from(missionAssignments)
      .leftJoin(missions, eq(missions.id, missionAssignments.missionId))
      .where(eq(missionAssignments.userId, userId))
      .orderBy(desc(missionAssignments.createdAt))
      .limit(LIMIT),
    db
      .select({
        id: missionActorPayments.id,
        missionId: missionActorPayments.missionId,
        missionName: missionActorPayments.missionName,
        eventType: missionActorPayments.eventType,
        characterName: missionActorPayments.characterName,
        fixerName: missionActorPayments.fixerName,
        amount: missionActorPayments.amount,
        paymentStatus: missionActorPayments.paymentStatus,
        missionDate: missionActorPayments.missionDate,
        paidAt: missionActorPayments.paidAt,
        createdAt: missionActorPayments.createdAt,
      })
      .from(missionActorPayments)
      .where(eq(missionActorPayments.userId, userId))
      .orderBy(desc(missionActorPayments.createdAt))
      .limit(LIMIT),
    db
      .select({ id: attendanceClaims.id, weekStart: attendanceClaims.weekStart, amount: attendanceClaims.amount, claimedAt: attendanceClaims.claimedAt })
      .from(attendanceClaims)
      .where(eq(attendanceClaims.userId, userId))
      .orderBy(desc(attendanceClaims.claimedAt))
      .limit(LIMIT),
    db.select().from(stores).where(eq(stores.ownerId, userId)).orderBy(desc(stores.createdAt)),
    db.select().from(ripperdocs).where(eq(ripperdocs.ownerId, userId)).orderBy(desc(ripperdocs.createdAt)),
  ]);

  // Resolve counterparty venue names for wallet transactions that reference a
  // store/ripperdoc the player interacted with (the counterparty may be a venue
  // they don't own, so we can't rely on storeRows/ripperRows above).
  const txStoreIds = [...new Set(walletRows.map((r) => r.storeId).filter((v): v is number => v != null))];
  const txRipperIds = [...new Set(walletRows.map((r) => r.ripperdocId).filter((v): v is number => v != null))];
  const [txStoreRows, txRipperRows] = await Promise.all([
    txStoreIds.length
      ? db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, txStoreIds))
      : Promise.resolve([] as { id: number; name: string }[]),
    txRipperIds.length
      ? db.select({ id: ripperdocs.id, name: ripperdocs.name }).from(ripperdocs).where(inArray(ripperdocs.id, txRipperIds))
      : Promise.resolve([] as { id: number; name: string }[]),
  ]);
  const storeNameById = new Map(txStoreRows.map((s) => [s.id, s.name]));
  const ripperNameById = new Map(txRipperRows.map((r) => [r.id, r.name]));

  // Resolve counterparty character names for player-to-player transfers. The
  // counterparty is usually not one of this player's own characters, so we can't
  // rely on charNameById.
  const txCounterpartyCharIds = [
    ...new Set(walletRows.map((r) => r.counterpartyCharacterId).filter((v): v is number => v != null)),
  ];
  const txCounterpartyCharRows = txCounterpartyCharIds.length
    ? await db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, txCounterpartyCharIds))
    : ([] as { id: number; name: string }[]);
  const counterpartyCharNameById = new Map(txCounterpartyCharRows.map((c) => [c.id, c.name]));

  res.json({
    player: {
      id: u.id,
      username: u.username,
      globalName: u.globalName,
      avatarUrl: u.avatarUrl,
      roles: u.roles,
      lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
    },
    characters: chars.map((c) => ({ id: c.id, name: c.name, lifeStatus: c.lifeStatus, archived: c.archived, claimed: c.claimed })),
    auditEntries: auditRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    activityEvents: activityRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    walletTransactions: walletRows.map((r) => {
      // A transaction can reference a counterparty venue (store/ripperdoc). Surface
      // its kind/id/name so the UI can link straight to that venue's detail page.
      const counterpartyVenueKind = r.storeId != null ? "store" : r.ripperdocId != null ? "ripperdoc" : null;
      const counterpartyVenueId = r.storeId ?? r.ripperdocId ?? null;
      const counterpartyVenueName =
        r.storeId != null
          ? storeNameById.get(r.storeId) ?? null
          : r.ripperdocId != null
            ? ripperNameById.get(r.ripperdocId) ?? null
            : null;
      return {
        id: r.id,
        characterId: r.characterId,
        characterName: r.characterId != null ? charNameById.get(r.characterId) ?? null : null,
        amount: r.amount,
        kind: r.kind,
        memo: r.memo,
        source: r.source,
        counterpartyName: r.counterpartyName,
        counterpartyCharacterId: r.counterpartyCharacterId,
        counterpartyCharacterName:
          r.counterpartyCharacterId != null ? counterpartyCharNameById.get(r.counterpartyCharacterId) ?? null : null,
        counterpartyVenueKind,
        counterpartyVenueId,
        counterpartyVenueName,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    missions: missionRows.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      missionTitle: r.missionTitle ?? null,
      missionStartAt: r.missionStartAt ? r.missionStartAt.toISOString() : null,
      characterName: r.characterId != null ? charNameById.get(r.characterId) ?? null : null,
      attendanceCreditedAt: r.attendanceCreditedAt ? r.attendanceCreditedAt.toISOString() : null,
      paymentStatus: r.paymentStatus,
      payAmount: r.payAmount,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    actorPayments: actorRows.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      missionName: r.missionName,
      eventType: r.eventType,
      characterName: r.characterName,
      fixerName: r.fixerName,
      amount: r.amount,
      paymentStatus: r.paymentStatus,
      missionDate: r.missionDate ? r.missionDate.toISOString() : null,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    attendanceClaims: attendRows.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      amount: r.amount,
      claimedAt: r.claimedAt.toISOString(),
    })),
    stores: storeRows.map((s) => ({ id: s.id, name: s.name, kind: s.kind, location: s.location, balance: s.balance, createdAt: s.createdAt.toISOString() })),
    ripperdocs: ripperRows.map((r) => ({ id: r.id, name: r.name, location: r.location, balance: r.balance, createdAt: r.createdAt.toISOString() })),
  });
});

export default router;
