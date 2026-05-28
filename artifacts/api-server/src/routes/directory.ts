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
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import { hasRole } from "../lib/discord";

const router: IRouter = Router();

// Character sheets contain IC backstory, contacts, and chrome loadouts that
// players and staff have agreed should NOT be visible to the wider community.
// Visibility rules:
//   - The list endpoint is a roster tool for canon enforcement — fixers and
//     admins only.
//   - A given sheet's detail is viewable by its owner (so a player can read
//     their own claimed dossier from the archive route), plus fixers and
//     admins. Everyone else gets 403, including other logged-in players.
// Stores, ripperdocs, and the gun/cyberware/rent catalogs remain public.

// Strip internal `[legacy:<uuid>]` tags that the prod importer stamps into
// background. They are mapping anchors, not story content.
function cleanBackground(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s.replace(/\[legacy:[^\]]+\]/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

// Roster of all character sheets. Fixers and admins only — used to enforce
// canon, resolve claims, and run mission paperwork. Regular players see
// their own characters under /characters, not here.
router.get("/directory/characters", requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const scope = typeof req.query.scope === "string" ? req.query.scope : "all";

  const conds = [] as Array<ReturnType<typeof eq>>;
  if (q.length > 0) {
    // Match against character name, the legacy Discord handle stamped at import,
    // and (via the users join below) the current owner's username/globalName so
    // operators can find a sheet by either the IC name or the player.
    const like = `%${q}%`;
    conds.push(
      or(
        ilike(characters.name, like),
        ilike(characters.legacyDiscordUsername, like),
        ilike(users.username, like),
        ilike(users.globalName, like),
      ) as unknown as ReturnType<typeof eq>,
    );
  }
  if (scope === "active") conds.push(eq(characters.archived, false));
  else if (scope === "retired") conds.push(eq(characters.archived, true));
  else if (scope === "unclaimed") conds.push(isNull(characters.ownerId) as unknown as ReturnType<typeof eq>);
  else if (scope === "pc") conds.push(eq(characters.kind, "pc"));
  else if (scope === "npc") conds.push(eq(characters.kind, "npc"));

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
    .limit(2000);

  res.json(rows);
});

router.get("/directory/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // We need ownerId for the access check, but it must NOT leak to the client
  // — pull it into a separate variable and return the same explicit
  // projection as before.
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
      ownerId: characters.ownerId,
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
  const me = req.user!;
  const isStaff = hasRole(me.roles, "ADMIN") || hasRole(me.roles, "FIXER");
  const isOwner = row.ownerId !== null && row.ownerId === me.id;
  if (!isStaff && !isOwner) {
    res.status(403).json({ error: "Character sheets are visible only to the owner, fixers, and admins" });
    return;
  }
  const { ownerId: _ownerId, ...safe } = row;
  res.json({ ...safe, background: cleanBackground(safe.background) });
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
