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
//   - The list endpoint returns ONLY roster metadata (name, kind, archetype,
//     portrait, claim/retired flags, owner handle). It does not include any
//     sheet body fields. Any authenticated user may query it, because the
//     character picker for wallet/inventory transfers, store/clinic sells,
//     and fixer missions all need to look up a recipient character by name.
//   - A given sheet's detail (background, sheetData, stats images, …) is
//     viewable only by its owner, fixers, and admins. Everyone else who
//     clicks through from the roster gets 403.
//   - Anonymous (unauthenticated) callers cannot hit either endpoint.
// Stores, ripperdocs, and the gun/cyberware/rent catalogs remain public.

// Strip internal `[legacy:<uuid>]` tags that the prod importer stamps into
// background. They are mapping anchors, not story content.
function cleanBackground(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s.replace(/\[legacy:[^\]]+\]/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

// Roster of all character sheets. Auth-only so anonymous scrapers can't
// crawl the player list, but open to any logged-in player — every recipient
// picker in the portal (transfers, sells, missions) calls this. The
// projection below is strictly roster-tile fields; no sheet body leaks here.
router.get("/directory/characters", requireAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const scope = typeof req.query.scope === "string" ? req.query.scope : "all";
  const mode = req.query.mode === "content" ? "content" : "name";
  // Tag filter accepted as a comma-separated query string. Empty entries are
  // ignored. An empty list = no tag filter applied.
  const tagsRaw = typeof req.query.tags === "string" ? req.query.tags : "";
  const tagList = tagsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const conds = [] as Array<ReturnType<typeof eq>>;
  if (q.length > 0) {
    // Default ("name" mode) matches character name, the legacy Discord handle
    // stamped at import, and (via the users join below) the current owner's
    // username/globalName so operators can find a sheet by either the IC
    // name or the player. "content" mode additionally searches the sheet
    // body text (background + every section), so a player can find every
    // character that mentions "Arasaka" or any other in-fiction term.
    const like = `%${q}%`;
    const clauses = [
      ilike(characters.name, like),
      ilike(characters.legacyDiscordUsername, like),
      ilike(users.username, like),
      ilike(users.globalName, like),
    ];
    if (mode === "content") {
      clauses.push(ilike(characters.background, like));
      clauses.push(ilike(characters.archetype, like));
      // sheet_data is jsonb of { preamble, sections: { label: body } }.
      // Cast to text and ILIKE — fine for a <500-row roster and avoids
      // having to teach Postgres FTS the cyberpunk vocabulary.
      clauses.push(
        sql`${characters.sheetData}::text ILIKE ${like}` as unknown as ReturnType<typeof eq>,
      );
    }
    conds.push(or(...clauses) as unknown as ReturnType<typeof eq>);
  }
  if (scope === "active") conds.push(eq(characters.archived, false));
  else if (scope === "retired") conds.push(eq(characters.archived, true));
  else if (scope === "unclaimed") conds.push(isNull(characters.ownerId) as unknown as ReturnType<typeof eq>);
  else if (scope === "pc") conds.push(eq(characters.kind, "pc"));
  else if (scope === "npc") conds.push(eq(characters.kind, "npc"));

  if (tagList.length > 0) {
    // Postgres array overlap: returns characters tagged with ANY of the
    // requested tags. "Solo OR Netrunner" is a more useful filter than
    // "Solo AND Netrunner" for a multi-faceted archive — players almost
    // never want the intersection.
    conds.push(
      sql`${characters.appliedTags} && ${tagList}::text[]` as unknown as ReturnType<typeof eq>,
    );
  }

  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      portraitUrl: characters.portraitUrl,
      claimed: characters.claimed,
      archived: characters.archived,
      lifeStatus: characters.lifeStatus,
      legacyDiscordUsername: characters.legacyDiscordUsername,
      ownerName: users.username,
      appliedTags: characters.appliedTags,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(characters.createdAt))
    .limit(2000);

  res.json(rows);
});

// Distinct tag names across the whole archive, so the filter UI can render
// chips without each client having to derive the union from a 2000-row list.
router.get("/directory/character-tags", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.execute<{ tag: string }>(
    sql`SELECT DISTINCT unnest(applied_tags) AS tag
        FROM characters
        WHERE array_length(applied_tags, 1) > 0
        ORDER BY tag`,
  );
  res.json(rows.rows.map((r) => r.tag));
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
      lifeStatus: characters.lifeStatus,
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

// Drafts are work-in-progress catalog entries the fixer team is curating
// before they go public. Public/anonymous callers and regular players never
// see draft rows; only ADMIN/FIXER do. Anything else (live, retired, null
// status) is treated as visible.
router.get("/catalog/guns", async (req, res): Promise<void> => {
  const all = await db.select().from(catalogGuns);
  const isStaff =
    !!req.user && (hasRole(req.user.roles, "ADMIN") || hasRole(req.user.roles, "FIXER"));
  res.json(isStaff ? all : all.filter((g) => (g.status ?? "").toLowerCase() !== "draft"));
});

// Fixer/admin can promote a draft to live (or back to draft). Kept minimal
// for now: just the status flip; full editor can follow.
router.patch(
  "/catalog/guns/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as { status?: string | null };
    if (body.status === undefined) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const nextStatus = body.status == null ? null : String(body.status).toLowerCase();
    if (nextStatus !== null && !["draft", "live", "retired"].includes(nextStatus)) {
      res.status(400).json({ error: "status must be draft|live|retired|null" });
      return;
    }
    const [updated] = await db
      .update(catalogGuns)
      .set({ status: nextStatus })
      .where(eq(catalogGuns.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Gun not found" });
      return;
    }
    res.json(updated);
  },
);
router.get("/catalog/cyberware", async (_req, res): Promise<void> => {
  res.json(await db.select().from(catalogCyberware));
});
router.get("/catalog/rent", async (_req, res): Promise<void> => {
  res.json(await db.select().from(catalogRent));
});

export default router;
