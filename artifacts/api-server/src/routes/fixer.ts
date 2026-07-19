import { Router, type IRouter } from "express";
import { eq, and, desc, or, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  fixerNpcs,
  characters,
  characterSheets,
  customRequests,
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
  botMissionLog,
  stores,
  ripperdocs,
  vrchatInstanceVisits,
  vrchatInstanceSessions,
  vrchatLinks,
  classifyWalletCategory,
} from "@workspace/db";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import {
  loadCyberwareSlotByName,
  resolveSlotForItem,
  isCappedSlot,
  normalizeSlot,
} from "../lib/cyberwareSlots";

const router: IRouter = Router();

// NPCs now live in the `characters` table with kind='npc' (created via the full
// character-sheet flow at /sheets/new?type=NPC). The standalone fixer_npcs table
// is legacy and empty, which is why this section read blank. Both endpoints now
// project NPC characters into the same response shape the hub already expects.
const npcSelect = {
  id: characters.id,
  name: characters.name,
  archetype: characters.archetype,
  description: characters.background,
  portraitUrl: characters.portraitUrl,
  createdAt: characters.createdAt,
  fixerName: users.username,
  fixerAvatarUrl: users.avatarUrl,
};

function toNpc<T extends Record<string, unknown>>(r: T): T & { district: string | null; contact: string | null } {
  return { ...r, district: null, contact: null };
}

router.get("/fixer/npcs/mine", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const rows = await db
    .select(npcSelect)
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(and(eq(characters.kind, "npc"), eq(characters.ownerId, req.user!.id), eq(characters.archived, false)))
    .orderBy(desc(characters.createdAt));
  res.json(rows.map(toNpc));
});

