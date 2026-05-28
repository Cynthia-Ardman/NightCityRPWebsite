import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, housing, characters, catalogRent, activityEvents, characterUpdates } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";

function isAdmin(user: { roles: string[] }) {
  return hasRole(user.roles, "ADMIN");
}

const router: IRouter = Router();

type LeaseRow = {
  id: number;
  characterId: number;
  characterName: string;
  listingId: number | null;
  address: string;
  district: string | null;
  tier: string | null;
  monthlyRent: number;
  paidThrough: Date | null;
  notes: string | null;
  createdAt: Date;
};

// End-of-current-month timestamp in UTC. Used to set initial paid_through
// when a lease starts so the first full month is already "paid up" until
// the monthly_rent cron rolls it forward.
function endOfCurrentMonth(now: Date = new Date()): Date {
  // First of next month at 00:00:00 UTC = end of current month exclusive.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function shape(row: LeaseRow): Record<string, unknown> {
  return {
    id: row.id,
    characterId: row.characterId,
    characterName: row.characterName,
    listingId: row.listingId,
    address: row.address,
    district: row.district,
    tier: row.tier,
    monthlyRent: row.monthlyRent,
    paidThrough: row.paidThrough ? row.paidThrough.toISOString() : null,
    notes: row.notes,
    delinquent: !!row.paidThrough && row.paidThrough.getTime() < Date.now(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectLeasesWhere(predicate: ReturnType<typeof and> | ReturnType<typeof eq>) {
  const rows = (await db
    .select({
      id: housing.id,
      characterId: housing.characterId,
      characterName: characters.name,
      listingId: housing.listingId,
      address: housing.address,
      district: catalogRent.district,
      tier: catalogRent.tier,
      monthlyRent: housing.monthlyRent,
      paidThrough: housing.paidThrough,
      notes: housing.notes,
      createdAt: housing.createdAt,
    })
    .from(housing)
    .innerJoin(characters, eq(characters.id, housing.characterId))
    .leftJoin(catalogRent, eq(catalogRent.id, housing.listingId))
    .where(predicate)) as LeaseRow[];
  return rows;
}

router.get("/housing/mine", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.user!.id;
  const rows = await selectLeasesWhere(eq(characters.ownerId, ownerId));
  res.json(rows.map(shape));
});

router.get("/characters/:id/housing", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.id), 10);
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Visibility: own or admin
  if (c.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await selectLeasesWhere(eq(housing.characterId, cid));
  res.json(rows.map(shape));
});

router.post("/housing/lease", requireAuth, async (req, res): Promise<void> => {
  const { catalogRentId, characterId, notes } = req.body ?? {};
  const lid = parseInt(String(catalogRentId), 10);
  const cid = parseInt(String(characterId), 10);
  if (!lid || !cid) {
    res.status(400).json({ error: "catalogRentId and characterId required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.archived) {
    res.status(400).json({ error: "Cannot lease for an archived character" });
    return;
  }
  const [listing] = await db.select().from(catalogRent).where(eq(catalogRent.id, lid));
  if (!listing) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  const address = listing.district ? `${listing.name} — ${listing.district}` : listing.name;
  const [inserted] = await db
    .insert(housing)
    .values({
      characterId: cid,
      listingId: lid,
      address,
      monthlyRent: listing.monthlyRent,
      paidThrough: endOfCurrentMonth(),
      notes: notes ?? null,
    })
    .returning();
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${c.name} leased ${listing.name} (€$${listing.monthlyRent}/mo)`,
  });
  await db.insert(characterUpdates).values({
    characterId: cid,
    authorId: req.user!.id,
    note: `Leased housing: ${listing.name} (€$${listing.monthlyRent.toLocaleString()}/mo)`,
  });
  const [row] = await selectLeasesWhere(eq(housing.id, inserted.id));
  res.status(201).json(shape(row));
});

router.delete("/housing/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [row] = await db
    .select({ h: housing, ownerId: characters.ownerId, characterName: characters.name })
    .from(housing)
    .innerJoin(characters, eq(characters.id, housing.characterId))
    .where(eq(housing.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (row.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(housing).where(eq(housing.id, id));
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${row.characterName} vacated ${row.h.address}`,
  });
  await db.insert(characterUpdates).values({
    characterId: row.h.characterId,
    authorId: req.user!.id,
    note: `Vacated housing: ${row.h.address}`,
  });
  res.sendStatus(204);
});

// suppress unused export warning for sql
void sql;

export default router;
