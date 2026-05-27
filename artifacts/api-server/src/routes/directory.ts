import { Router, type IRouter } from "express";
import { eq, and, or, ilike, isNull, desc, sql } from "drizzle-orm";
import {
  db,
  ripperdocs,
  stores,
  ripperdocEmployees,
  storeEmployees,
  characters,
  users,
  catalogGuns,
  catalogCyberware,
  catalogRent,
} from "@workspace/db";

const router: IRouter = Router();

// Public character directory: anyone (even unauthenticated visitors) can
// browse the imported sheets. The list endpoint supports a simple name
// filter and a scope filter (all / active / retired / unclaimed).
router.get("/directory/characters", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const scope = typeof req.query.scope === "string" ? req.query.scope : "all";

  const conds = [] as Array<ReturnType<typeof eq>>;
  if (q.length > 0) conds.push(ilike(characters.name, `%${q}%`) as unknown as ReturnType<typeof eq>);
  if (scope === "active") conds.push(eq(characters.archived, false));
  else if (scope === "retired") conds.push(eq(characters.archived, true));
  else if (scope === "unclaimed") conds.push(isNull(characters.ownerId) as unknown as ReturnType<typeof eq>);

  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      portraitUrl: characters.portraitUrl,
      claimed: characters.claimed,
      archived: characters.archived,
      legacyDiscordUsername: characters.legacyDiscordUsername,
      ownerName: users.username,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(characters.createdAt))
    .limit(500);

  res.json(rows);
});

router.get("/directory/characters/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Explicit projection only — never spread the full row. Internal fields
  // like ownerId, discordChannelId, importedFromThreadId, approval flags,
  // and timestamps must not leak through the public endpoint.
  const [row] = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      background: characters.background,
      portraitUrl: characters.portraitUrl,
      portraitUrls: characters.portraitUrls,
      statsImageUrls: characters.statsImageUrls,
      sheetData: characters.sheetData,
      claimed: characters.claimed,
      archived: characters.archived,
      legacyDiscordUsername: characters.legacyDiscordUsername,
      importedFromChannelName: characters.importedFromChannelName,
      ownerName: users.username,
      ownerAvatarUrl: users.avatarUrl,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(eq(characters.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.get("/directory/ripperdocs", async (_req, res): Promise<void> => {
  const rows = await db.select().from(ripperdocs);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, location: r.location, description: r.description, bannerUrl: r.bannerUrl })));
});

router.get("/directory/ripperdocs/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, id));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const emps = await db
    .select({ id: ripperdocEmployees.id, characterId: characters.id, name: characters.name, role: ripperdocEmployees.role })
    .from(ripperdocEmployees)
    .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
    .where(eq(ripperdocEmployees.ripperdocId, id));
  res.json({
    id: r.id,
    name: r.name,
    location: r.location,
    description: r.description,
    bannerUrl: r.bannerUrl,
    employees: emps,
  });
});

router.get("/directory/stores", async (_req, res): Promise<void> => {
  const rows = await db.select().from(stores);
  res.json(rows.map((s) => ({ id: s.id, name: s.name, kind: s.kind, location: s.location, description: s.description, bannerUrl: s.bannerUrl })));
});

router.get("/directory/stores/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(stores).where(eq(stores.id, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const emps = await db
    .select({ id: storeEmployees.id, characterId: characters.id, name: characters.name, role: storeEmployees.role })
    .from(storeEmployees)
    .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
    .where(eq(storeEmployees.storeId, id));
  res.json({
    id: s.id,
    name: s.name,
    kind: s.kind,
    location: s.location,
    description: s.description,
    bannerUrl: s.bannerUrl,
    employees: emps,
  });
});

router.get("/catalog/guns", async (_req, res): Promise<void> => {
  res.json(await db.select().from(catalogGuns));
});
router.get("/catalog/cyberware", async (_req, res): Promise<void> => {
  res.json(await db.select().from(catalogCyberware));
});
router.get("/catalog/rent", async (_req, res): Promise<void> => {
  res.json(await db.select().from(catalogRent));
});

export default router;