router.get("/fixer/npcs", requireAuth, requireRole("FIXER"), async (_req, res): Promise<void> => {
  const rows = await db
    .select(npcSelect)
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(and(eq(characters.kind, "npc"), eq(characters.archived, false)))
    .orderBy(desc(characters.createdAt));
  res.json(rows.map(toNpc));
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

  const [auditRows, activityRows, walletRows, missionRows, actorRows, attendRows, storeRows, ripperRows, missionLogRows, draftRows, rejectedRequestRows, checkupRows, medsTxnRows] = await Promise.all([
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
    db.select().from(botMissionLog).where(eq(botMissionLog.userId, userId)),
    db
      .select({
        id: characterSheets.id,
        name: characterSheets.name,
        characterId: characterSheets.characterId,
        status: characterSheets.status,
        createdAt: characterSheets.createdAt,
      })
      .from(characterSheets)
      .where(and(eq(characterSheets.ownerId, userId), eq(characterSheets.status, "draft")))
      .orderBy(desc(characterSheets.createdAt))
      .limit(LIMIT),
    db
      .select({
        id: customRequests.id,
        type: customRequests.type,
        title: customRequests.title,
        description: customRequests.description,
        characterId: customRequests.characterId,
        status: customRequests.status,
        reviewerNote: customRequests.reviewerNote,
        reviewedAt: customRequests.reviewedAt,
        createdAt: customRequests.createdAt,
      })
      .from(customRequests)
      .where(and(eq(customRequests.requestedById, userId), eq(customRequests.status, "rejected")))
      .orderBy(desc(customRequests.createdAt))
      .limit(LIMIT),
    // Ripperdoc checkup history for this player's characters. There's no
    // dedicated checkups table — each visit writes an audit row (action
    // 'checkup', target the character), same source the Ripperdoc Console uses.
    charIds.length
      ? db
          .select({
            id: auditLog.id,
            targetId: auditLog.targetId,
            actorName: auditLog.actorName,
            message: auditLog.message,
            afterJson: auditLog.afterJson,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetType, "character"),
              inArray(auditLog.targetId, charIds.map(String)),
              eq(auditLog.action, "checkup"),
            ),
          )
          .orderBy(desc(auditLog.createdAt))
          .limit(LIMIT)
      : Promise.resolve(
          [] as Array<{
            id: number;
            targetId: string | null;
            actorName: string | null;
            message: string | null;
            afterJson: unknown;
            createdAt: Date | null;
          }>,
        ),
    // Meds / cyberware charge history for this player's characters. Category is
    // stored on newer rows; legacy rows are classified from kind+memo (same rule
    // the Ripperdoc Console medical record uses). Over-fetch then filter, since
    // the category filter can't be fully expressed in SQL for legacy rows.
    // Legacy (bot-era) meds charges are ACCOUNT-level rows: characterId is
    // NULL and only userId points at the player — so match either scope.
    db
      .select({
        id: walletTransactions.id,
        characterId: walletTransactions.characterId,
        amount: walletTransactions.amount,
        kind: walletTransactions.kind,
        memo: walletTransactions.memo,
        category: walletTransactions.category,
        createdAt: walletTransactions.createdAt,
      })
      .from(walletTransactions)
      .where(
        charIds.length
          ? or(eq(walletTransactions.userId, userId), inArray(walletTransactions.characterId, charIds))
          : eq(walletTransactions.userId, userId),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(500),
  ]);

  const medsCharges = medsTxnRows
    .filter((r) => (r.category ?? classifyWalletCategory(r.kind, r.memo)) === "cyberware")
    .slice(0, LIMIT);

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

  // VRChat instance attendance. Identity resolution: exact vrchat_links row
  // for this player's Discord id first, then an unambiguous display-name match
  // against imported visits (VRChat name == portal username/global name).
  const vrchatAttendance = await (async () => {
    let vrchatUserId: string | null = null;
    let vrchatUsername: string | null = null;
    let matchKind: "linked" | "name" | null = null;
    const [link] = await db
      .select({ vrchatUserId: vrchatLinks.vrchatUserId, vrchatUsername: vrchatLinks.vrchatUsername })
      .from(vrchatLinks)
      .where(eq(vrchatLinks.discordId, u.discordId));
    if (link) {
      vrchatUserId = link.vrchatUserId;
      vrchatUsername = link.vrchatUsername;
      matchKind = "linked";
    } else {
      const nameCandidates = [u.username.toLowerCase(), u.globalName?.toLowerCase()].filter(
        (x): x is string => !!x,
      );
      const cands = await db
        .select({
          vrchatUserId: vrchatInstanceVisits.vrchatUserId,
          displayName: sql<string>`(array_agg(${vrchatInstanceVisits.displayName} ORDER BY ${vrchatInstanceVisits.joinedAt} DESC))[1]`,
        })
        .from(vrchatInstanceVisits)
        .where(inArray(sql`lower(${vrchatInstanceVisits.displayName})`, nameCandidates))
        .groupBy(vrchatInstanceVisits.vrchatUserId);
      if (cands.length === 1) {
        vrchatUserId = cands[0].vrchatUserId;
        vrchatUsername = cands[0].displayName;
        matchKind = "name";
      }
    }
    if (!vrchatUserId) return null;
    const visitRows = await db
      .select({
        id: vrchatInstanceVisits.id,
        joinedAt: vrchatInstanceVisits.joinedAt,
        leftAt: vrchatInstanceVisits.leftAt,
        durationMs: vrchatInstanceVisits.durationMs,
        worldName: vrchatInstanceSessions.worldName,
      })
      .from(vrchatInstanceVisits)
      .innerJoin(vrchatInstanceSessions, eq(vrchatInstanceSessions.id, vrchatInstanceVisits.sessionId))
      .where(eq(vrchatInstanceVisits.vrchatUserId, vrchatUserId))
      .orderBy(desc(vrchatInstanceVisits.joinedAt))
      .limit(LIMIT);
    if (visitRows.length === 0 && matchKind === "linked") {
      // Linked but never seen in imported history — still show the identity.
      return { vrchatUserId, vrchatUsername, matchKind, totalVisits: 0, totalHours: 0, visits: [] };
    }
    if (visitRows.length === 0) return null;
    const [agg] = await db
      .select({
        totalVisits: sql<number>`COUNT(*)::int`,
        totalMs: sql<number>`COALESCE(SUM(${vrchatInstanceVisits.durationMs}), 0)::bigint`,
      })
      .from(vrchatInstanceVisits)
      .where(eq(vrchatInstanceVisits.vrchatUserId, vrchatUserId));
    return {
      vrchatUserId,
      vrchatUsername,
      matchKind,
      totalVisits: agg?.totalVisits ?? visitRows.length,
      totalHours: Math.round((Number(agg?.totalMs ?? 0) / 3_600_000) * 10) / 10,
      visits: visitRows.map((v) => ({
        id: v.id,
        worldName: v.worldName,
        joinedAt: v.joinedAt.toISOString(),
        leftAt: v.leftAt ? v.leftAt.toISOString() : null,
        durationMs: v.durationMs,
      })),
    };
  })();

  res.json({
    player: {
      id: u.id,
      username: u.username,
      globalName: u.globalName,
      avatarUrl: u.avatarUrl,
      roles: u.roles,
      lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
    },
    characters: chars.map((c) => ({
      id: c.id,
      name: c.name,
      lifeStatus: c.lifeStatus,
      archived: c.archived,
      claimed: c.claimed,
      lastCheckupAt: c.lastCheckupAt ? c.lastCheckupAt.toISOString() : null,
      checkupStreak: c.checkupStreak,
    })),
    checkups: checkupRows.map((a) => {
      const charId = a.targetId != null ? parseInt(a.targetId, 10) : NaN;
      return {
        id: a.id,
        characterId: Number.isNaN(charId) ? null : charId,
        characterName: Number.isNaN(charId) ? null : charNameById.get(charId) ?? null,
        actorName: a.actorName,
        message: a.message,
        level:
          a.afterJson && typeof a.afterJson === "object" && "cyberwareLevel" in a.afterJson
            ? ((a.afterJson as { cyberwareLevel?: string | null }).cyberwareLevel ?? null)
            : null,
        createdAt: a.createdAt ? a.createdAt.toISOString() : null,
      };
    }),
    medsCharges: medsCharges.map((r) => ({
      id: r.id,
      characterId: r.characterId,
      characterName: r.characterId != null ? charNameById.get(r.characterId) ?? null : null,
      amount: r.amount,
      kind: r.kind,
      memo: r.memo ? r.memo.replace(/^\[legacy-bal:\d+\]\s*/, "") : r.memo,
      createdAt: r.createdAt.toISOString(),
    })),
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
    drafts: draftRows.map((d) => ({
      id: d.id,
      name: d.name,
      characterId: d.characterId,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
    })),
    rejectedRequests: rejectedRequestRows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description,
      characterId: r.characterId,
      status: r.status,
      reviewerNote: r.reviewerNote,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    stores: storeRows.map((s) => ({ id: s.id, name: s.name, kind: s.kind, location: s.location, balance: s.balance, createdAt: s.createdAt.toISOString() })),
    ripperdocs: ripperRows.map((r) => ({ id: r.id, name: r.name, location: r.location, balance: r.balance, createdAt: r.createdAt.toISOString() })),
    historicalAppearances: (() => {
      const row = missionLogRows[0];
      if (!row) return null;
      const dates = Array.isArray(row.missionDates) ? (row.missionDates as string[]) : [];
      return {
        count: row.missionCount,
        dates,
        username: row.username ?? null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      };
    })(),
    vrchatAttendance,
  });
});

// ---------------------------------------------------------------------------
// VRChat attendance lookup (fixer/admin).
//
// Per-player instance visits come from VRCX gamelog imports
// (vrchat_instance_visits). Portal identity resolution is two-tier:
//   1. exact: vrchat_links (self-service #vrchat-username channel scan)
//   2. name match: lower(display_name) equals the portal username/global name
// ---------------------------------------------------------------------------

/** Resolve portal users for a set of VRChat players (exact link first, then name). */
async function resolvePortalUsers(
  players: Array<{ vrchatUserId: string; displayName: string }>,
): Promise<Map<string, { userId: string; username: string; globalName: string | null; matchKind: "linked" | "name" }>> {
  const out = new Map<string, { userId: string; username: string; globalName: string | null; matchKind: "linked" | "name" }>();
  if (players.length === 0) return out;
  const ids = [...new Set(players.map((p) => p.vrchatUserId))];
  const links = await db
    .select({
      vrchatUserId: vrchatLinks.vrchatUserId,
      userId: users.id,
      username: users.username,
      globalName: users.globalName,
    })
    .from(vrchatLinks)
    .innerJoin(users, eq(users.discordId, vrchatLinks.discordId))
    .where(inArray(vrchatLinks.vrchatUserId, ids));
  // A VRChat account claimed by more than one distinct portal user is
  // ambiguous — never attribute it to anyone (no last-write-wins).
  const linksByVrchatId = new Map<string, (typeof links)[number][]>();
  for (const l of links) {
    const arr = linksByVrchatId.get(l.vrchatUserId) ?? [];
    arr.push(l);
    linksByVrchatId.set(l.vrchatUserId, arr);
  }
  const ambiguous = new Set<string>();
  for (const [vrchatUserId, ls] of linksByVrchatId) {
    if (new Set(ls.map((l) => l.userId)).size === 1) {
      const l = ls[0];
      out.set(vrchatUserId, { userId: l.userId, username: l.username, globalName: l.globalName, matchKind: "linked" });
    } else {
      ambiguous.add(vrchatUserId);
    }
  }
  // Ambiguously-linked accounts must not fall through to name matching either.
  const unresolved = players.filter((p) => !out.has(p.vrchatUserId) && !ambiguous.has(p.vrchatUserId));
  const names = [...new Set(unresolved.map((p) => p.displayName.toLowerCase()))].filter(Boolean);
  if (names.length > 0) {
    const matches = await db
      .select({ id: users.id, username: users.username, globalName: users.globalName })
      .from(users)
      .where(or(inArray(sql`lower(${users.username})`, names), inArray(sql`lower(${users.globalName})`, names)));
    const byName = new Map<string, (typeof matches)[number][]>();
    for (const m of matches) {
      for (const key of [m.username.toLowerCase(), m.globalName?.toLowerCase()]) {
        if (!key) continue;
        const arr = byName.get(key) ?? [];
        arr.push(m);
        byName.set(key, arr);
      }
    }
    for (const p of unresolved) {
      const cands = byName.get(p.displayName.toLowerCase());
      // Only accept an unambiguous single-user name match.
      if (cands && new Set(cands.map((c) => c.id)).size === 1) {
        const m = cands[0];
        out.set(p.vrchatUserId, { userId: m.id, username: m.username, globalName: m.globalName, matchKind: "name" });
      }
    }
  }
  return out;
}

// GET /fixer/vrchat/players?q= — search VRChat players seen in imported
// instance history by display name; each row aggregates their visits and
// carries the linked portal user when one can be resolved.
router.get("/fixer/vrchat/players", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  const like = q ? `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
  const rows = await db
    .select({
      vrchatUserId: vrchatInstanceVisits.vrchatUserId,
      // Latest display name wins (players rename).
      displayName: sql<string>`(array_agg(${vrchatInstanceVisits.displayName} ORDER BY ${vrchatInstanceVisits.joinedAt} DESC))[1]`,
      visitCount: sql<number>`COUNT(*)::int`,
      totalMs: sql<number>`COALESCE(SUM(${vrchatInstanceVisits.durationMs}), 0)::bigint`,
      firstSeenAt: sql<string>`MIN(${vrchatInstanceVisits.joinedAt})`,
      lastSeenAt: sql<string>`MAX(${vrchatInstanceVisits.joinedAt})`,
    })
    .from(vrchatInstanceVisits)
    .where(like ? sql`${vrchatInstanceVisits.displayName} ILIKE ${like}` : sql`TRUE`)
    .groupBy(vrchatInstanceVisits.vrchatUserId)
    .orderBy(sql`SUM(${vrchatInstanceVisits.durationMs}) DESC`)
    .limit(50);

  const portal = await resolvePortalUsers(rows);
  res.json(
    rows.map((r) => {
      const p = portal.get(r.vrchatUserId);
      return {
        vrchatUserId: r.vrchatUserId,
        displayName: r.displayName,
        visitCount: r.visitCount,
        totalHours: Math.round((Number(r.totalMs) / 3_600_000) * 10) / 10,
        firstSeenAt: new Date(r.firstSeenAt).toISOString(),
        lastSeenAt: new Date(r.lastSeenAt).toISOString(),
        portalUser: p
          ? { userId: p.userId, username: p.username, globalName: p.globalName, matchKind: p.matchKind }
          : null,
      };
    }),
  );
});

// GET /fixer/vrchat/players/:vrchatUserId/visits — every imported instance
// visit for one VRChat player, newest first, with world/session context.
router.get("/fixer/vrchat/players/:vrchatUserId/visits", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const vrchatUserId = String(req.params.vrchatUserId);
  const rows = await db
    .select({
      id: vrchatInstanceVisits.id,
      sessionId: vrchatInstanceVisits.sessionId,
      displayName: vrchatInstanceVisits.displayName,
      joinedAt: vrchatInstanceVisits.joinedAt,
      leftAt: vrchatInstanceVisits.leftAt,
      durationMs: vrchatInstanceVisits.durationMs,
      worldName: vrchatInstanceSessions.worldName,
      location: vrchatInstanceSessions.location,
      accessType: vrchatInstanceSessions.accessType,
      sessionFirstSeenAt: vrchatInstanceSessions.firstSeenAt,
    })
    .from(vrchatInstanceVisits)
    .innerJoin(vrchatInstanceSessions, eq(vrchatInstanceSessions.id, vrchatInstanceVisits.sessionId))
    .where(eq(vrchatInstanceVisits.vrchatUserId, vrchatUserId))
    .orderBy(desc(vrchatInstanceVisits.joinedAt))
    .limit(500);
  res.json(
    rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      displayName: r.displayName,
      joinedAt: r.joinedAt.toISOString(),
      leftAt: r.leftAt ? r.leftAt.toISOString() : null,
      durationMs: r.durationMs,
      worldName: r.worldName,
      accessType: r.accessType,
      sessionDate: r.sessionFirstSeenAt.toISOString(),
    })),
  );
});

// Cyberware slot-cap violators (fixer/admin). Lists player characters holding
// more than one cyberware item in a single CAPPED slot. Miscellaneous, Custom
// and unresolved-slot chrome are uncapped and never flagged; NPCs are exempt.
// Permanent staff page — recomputed live from current inventory each load.
router.get(
  "/fixer/cyberware-violations",
  requireAuth,
  requireAnyRole(["FIXER", "ADMIN"]),
  async (_req, res): Promise<void> => {
    const catalogByName = await loadCyberwareSlotByName();
    const rows = await db
      .select({
        itemId: inventoryItems.id,
        itemName: inventoryItems.name,
        notes: inventoryItems.notes,
        characterId: inventoryItems.characterId,
        characterName: characters.name,
        characterKind: characters.kind,
        ownerUsername: users.username,
      })
      .from(inventoryItems)
      .innerJoin(characters, eq(characters.id, inventoryItems.characterId))
      .leftJoin(users, eq(users.id, characters.ownerId))
      .where(sql`lower(trim(${inventoryItems.category})) = 'cyberware'`);

    // Group capped-slot items by character + normalized slot.
    type SlotBucket = { slot: string; items: Array<{ id: number; name: string }> };
    const byChar = new Map<
      number,
      { characterId: number; characterName: string; ownerUsername: string | null; slots: Map<string, SlotBucket> }
    >();
    for (const r of rows) {
      if (r.characterId == null || r.characterKind === "npc") continue;
      const slot = resolveSlotForItem({ name: r.itemName, notes: r.notes }, catalogByName);
      if (!isCappedSlot(slot)) continue;
      const key = normalizeSlot(slot);
      let entry = byChar.get(r.characterId);
      if (!entry) {
        entry = {
          characterId: r.characterId,
          characterName: r.characterName,
          ownerUsername: r.ownerUsername,
          slots: new Map(),
        };
        byChar.set(r.characterId, entry);
      }
      let bucket = entry.slots.get(key);
      if (!bucket) {
        // Use the first-seen RAW slot string for a readable label.
        bucket = { slot, items: [] };
        entry.slots.set(key, bucket);
      }
      bucket.items.push({ id: r.itemId, name: r.itemName });
    }

    const violations = Array.from(byChar.values())
      .map((entry) => ({
        characterId: entry.characterId,
        characterName: entry.characterName,
        ownerUsername: entry.ownerUsername,
        slots: Array.from(entry.slots.values())
          .filter((b) => b.items.length > 1)
          .map((b) => ({ slot: b.slot, count: b.items.length, items: b.items })),
      }))
      .filter((v) => v.slots.length > 0)
      .sort((a, b) => a.characterName.localeCompare(b.characterName));

    res.json(violations);
  },
);

export default router;
