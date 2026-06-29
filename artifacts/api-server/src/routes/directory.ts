import { Router, type IRouter } from "express";
import { eq, ne, and, or, ilike, isNull, isNotNull, desc, asc, sql, arrayOverlaps, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  ripperdocs,
  stores,
  ripperdocEmployees,
  storeEmployees,
  characters,
  characterUpdates,
  activityEvents,
  auditLog,
  users,
  vrchatLinks,
  catalogGuns,
  catalogCyberware,
  catalogRent,
  catalogDistricts,
  characterTagOptions,
  housing,
  customRequests,
  inventoryItems,
} from "@workspace/db";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import { hasRole, addGuildMemberRole, RIPPERDOC_ROLE_ID } from "../lib/discord";
import { sumCwpByCharacter } from "../lib/cyberware";
import { deriveCyberwareBand } from "../lib/jobs";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { loadReservedListingIds } from "../lib/listingReservations";

const router: IRouter = Router();

// ---- Tag helpers -----------------------------------------------------------
// The archive presents ONE merged tag list, but storage is split:
//   - appliedTags  : owned by the Discord importer (overwritten on re-sync)
//   - manualTags   : owned by staff via the archive UI (never touched by import)
// Display/filter = the case-insensitive union of the two, preserving the first
// occurrence's casing (applied tags win the casing tie since they list first).
function normalizeTag(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}
function mergeTags(applied: string[] | null, manual: string[] | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...(applied ?? []), ...(manual ?? [])]) {
    const norm = normalizeTag(t);
    if (norm.length === 0) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}
// Split a desired merged tag set back into the two storage columns. Tags that
// already exist on the Discord-synced list stay there (so we don't duplicate
// them into manualTags); everything else becomes a manual tag. A tag the user
// removed simply won't appear in `desired`, so it drops from whichever column
// held it. NOTE: removing a Discord-origin tag here only suppresses it until
// the next import re-derives appliedTags from the live thread.
function splitDesiredTags(
  desired: string[],
  currentApplied: string[] | null,
): { applied: string[]; manual: string[] } {
  const desiredMerged = mergeTags(desired, []);
  const appliedLower = new Set((currentApplied ?? []).map((t) => normalizeTag(t).toLowerCase()));
  const applied: string[] = [];
  const manual: string[] = [];
  for (const t of desiredMerged) {
    if (appliedLower.has(t.toLowerCase())) applied.push(t);
    else manual.push(t);
  }
  return { applied, manual };
}

// ---- CWP / cyberware band helpers -----------------------------------------
// The card shows a single "band": Organic, or the chrome load (None / Medium /
// High / Extreme). The chrome load is NOT stored on the character — it is
// derived live from the character's installed cyberware (sum of "CWP n" across
// inventory_items, category=cyberware), exactly like the dashboard / billing
// cron via deriveCyberwareBand (0-6 none · 7-9 medium · 10-12 high · 13+ extreme).
// The legacy cyberwareLevel column was never populated from real chrome, so
// reading it made every character show "None"; we only honour it as an explicit
// staff override (medium/high/extreme). Organic wins outright.
type CwpBand = "organic" | "none" | "medium" | "high" | "extreme";
const CWP_BANDS: readonly CwpBand[] = ["organic", "none", "medium", "high", "extreme"];
const OVERRIDE_BANDS: readonly string[] = ["medium", "high", "extreme"];
// Legacy/column-only band: organic flag + the stored cyberwareLevel string. Used
// for audit before/after snapshots where we report exactly what the column held.
function deriveCwpBand(isOrganic: boolean | null, cyberwareLevel: string | null): CwpBand {
  if (isOrganic) return "organic";
  const lvl = (cyberwareLevel ?? "none").toLowerCase();
  return (CWP_BANDS as readonly string[]).includes(lvl) && lvl !== "organic" ? (lvl as CwpBand) : "none";
}
// Display band: organic wins; an explicit staff override on the column wins next;
// otherwise derive from the character's real installed-chrome CWP total.
function resolveBand(
  isOrganic: boolean | null,
  cyberwareLevel: string | null,
  chromeCount: number,
): CwpBand {
  if (isOrganic) return "organic";
  const lvl = (cyberwareLevel ?? "none").toLowerCase();
  if (OVERRIDE_BANDS.includes(lvl)) return lvl as CwpBand;
  return deriveCyberwareBand(chromeCount).level as CwpBand;
}
function bandToFields(band: CwpBand): { isOrganic: boolean; cyberwareLevel: string } {
  if (band === "organic") return { isOrganic: true, cyberwareLevel: "none" };
  return { isOrganic: false, cyberwareLevel: band };
}

// Valid life-status values (the headline status column). Kept here so the
// archive status filter can validate query input against the same set the
// editor/import paths use.
const LIFE_STATUSES = ["active", "dead", "missing", "loa", "retired"] as const;

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
    // Postgres array overlap on the UNION of applied + manual tags: returns
    // characters tagged with ANY of the requested tags. "Solo OR Netrunner"
    // is a more useful filter than the intersection for a multi-faceted
    // archive — players almost never want "Solo AND Netrunner". Overlapping
    // either column is equivalent to overlapping their union, and lets us use
    // the typed arrayOverlaps helper (a raw `&& ${arr}::text[]` mis-binds the
    // JS array — drizzle spreads it into N scalar params).
    conds.push(
      or(
        arrayOverlaps(characters.appliedTags, tagList),
        arrayOverlaps(characters.manualTags, tagList),
      ) as unknown as ReturnType<typeof eq>,
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
      vrchatUsername: vrchatLinks.vrchatUsername,
      vrchatUrl: vrchatLinks.vrchatUrl,
      appliedTags: characters.appliedTags,
      manualTags: characters.manualTags,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .leftJoin(vrchatLinks, eq(vrchatLinks.discordId, users.discordId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(characters.createdAt))
    .limit(2000);

  res.json(
    rows.map(({ manualTags, ...r }) => ({
      ...r,
      vrchatUsername: r.vrchatUsername ?? null,
      vrchatUrl: r.vrchatUrl ?? null,
      tags: mergeTags(r.appliedTags, manualTags),
    })),
  );
});

// Distinct tag names across the whole archive, so the filter UI can render
// chips without each client having to derive the union from a 2000-row list.
// Returns the merged set (Discord-applied ∪ staff-added) so a manually-added
// tag becomes a filter chip immediately, even before any import re-sync.
router.get("/directory/character-tags", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.execute<{ tag: string }>(
    sql`SELECT DISTINCT unnest(applied_tags || manual_tags) AS tag
        FROM characters
        WHERE array_length(applied_tags || manual_tags, 1) > 0
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
      appliedTags: characters.appliedTags,
      manualTags: characters.manualTags,
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
  const { ownerId: _ownerId, manualTags, ...safe } = row;
  res.json({ ...safe, tags: mergeTags(safe.appliedTags, manualTags), background: cleanBackground(safe.background) });
});

// ======================= CHARACTER ARCHIVE (staff) =========================
// The archive is the fixer/admin management surface. Unlike the shared
// /directory/characters roster (which every authenticated player can hit for
// recipient pickers), these endpoints are FIXER/ADMIN-only and expose the
// fuller management projection (owner id, CWP band, merged tags) plus the
// immediate-apply edit path.
const staffOnly = requireAnyRole(["ADMIN", "FIXER"]);

// Full archive roster — one row per character with everything the card needs.
router.get("/directory/archive", staffOnly, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const scope = typeof req.query.scope === "string" ? req.query.scope : "all";
  const mode = req.query.mode === "content" ? "content" : "name";
  const sort = req.query.sort === "name" ? "name" : "recent";
  const tagsRaw = typeof req.query.tags === "string" ? req.query.tags : "";
  const tagList = tagsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  // Life-status filter (active/dead/missing/loa/retired) — multi-select, matches
  // ANY of the requested values against characters.lifeStatus (the headline
  // status column). Unknown values are dropped so a bad query can't 500.
  const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
  const statusList = statusRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => (LIFE_STATUSES as readonly string[]).includes(s));
  // CWP band filter (organic/none/medium/high/extreme) — multi-select. The band
  // is derived (isOrganic + cyberwareLevel), not stored, so each requested band
  // expands to its underlying column predicate and they're OR'd together.
  const bandsRaw = typeof req.query.bands === "string" ? req.query.bands : "";
  const bandList = bandsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => (CWP_BANDS as readonly string[]).includes(s)) as CwpBand[];

  const conds = [] as Array<ReturnType<typeof eq>>;
  if (q.length > 0) {
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
      clauses.push(sql`${characters.sheetData}::text ILIKE ${like}` as unknown as ReturnType<typeof eq>);
    }
    conds.push(or(...clauses) as unknown as ReturnType<typeof eq>);
  }
  if (scope === "active") conds.push(eq(characters.archived, false));
  else if (scope === "retired") conds.push(eq(characters.archived, true));
  else if (scope === "claimed") conds.push(eq(characters.claimed, true));
  else if (scope === "unclaimed") conds.push(eq(characters.claimed, false));
  else if (scope === "pc") conds.push(eq(characters.kind, "pc"));
  else if (scope === "npc") conds.push(eq(characters.kind, "npc"));
  if (statusList.length > 0) {
    conds.push(inArray(characters.lifeStatus, statusList) as unknown as ReturnType<typeof eq>);
  }
  if (tagList.length > 0) {
    conds.push(
      or(
        arrayOverlaps(characters.appliedTags, tagList),
        arrayOverlaps(characters.manualTags, tagList),
      ) as unknown as ReturnType<typeof eq>,
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
      isOrganic: characters.isOrganic,
      cyberwareLevel: characters.cyberwareLevel,
      legacyDiscordUsername: characters.legacyDiscordUsername,
      importedFromChannelName: characters.importedFromChannelName,
      ownerId: characters.ownerId,
      ownerName: users.username,
      ownerAvatarUrl: users.avatarUrl,
      vrchatUsername: vrchatLinks.vrchatUsername,
      vrchatUrl: vrchatLinks.vrchatUrl,
      fixerDiscordId: characters.fixerDiscordId,
      playerDiscordId: characters.playerDiscordId,
      appliedTags: characters.appliedTags,
      manualTags: characters.manualTags,
      createdAt: characters.createdAt,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .leftJoin(vrchatLinks, eq(vrchatLinks.discordId, users.discordId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(sort === "name" ? asc(characters.name) : desc(characters.createdAt))
    .limit(2000);

  // CWP band is derived from each character's real installed chrome (parsed from
  // their cyberware inventory), so resolve it per row from a single bulk lookup.
  const chromeCounts = await sumCwpByCharacter(rows.map((r) => r.id));
  let out = rows.map(({ appliedTags, manualTags, isOrganic, cyberwareLevel, ...r }) => ({
    ...r,
    vrchatUsername: r.vrchatUsername ?? null,
    vrchatUrl: r.vrchatUrl ?? null,
    tags: mergeTags(appliedTags, manualTags),
    cwpBand: resolveBand(isOrganic, cyberwareLevel, chromeCounts.get(r.id) ?? 0),
  }));
  // Band filter (multi-select, matches ANY) is applied in-memory because the
  // band is derived, not a column — the SQL above can't express it.
  if (bandList.length > 0) {
    const wanted = new Set<CwpBand>(bandList);
    out = out.filter((r) => wanted.has(r.cwpBand));
  }
  res.json(out);
});

// Owner picker search — staff need to look up the internal user to (re)assign
// ownership. Returns a small projection, capped, name/handle match only.
router.get("/directory/archive/users", staffOnly, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const like = `%${q}%`;
  const rows = await db
    .select({ id: users.id, username: users.username, globalName: users.globalName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(q.length > 0 ? or(ilike(users.username, like), ilike(users.globalName, like)) : undefined)
    .orderBy(asc(users.username))
    .limit(25);
  res.json(rows);
});

// Full editable detail for the archive editor. Staff-only, so unlike the
// shared detail endpoint it DOES return ownerId + the CWP band + both tag
// columns so the edit dialog can pre-fill every control.
router.get("/directory/archive/:id", staffOnly, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
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
      isOrganic: characters.isOrganic,
      cyberwareLevel: characters.cyberwareLevel,
      legacyDiscordUsername: characters.legacyDiscordUsername,
      importedFromChannelName: characters.importedFromChannelName,
      appliedTags: characters.appliedTags,
      manualTags: characters.manualTags,
      ownerId: characters.ownerId,
      ownerName: users.username,
      ownerAvatarUrl: users.avatarUrl,
      fixerDiscordId: characters.fixerDiscordId,
      playerDiscordId: characters.playerDiscordId,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(eq(characters.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { isOrganic, cyberwareLevel, appliedTags, manualTags, ...rest } = row;
  const chromeCounts = await sumCwpByCharacter([id]);
  res.json({
    ...rest,
    background: cleanBackground(rest.background),
    tags: mergeTags(appliedTags, manualTags),
    cwpBand: resolveBand(isOrganic, cyberwareLevel, chromeCounts.get(id) ?? 0),
  });
});

// Immediate-apply edit. Staff edits land on the character row directly (no
// player review/voting flow), but EVERY edit requires a non-empty commit
// message and writes both an audit_log entry (before/after) and a
// character_updates changelog note so the change is traceable in the existing
// admin audit view and on the character's own history.
const ArchiveEditSchema = z
  .object({
    commitMessage: z.string().trim().min(1).max(2000),
    name: z.string().trim().min(1).optional(),
    archetype: z.string().nullable().optional(),
    ownerId: z.string().nullable().optional(),
    claimed: z.boolean().optional(),
    kind: z.enum(["pc", "npc"]).optional(),
    archived: z.boolean().optional(),
    lifeStatus: z.enum(LIFE_STATUSES).optional(),
    cwpBand: z.enum(["organic", "none", "medium", "high", "extreme"]).optional(),
    // NPC fixer/player Discord IDs — free-form snowflakes, may be cleared.
    fixerDiscordId: z.string().nullable().optional(),
    playerDiscordId: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    sheetData: z
      .object({
        preamble: z.string(),
        sections: z.record(z.string(), z.string()),
        // RipperDoc flag (parity with the player/staff edit dialog). Grants the
        // RipperDoc Discord role to the owner on save; see the grant below.
        ripperDoc: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

router.patch("/directory/archive/:id", staffOnly, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = ArchiveEditSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid edit", details: parsed.error.issues });
    return;
  }
  const { commitMessage, ...edit } = parsed.data;

  const [cur] = await db.select().from(characters).where(eq(characters.id, id));
  if (!cur) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const mark = (field: string, prev: unknown, next: unknown): void => {
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    before[field] = prev ?? null;
    after[field] = next ?? null;
  };

  if (edit.name !== undefined) {
    patch.name = edit.name;
    mark("name", cur.name, edit.name);
  }
  if (edit.archetype !== undefined) {
    const v = edit.archetype && edit.archetype.trim().length > 0 ? edit.archetype.trim() : null;
    patch.archetype = v;
    mark("archetype", cur.archetype, v);
  }
  if (edit.kind !== undefined) {
    patch.kind = edit.kind;
    mark("kind", cur.kind, edit.kind);
  }
  if (edit.lifeStatus !== undefined) {
    patch.lifeStatus = edit.lifeStatus;
    mark("lifeStatus", cur.lifeStatus, edit.lifeStatus);
  }
  if (edit.archived !== undefined) {
    patch.archived = edit.archived;
    patch.archivedAt = edit.archived ? (cur.archivedAt ?? new Date()) : null;
    mark("archived", cur.archived, edit.archived);
  }
  // sheetData: spread-merge over the existing column so editing the preamble /
  // sections / ripperDoc flag from this admin tool never wipes the richer keys
  // (physicalDescription, appearance, skills, …) the player/staff edit dialog
  // owns.
  if (edit.sheetData !== undefined) {
    const merged = { ...((cur.sheetData ?? {}) as Record<string, unknown>), ...edit.sheetData };
    patch.sheetData = merged;
    mark("sheetData", cur.sheetData, merged);
  }

  // Owner (re)assignment. ownerId === null clears ownership AND marks
  // unclaimed; a non-null ownerId must reference a real user and marks the
  // character claimed unless `claimed` is explicitly overridden.
  if (edit.ownerId !== undefined) {
    if (edit.ownerId === null) {
      patch.ownerId = null;
      patch.claimed = edit.claimed ?? false;
      mark("ownerId", cur.ownerId, null);
    } else {
      const [u] = await db.select().from(users).where(eq(users.id, edit.ownerId));
      if (!u) {
        res.status(404).json({ error: "Assigned user not found" });
        return;
      }
      patch.ownerId = edit.ownerId;
      patch.claimed = edit.claimed ?? true;
      mark("ownerId", cur.ownerId, edit.ownerId);
    }
  }
  if (edit.claimed !== undefined && patch.claimed === undefined) {
    patch.claimed = edit.claimed;
  }
  if (patch.claimed !== undefined) mark("claimed", cur.claimed, patch.claimed);

  // CWP band → the two underlying storage fields.
  if (edit.cwpBand !== undefined) {
    const { isOrganic, cyberwareLevel } = bandToFields(edit.cwpBand);
    patch.isOrganic = isOrganic;
    patch.cyberwareLevel = cyberwareLevel;
    mark("cwpBand", deriveCwpBand(cur.isOrganic, cur.cyberwareLevel), edit.cwpBand);
  }

  // NPC fixer/player Discord IDs — trim, treat empty as cleared.
  if (edit.fixerDiscordId !== undefined) {
    const v = edit.fixerDiscordId && edit.fixerDiscordId.trim().length > 0 ? edit.fixerDiscordId.trim() : null;
    patch.fixerDiscordId = v;
    mark("fixerDiscordId", cur.fixerDiscordId, v);
  }
  if (edit.playerDiscordId !== undefined) {
    const v = edit.playerDiscordId && edit.playerDiscordId.trim().length > 0 ? edit.playerDiscordId.trim() : null;
    patch.playerDiscordId = v;
    mark("playerDiscordId", cur.playerDiscordId, v);
  }

  // Tags: the client sends the FULL desired merged set; we split it back into
  // the applied/manual columns so the manual column survives re-import.
  if (edit.tags !== undefined) {
    const { applied, manual } = splitDesiredTags(edit.tags, cur.appliedTags);
    patch.appliedTags = applied;
    patch.manualTags = manual;
    mark("tags", mergeTags(cur.appliedTags, cur.manualTags), mergeTags(applied, manual));
  }

  if (Object.keys(after).length === 0) {
    res.status(400).json({ error: "No changes" });
    return;
  }

  // The character mutation, its audit_log entry, and the character_updates
  // changelog note MUST land together: the spec requires every edit to be
  // traceable. recordAudit() is deliberately fire-and-forget elsewhere, so we
  // write the audit row inline within a transaction here — if any insert
  // fails, the whole edit rolls back rather than silently applying without a
  // trail.
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd?.toString().split(",")[0] ?? req.ip)) ?? null;
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(characters).set(patch).where(eq(characters.id, id)).returning();
    await tx.insert(auditLog).values({
      category: "character",
      action: "archive_edit",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "character",
      targetId: String(id),
      message: commitMessage,
      beforeJson: before as never,
      afterJson: after as never,
    });
    await tx.insert(characterUpdates).values({
      characterId: id,
      authorId: req.user!.id,
      note: commitMessage,
    });
    return u;
  });

  // Activity feed is non-critical social surface — never roll back a valid,
  // fully-audited edit just because the feed insert hiccups.
  try {
    await db.insert(activityEvents).values({
      kind: "character_archive_edit",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} edited ${updated.name}: ${commitMessage}`.slice(0, 500),
    });
  } catch (err) {
    console.error("[archive] activity event insert failed", err);
  }

  // Grant the "RipperDoc" Discord role when this staff/admin edit flags the
  // character as a ripper doc. This is a direct staff write (no review), so the
  // grant fires immediately on save — mirroring the sheet-approval and edit-
  // approval grants. Fire-and-forget + gated/idempotent in addGuildMemberRole;
  // the role_sync cron re-injects the website "ripperdoc" flag from the role id.
  if (edit.sheetData?.ripperDoc === true && updated.ownerId) {
    void addGuildMemberRole(
      updated.ownerId,
      RIPPERDOC_ROLE_ID,
      `RipperDoc — character "${updated.name}" archive edit`,
    ).then((r) => {
      if (!r.ok) {
        console.warn("[archive] RipperDoc role grant did not apply", {
          characterId: id,
          ownerId: updated.ownerId,
          error: r.error,
        });
      }
    });
  }

  res.json({
    id: updated.id,
    name: updated.name,
    kind: updated.kind,
    archetype: updated.archetype,
    claimed: updated.claimed,
    archived: updated.archived,
    ownerId: updated.ownerId,
    fixerDiscordId: updated.fixerDiscordId,
    playerDiscordId: updated.playerDiscordId,
    cwpBand: resolveBand(
      updated.isOrganic,
      updated.cyberwareLevel,
      (await sumCwpByCharacter([id])).get(id) ?? 0,
    ),
    tags: mergeTags(updated.appliedTags, updated.manualTags),
    changed: Object.keys(after),
  });
});

router.get("/directory/ripperdocs", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: ripperdocs.id,
      name: ripperdocs.name,
      ownerName: users.username,
      purpose: ripperdocs.purpose,
      location: ripperdocs.location,
      description: ripperdocs.description,
      bannerUrl: ripperdocs.bannerUrl,
    })
    .from(ripperdocs)
    .leftJoin(users, eq(users.id, ripperdocs.ownerId))
    .orderBy(asc(ripperdocs.name));
  res.json(rows.map((r) => ({ ...r, ownerName: r.ownerName ?? null })));
});

router.get("/directory/ripperdocs/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db
    .select({
      id: ripperdocs.id,
      name: ripperdocs.name,
      ownerId: ripperdocs.ownerId,
      ownerName: users.username,
      purpose: ripperdocs.purpose,
      location: ripperdocs.location,
      description: ripperdocs.description,
      bannerUrl: ripperdocs.bannerUrl,
    })
    .from(ripperdocs)
    .leftJoin(users, eq(users.id, ripperdocs.ownerId))
    .where(eq(ripperdocs.id, id));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const emps = await db
    .select({ id: ripperdocEmployees.id, characterId: characters.id, name: characters.name, role: ripperdocEmployees.role })
    .from(ripperdocEmployees)
    .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
    .where(eq(ripperdocEmployees.ripperdocId, id));
  res.json({ ...r, ownerName: r.ownerName ?? null, employeeNames: emps.map((e) => e.name) });
});

router.get("/directory/stores", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: stores.id,
      name: stores.name,
      ownerName: users.username,
      kind: stores.kind,
      purpose: stores.purpose,
      location: stores.location,
      description: stores.description,
      bannerUrl: stores.bannerUrl,
    })
    .from(stores)
    .leftJoin(users, eq(users.id, stores.ownerId))
    .orderBy(asc(stores.name));
  res.json(rows.map((s) => ({ ...s, ownerName: s.ownerName ?? null })));
});

router.get("/directory/stores/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db
    .select({
      id: stores.id,
      name: stores.name,
      ownerName: users.username,
      kind: stores.kind,
      purpose: stores.purpose,
      location: stores.location,
      description: stores.description,
      bannerUrl: stores.bannerUrl,
    })
    .from(stores)
    .leftJoin(users, eq(users.id, stores.ownerId))
    .where(eq(stores.id, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const emps = await db
    .select({ id: storeEmployees.id, characterId: characters.id, name: characters.name, role: storeEmployees.role })
    .from(storeEmployees)
    .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
    .where(eq(storeEmployees.storeId, id));
  res.json({ ...s, ownerName: s.ownerName ?? null, employeeNames: emps.map((e) => e.name) });
});

// The player-facing catalog is live-only. "draft" entries are works in
// progress the fixer team is still curating; "retired" entries have been
// pulled from sale. Only ADMIN/FIXER see the full catalog (every status);
// everyone else sees exclusively rows whose status is "live".
router.get("/catalog/guns", async (req, res): Promise<void> => {
  const all = await db.select().from(catalogGuns);
  const isStaff =
    !!req.user && (hasRole(req.user.roles, "ADMIN") || hasRole(req.user.roles, "FIXER"));
  if (isStaff) {
    res.json(all);
    return;
  }
  // Non-staff: live weapons only, and scrub wholesalePrice (a fixer-only
  // margin number that shouldn't leak to regular players via the API).
  res.json(
    all
      .filter((g) => (g.status ?? "").toLowerCase() === "live")
      .map(({ wholesalePrice: _w, ...rest }) => rest),
  );
});

// ---- Custom (off-catalog) items (fixer/admin) -----------------------------
// One-off custom items granted to characters live in custom_requests, NOT in
// the standard catalog tables. Staff browse them here per type so each catalog
// page can show a "Custom" tab alongside the standard listing:
//   gun       -> custom guns
//   cyberware -> custom cyberware
//   property  -> off-map / custom property
// We surface APPROVED requests (the ones that became real items), joined to the
// owning character so a fixer can see who holds each one.
const CUSTOM_TYPES = ["gun", "cyberware", "property"] as const;
router.get("/catalog/custom", requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const type = String(req.query.type ?? "");
  if (!(CUSTOM_TYPES as readonly string[]).includes(type)) {
    res.status(400).json({ error: "type must be one of gun, cyberware, property" });
    return;
  }
  const rows = await db
    .select({
      id: customRequests.id,
      type: customRequests.type,
      title: customRequests.title,
      description: customRequests.description,
      imageUrl: customRequests.imageUrl,
      details: customRequests.details,
      status: customRequests.status,
      appliedRef: customRequests.appliedRef,
      characterId: customRequests.characterId,
      characterName: characters.name,
      ownerId: characters.ownerId,
      createdAt: customRequests.createdAt,
    })
    .from(customRequests)
    .leftJoin(characters, eq(characters.id, customRequests.characterId))
    .where(and(eq(customRequests.type, type), eq(customRequests.status, "approved")))
    .orderBy(desc(customRequests.createdAt));
  res.json(rows);
});

// ---- Gun catalog management (fixer/admin) ---------------------------------
// The catalog is the fixer team's source of truth for purchasable weapons.
// Staff get full-field editing + creation here; every mutation writes an
// inline audit_log row (category "catalog") with before/after so the change
// is traceable in the admin audit view. Drafts stay staff-only until promoted
// to live (see GET /catalog/guns).
const GUN_STATUSES = ["draft", "live", "retired"] as const;

// Optional free-text field that, when present, trims and collapses empty
// strings to null (the DB stores these columns as nullable).
const nullableText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  });
const nullableInt = z.number().int().min(0).nullable().optional();
const gunStatus = z
  .union([z.enum(GUN_STATUSES), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    return v; // already lowercase enum or null
  });

const GunEditSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    category: nullableText,
    manufacturer: nullableText,
    damage: nullableText,
    magSize: nullableInt,
    price: z.number().int().min(0).optional(),
    wholesalePrice: nullableInt,
    restriction: nullableText,
    powerLevel: nullableText,
    weaponType: nullableText,
    fireMode: nullableText,
    notes: nullableText,
    imageUrl: nullableText,
    cyberwareReq: nullableText,
    wikiUrl: nullableText,
    prefabThreadUrl: nullableText,
    status: gunStatus,
  })
  .strict();

const GunCreateSchema = GunEditSchema.extend({
  name: z.string().trim().min(1),
});

function auditMeta(req: import("express").Request) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd?.toString().split(",")[0] ?? req.ip)) ?? null;
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  return { ip, ua };
}

// Create a new weapon. Defaults to draft so it stays staff-only until
// promoted. Audit-logged with the full created field set as "after".
router.post(
  "/catalog/guns",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const parsed = GunCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const values = {
      name: d.name,
      category: d.category ?? null,
      manufacturer: d.manufacturer ?? null,
      damage: d.damage ?? null,
      magSize: d.magSize ?? null,
      price: d.price ?? 0,
      wholesalePrice: d.wholesalePrice ?? null,
      restriction: d.restriction ?? null,
      powerLevel: d.powerLevel ?? null,
      weaponType: d.weaponType ?? null,
      fireMode: d.fireMode ?? null,
      notes: d.notes ?? null,
      imageUrl: d.imageUrl ?? null,
      cyberwareReq: d.cyberwareReq ?? null,
      wikiUrl: d.wikiUrl ?? null,
      prefabThreadUrl: d.prefabThreadUrl ?? null,
      status: d.status ?? "draft",
    };
    const { ip, ua } = auditMeta(req);
    const created = await db.transaction(async (tx) => {
      const [g] = await tx.insert(catalogGuns).values(values).returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "gun_create",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_gun",
        targetId: String(g.id),
        message: `Created weapon "${g.name}" (${g.status ?? "draft"})`,
        beforeJson: null,
        afterJson: values as never,
      });
      return g;
    });
    res.status(201).json(created);
  },
);

// Staff (fixer/admin) "grant a custom gun" — the CUSTOM counterpart to creating
// a CATALOG entry. Unlike POST /catalog/guns (which adds a purchasable registry
// template), this mints a one-off bespoke gun bound to a specific character: it
// materializes the inventory item AND records an auto-approved custom-request
// row (status="approved", appliedRef set) so the gun shows in the staff-only
// CUSTOM tab — the same end result as an admin override of a player's custom-gun
// request, minus the vote. Available to fixers and admins.
const CustomGunSchema = z
  .object({
    characterId: z.number().int().positive(),
    name: z.string().trim().min(1),
    description: nullableText,
    imageUrl: nullableText,
    cyberwareReq: nullableText,
  })
  .strict();

router.post(
  "/catalog/custom-guns",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const parsed = CustomGunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const [c] = await db
      .select({
        id: characters.id,
        name: characters.name,
        ownerId: characters.ownerId,
        archived: characters.archived,
      })
      .from(characters)
      .where(eq(characters.id, d.characterId));
    if (!c) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    if (c.archived) {
      res.status(400).json({ error: "Character is archived — cannot grant a custom gun" });
      return;
    }
    const description = d.description ?? null;
    const imageUrl = d.imageUrl ?? null;
    const { ip, ua } = auditMeta(req);
    const result = await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          characterId: c.id,
          ownerId: c.ownerId,
          name: d.name,
          category: "gun",
          quantity: 1,
          notes: description,
          cyberwareReq: d.cyberwareReq ?? null,
        })
        .returning();
      const appliedRef = `inventory:${item.instanceUuid}`;
      const now = new Date();
      const [reqRow] = await tx
        .insert(customRequests)
        .values({
          type: "gun",
          characterId: c.id,
          requestedById: req.user!.id,
          title: d.name,
          description,
          imageUrl,
          status: "approved",
          reviewedById: req.user!.id,
          reviewedAt: now,
          overriddenBy: req.user!.id,
          appliedRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "custom_gun_grant",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "custom_request",
        targetId: String(reqRow.id),
        message: `Granted custom gun "${d.name}" to ${c.name}`,
        beforeJson: null,
        afterJson: { characterId: c.id, name: d.name, appliedRef } as never,
      });
      return { item, reqRow };
    });
    // Chain-of-custody ledger (fire-and-forget; mirrors afterApprove's gun grant).
    await recordInventoryEvent({
      instanceUuid: result.item.instanceUuid,
      kind: "created",
      actorId: req.user!.id,
      actorName: req.user!.username,
      toCharacterId: c.id,
      toCharacterName: c.name,
      itemName: d.name,
      quantity: 1,
      reason: "Staff-granted custom gun",
    });
    res.status(201).json({
      id: result.reqRow.id,
      type: "gun",
      title: result.reqRow.title,
      description: result.reqRow.description,
      imageUrl: result.reqRow.imageUrl,
      details: result.reqRow.details ?? null,
      status: result.reqRow.status,
      appliedRef: result.reqRow.appliedRef,
      characterId: c.id,
      characterName: c.name,
      ownerId: c.ownerId,
      createdAt: result.reqRow.createdAt,
    });
  },
);

// Full-field edit. Any subset of editable fields may be supplied; omitted
// fields are untouched. Mirrors the archive editor: build before/after via
// mark(), bail with 400 if nothing actually changed, then apply + audit
// inside one transaction so an edit never lands without its trail.
router.patch(
  "/catalog/guns/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = GunEditSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const edit = parsed.data;

    const [cur] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, id));
    if (!cur) {
      res.status(404).json({ error: "Gun not found" });
      return;
    }

    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const mark = (field: string, prev: unknown, next: unknown): void => {
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) return;
      patch[field] = next ?? null;
      before[field] = prev ?? null;
      after[field] = next ?? null;
    };

    if (edit.name !== undefined) mark("name", cur.name, edit.name);
    if (edit.category !== undefined) mark("category", cur.category, edit.category);
    if (edit.manufacturer !== undefined) mark("manufacturer", cur.manufacturer, edit.manufacturer);
    if (edit.damage !== undefined) mark("damage", cur.damage, edit.damage);
    if (edit.magSize !== undefined) mark("magSize", cur.magSize, edit.magSize);
    if (edit.price !== undefined) mark("price", cur.price, edit.price);
    if (edit.wholesalePrice !== undefined)
      mark("wholesalePrice", cur.wholesalePrice, edit.wholesalePrice);
    if (edit.restriction !== undefined) mark("restriction", cur.restriction, edit.restriction);
    if (edit.powerLevel !== undefined) mark("powerLevel", cur.powerLevel, edit.powerLevel);
    if (edit.weaponType !== undefined) mark("weaponType", cur.weaponType, edit.weaponType);
    if (edit.fireMode !== undefined) mark("fireMode", cur.fireMode, edit.fireMode);
    if (edit.notes !== undefined) mark("notes", cur.notes, edit.notes);
    if (edit.imageUrl !== undefined) mark("imageUrl", cur.imageUrl, edit.imageUrl);
    if (edit.cyberwareReq !== undefined) mark("cyberwareReq", cur.cyberwareReq, edit.cyberwareReq);
    if (edit.wikiUrl !== undefined) mark("wikiUrl", cur.wikiUrl, edit.wikiUrl);
    if (edit.prefabThreadUrl !== undefined)
      mark("prefabThreadUrl", cur.prefabThreadUrl, edit.prefabThreadUrl);
    if (edit.status !== undefined) mark("status", cur.status, edit.status);

    if (Object.keys(after).length === 0) {
      res.status(400).json({ error: "No changes" });
      return;
    }

    const { ip, ua } = auditMeta(req);
    const statusChanged = "status" in after;
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(catalogGuns)
        .set(patch)
        .where(eq(catalogGuns.id, id))
        .returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: statusChanged && Object.keys(after).length === 1 ? "gun_status" : "gun_edit",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_gun",
        targetId: String(id),
        message: `Edited weapon "${u.name}": ${Object.keys(after).join(", ")}`,
        beforeJson: before as never,
        afterJson: after as never,
      });
      return u;
    });

    res.json({ ...updated, changed: Object.keys(after) });
  },
);

// Permanently delete a weapon catalog entry. Fixer/admin only. This removes the
// registry template only — weapons already owned by characters live in
// inventory_items (separate rows, no FK to the catalog) and are untouched.
router.delete(
  "/catalog/guns/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [cur] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, id));
    if (!cur) {
      res.status(404).json({ error: "Gun not found" });
      return;
    }
    const { ip, ua } = auditMeta(req);
    await db.transaction(async (tx) => {
      await tx.delete(catalogGuns).where(eq(catalogGuns.id, id));
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "gun_delete",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_gun",
        targetId: String(id),
        message: `Deleted weapon "${cur.name}"`,
        beforeJson: cur as never,
        afterJson: null,
      });
    });
    res.json({ ok: true });
  },
);

router.get("/catalog/cyberware", async (req, res): Promise<void> => {
  const all = await db.select().from(catalogCyberware);
  const isStaff =
    !!req.user && (hasRole(req.user.roles, "ADMIN") || hasRole(req.user.roles, "FIXER"));
  if (isStaff) {
    res.json(all);
    return;
  }
  // Non-staff: scrub wholesalePrice (the fixer-only cost-basis / margin number),
  // matching /catalog/guns. price + installCost are player-facing (what they pay).
  res.json(all.map(({ wholesalePrice: _w, ...rest }) => rest));
});

const CyberwareEditSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    slot: z.string().trim().min(1).optional(),
    cwp: nullableText,
    price: z.number().int().min(0).optional(),
    wholesalePrice: nullableInt,
    installCost: nullableInt,
    description: nullableText,
  })
  .strict();

// Create a new cyberware catalog entry. Fixer/admin only. Audit-logged with
// the full created field set as "after".
const CyberwareCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    slot: z.string().trim().min(1),
    cwp: nullableText,
    price: z.number().int().min(0).optional(),
    wholesalePrice: nullableInt,
    installCost: nullableInt,
    description: nullableText,
  })
  .strict();

router.post(
  "/catalog/cyberware",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const parsed = CyberwareCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const values = {
      name: d.name,
      slot: d.slot,
      cwp: d.cwp ?? null,
      price: d.price ?? 0,
      wholesalePrice: d.wholesalePrice ?? null,
      installCost: d.installCost ?? null,
      description: d.description ?? null,
    };
    const { ip, ua } = auditMeta(req);
    const created = await db.transaction(async (tx) => {
      const [c] = await tx.insert(catalogCyberware).values(values).returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "cyberware_create",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_cyberware",
        targetId: String(c.id),
        message: `Created cyberware "${c.name}"`,
        beforeJson: null,
        afterJson: values as never,
      });
      return c;
    });
    res.status(201).json(created);
  },
);

// Full-field cyberware edit, mirroring the gun editor: any subset of fields
// may be supplied, omitted fields are untouched, bail 400 on a no-op, and
// apply + audit inside one transaction so an edit never lands without a trail.
router.patch(
  "/catalog/cyberware/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = CyberwareEditSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const edit = parsed.data;

    const [cur] = await db.select().from(catalogCyberware).where(eq(catalogCyberware.id, id));
    if (!cur) {
      res.status(404).json({ error: "Cyberware not found" });
      return;
    }

    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const mark = (field: string, prev: unknown, next: unknown): void => {
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) return;
      patch[field] = next ?? null;
      before[field] = prev ?? null;
      after[field] = next ?? null;
    };

    if (edit.name !== undefined) mark("name", cur.name, edit.name);
    if (edit.slot !== undefined) mark("slot", cur.slot, edit.slot);
    if (edit.cwp !== undefined) mark("cwp", cur.cwp, edit.cwp);
    if (edit.price !== undefined) mark("price", cur.price, edit.price);
    if (edit.wholesalePrice !== undefined)
      mark("wholesalePrice", cur.wholesalePrice, edit.wholesalePrice);
    if (edit.installCost !== undefined) mark("installCost", cur.installCost, edit.installCost);
    if (edit.description !== undefined) mark("description", cur.description, edit.description);

    if (Object.keys(after).length === 0) {
      res.status(400).json({ error: "No changes" });
      return;
    }

    const { ip, ua } = auditMeta(req);
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(catalogCyberware)
        .set(patch)
        .where(eq(catalogCyberware.id, id))
        .returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "cyberware_edit",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_cyberware",
        targetId: String(id),
        message: `Edited cyberware "${u.name}": ${Object.keys(after).join(", ")}`,
        beforeJson: before as never,
        afterJson: after as never,
      });
      return u;
    });

    res.json({ ...updated, changed: Object.keys(after) });
  },
);

// Permanently delete a cyberware catalog entry. Fixer/admin only. Removes the
// registry template only — cyberware already installed on characters live in
// inventory_items (separate rows, no FK to the catalog) and are untouched.
router.delete(
  "/catalog/cyberware/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [cur] = await db.select().from(catalogCyberware).where(eq(catalogCyberware.id, id));
    if (!cur) {
      res.status(404).json({ error: "Cyberware not found" });
      return;
    }
    const { ip, ua } = auditMeta(req);
    await db.transaction(async (tx) => {
      await tx.delete(catalogCyberware).where(eq(catalogCyberware.id, id));
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "cyberware_delete",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_cyberware",
        targetId: String(id),
        message: `Deleted cyberware "${cur.name}"`,
        beforeJson: cur as never,
        afterJson: null,
      });
    });
    res.json({ ok: true });
  },
);

// Fixer-managed district list powering the property-creator dropdown. Any
// logged-in user can read it; only fixers/admins can add a new district.
router.get("/catalog/districts", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(catalogDistricts).orderBy(asc(catalogDistricts.name));
  res.json(rows.map((d) => ({ id: d.id, name: d.name })));
});

const DistrictCreateSchema = z.object({ name: z.string().trim().min(1).max(64) }).strict();

router.post(
  "/catalog/districts",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const parsed = DistrictCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const name = parsed.data.name;
    const existing = await db
      .select()
      .from(catalogDistricts)
      .where(ilike(catalogDistricts.name, name));
    if (existing[0]) {
      res.status(200).json({ id: existing[0].id, name: existing[0].name });
      return;
    }
    const [created] = await db
      .insert(catalogDistricts)
      .values({ name, createdById: req.user!.id })
      .returning();
    res.status(201).json({ id: created.id, name: created.name });
  },
);

router.get("/catalog/rent", async (req, res): Promise<void> => {
  // Mark listings that already have an active lease so the UI can
  // disable the LEASE button instead of letting players submit a
  // request that the housing flow would have to reject anyway. Staff
  // (admin/fixer) additionally see WHO occupies each listing so they can
  // remove the occupant from the catalog; players never see the occupant.
  const isStaff =
    !!req.user && (hasRole(req.user.roles, "ADMIN") || hasRole(req.user.roles, "FIXER"));
  const [listings, occupants, reservedIds] = await Promise.all([
    db.select().from(catalogRent),
    db
      .select({
        listingId: housing.listingId,
        housingId: housing.id,
        characterId: housing.characterId,
        characterName: characters.name,
      })
      .from(housing)
      .innerJoin(characters, eq(characters.id, housing.characterId))
      .where(isNotNull(housing.listingId)),
    // Live on-map venue reservations also mark a building as taken so a second
    // player can't request the same building before the first is decided.
    loadReservedListingIds(),
  ]);
  const byListing = new Map<
    number,
    { housingId: number; characterId: number; characterName: string }
  >();
  for (const o of occupants) {
    if (o.listingId != null && !byListing.has(o.listingId)) {
      byListing.set(o.listingId, {
        housingId: o.housingId,
        characterId: o.characterId,
        characterName: o.characterName,
      });
    }
  }
  res.json(
    listings.map((l) => {
      const occ = byListing.get(l.id);
      const reserved = reservedIds.has(l.id);
      return {
        ...l,
        occupied: !!occ || reserved,
        ...(isStaff && occ
          ? {
              occupantCharacterId: occ.characterId,
              occupantCharacterName: occ.characterName,
              housingId: occ.housingId,
            }
          : {}),
      };
    }),
  );
});

// On-map venue picker: business buildings that are unleased AND not held by a
// live venue reservation. Returns the fields the dialog needs (id, name,
// district, tier, monthly rent) so a player can choose where to open up shop.
router.get("/catalog/rent/available-business", requireAuth, async (_req, res): Promise<void> => {
  const [listings, occupants, reservedIds] = await Promise.all([
    db.select().from(catalogRent).where(eq(catalogRent.kind, "business")),
    db
      .select({ listingId: housing.listingId })
      .from(housing)
      .where(isNotNull(housing.listingId)),
    loadReservedListingIds(),
  ]);
  const leased = new Set<number>();
  for (const o of occupants) if (o.listingId != null) leased.add(o.listingId);
  res.json(
    listings
      .filter((l) => !leased.has(l.id) && !reservedIds.has(l.id))
      .map((l) => ({
        id: l.id,
        name: l.name,
        district: l.district,
        tier: l.tier,
        monthlyRent: l.monthlyRent,
      })),
  );
});

// Staff-only edit for a housing listing. Currently used by the catalog UI to
// attach/replace/clear a single listing image, but also accepts the basic
// descriptive fields. Audit-logged (category "catalog") with before/after.
const RentEditSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    district: nullableText,
    tier: nullableText,
    monthlyRent: z.number().int().min(0).optional(),
    description: nullableText,
    imageUrl: nullableText,
    kind: z.enum(["residential", "business"]).optional(),
  })
  .strict();

router.patch(
  "/catalog/rent/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = RentEditSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const edit = parsed.data;

    const [cur] = await db.select().from(catalogRent).where(eq(catalogRent.id, id));
    if (!cur) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }

    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const mark = (field: string, prev: unknown, next: unknown): void => {
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) return;
      patch[field] = next ?? null;
      before[field] = prev ?? null;
      after[field] = next ?? null;
    };

    if (edit.name !== undefined) mark("name", cur.name, edit.name);
    if (edit.district !== undefined) mark("district", cur.district, edit.district);
    if (edit.tier !== undefined) mark("tier", cur.tier, edit.tier);
    if (edit.monthlyRent !== undefined) mark("monthlyRent", cur.monthlyRent, edit.monthlyRent);
    if (edit.description !== undefined) mark("description", cur.description, edit.description);
    if (edit.imageUrl !== undefined) mark("imageUrl", cur.imageUrl, edit.imageUrl);
    if (edit.kind !== undefined) mark("kind", cur.kind, edit.kind);

    if (Object.keys(after).length === 0) {
      res.status(400).json({ error: "No changes" });
      return;
    }

    const { ip, ua } = auditMeta(req);
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(catalogRent)
        .set(patch)
        .where(eq(catalogRent.id, id))
        .returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "rent_edit",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_rent",
        targetId: String(id),
        message: `Edited listing "${u.name}"`,
        beforeJson: before as never,
        afterJson: after as never,
      });
      return u;
    });

    // Match the shape returned by GET /catalog/rent (CatalogRent), which
    // includes a computed `occupied` flag, so generated clients stay in sync.
    const [activeLease] = await db
      .select({ listingId: housing.listingId })
      .from(housing)
      .where(eq(housing.listingId, id))
      .limit(1);

    res.json({ ...updated, occupied: !!activeLease });
  },
);

// Permanently delete a property catalog listing. Fixer/admin only. Blocked with
// 409 while the listing is occupied (an active lease points at it via
// housing.listingId) — the tenant must be moved out first so we never silently
// evict a player or orphan their lease. Audit-logged.
router.delete(
  "/catalog/rent/:id",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { ip, ua } = auditMeta(req);
    // Lock the listing row FOR UPDATE, then re-check occupancy and delete while
    // we hold the lock — the same serialization /housing/lease uses. Without
    // this, a lease created between an outside occupancy check and the delete
    // would leave an orphaned housing.listing_id (no FK backs that column).
    let notFound = false;
    let occupantName: string | null = null;
    await db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(catalogRent)
        .where(eq(catalogRent.id, id))
        .for("update");
      if (!cur) {
        notFound = true;
        return;
      }
      const [occupant] = await tx
        .select({ characterName: characters.name })
        .from(housing)
        .innerJoin(characters, eq(characters.id, housing.characterId))
        .where(eq(housing.listingId, id))
        .limit(1);
      if (occupant) {
        occupantName = occupant.characterName;
        return;
      }
      await tx.delete(catalogRent).where(eq(catalogRent.id, id));
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "rent_delete",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_rent",
        targetId: String(id),
        message: `Deleted listing "${cur.name}"`,
        beforeJson: cur as never,
        afterJson: null,
      });
    });
    if (notFound) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    if (occupantName) {
      res.status(409).json({
        error: `This property is occupied by ${occupantName}. Move the tenant out before deleting it.`,
      });
      return;
    }
    res.json({ ok: true });
  },
);

// Create a new property (housing/business) catalog listing. Fixer/admin only.
// `kind` selects residential (player self-lease) vs business (request-only).
// A freshly created listing has no lease, so it is always returned occupied:false
// to match the GET /catalog/rent (CatalogRent) shape.
const RentCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    district: nullableText,
    tier: nullableText,
    monthlyRent: z.number().int().min(0).optional(),
    description: nullableText,
    imageUrl: nullableText,
    kind: z.enum(["residential", "business"]).optional(),
  })
  .strict();

router.post(
  "/catalog/rent",
  requireAnyRole(["ADMIN", "FIXER"]),
  async (req, res): Promise<void> => {
    const parsed = RentCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const values = {
      name: d.name,
      district: d.district ?? null,
      tier: d.tier ?? null,
      monthlyRent: d.monthlyRent ?? 0,
      description: d.description ?? null,
      imageUrl: d.imageUrl ?? null,
      kind: d.kind ?? "residential",
    };
    const { ip, ua } = auditMeta(req);
    const created = await db.transaction(async (tx) => {
      const [l] = await tx.insert(catalogRent).values(values).returning();
      await tx.insert(auditLog).values({
        category: "catalog",
        action: "rent_create",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "catalog_rent",
        targetId: String(l.id),
        message: `Created ${values.kind} listing "${l.name}"`,
        beforeJson: null,
        afterJson: values as never,
      });
      return l;
    });
    res.status(201).json({ ...created, occupied: false });
  },
);

// ======================= CHARACTER TAG OPTIONS (registry) ===================
// A global, reusable catalog of tag names. Staff "create" options here; the
// per-character picker then "adds" existing options to a character (writing
// into characters.manualTags via the archive edit path). Any authenticated
// user may LIST options (the picker needs them); only staff create/delete.
router.get("/directory/tag-options", requireAuth, async (req, res): Promise<void> => {
  // The registry historically only held tags staff explicitly "created", but
  // the Discord importer writes straight into characters.appliedTags and staff
  // add manualTags via the archive edit path — so the registry sat empty while
  // hundreds of tags were already in use, and "Manage Tags" read "No tags yet".
  // Backfill the registry from the UNION of in-use tags (idempotent) so it
  // reflects reality. Gated to staff so a regular member loading the picker
  // never triggers writes; this endpoint's only consumers are staff dialogs.
  const isStaff = hasRole(req.user!.roles, "ADMIN") || hasRole(req.user!.roles, "FIXER");
  if (isStaff) {
    const [existing, tagRows] = await Promise.all([
      db.select({ name: characterTagOptions.name }).from(characterTagOptions),
      db
        .select({ applied: characters.appliedTags, manual: characters.manualTags })
        .from(characters),
    ]);
    const known = new Set(existing.map((r) => r.name.trim().toLowerCase()));
    const toAdd = new Map<string, string>(); // lowercase key -> display name
    for (const row of tagRows) {
      for (const raw of [...(row.applied ?? []), ...(row.manual ?? [])]) {
        const norm = normalizeTag(raw);
        if (!norm) continue;
        const key = norm.toLowerCase();
        if (known.has(key) || toAdd.has(key)) continue;
        toAdd.set(key, norm);
      }
    }
    if (toAdd.size > 0) {
      await db
        .insert(characterTagOptions)
        .values(Array.from(toAdd.values()).map((name) => ({ name, createdById: null })))
        .onConflictDoNothing();
    }
  }
  const rows = await db
    .select()
    .from(characterTagOptions)
    .orderBy(asc(characterTagOptions.name));
  res.json(rows.map((r) => ({ id: r.id, name: r.name })));
});

const TagOptionCreateSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();

router.post("/directory/tag-options", staffOnly, async (req, res): Promise<void> => {
  const parsed = TagOptionCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    return;
  }
  const name = normalizeTag(parsed.data.name);
  // Case-insensitive uniqueness — block "Veteran" vs "veteran" duplicates.
  const [dupe] = await db
    .select({ id: characterTagOptions.id })
    .from(characterTagOptions)
    .where(ilike(characterTagOptions.name, name));
  if (dupe) {
    res.status(409).json({ error: "A tag with that name already exists" });
    return;
  }
  const { ip, ua } = auditMeta(req);
  const created = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(characterTagOptions)
      .values({ name, createdById: req.user!.id })
      .returning();
    await tx.insert(auditLog).values({
      category: "character",
      action: "tag_option_create",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "tag_option",
      targetId: String(t.id),
      message: `Created tag option "${t.name}"`,
      beforeJson: null,
      afterJson: { name: t.name } as never,
    });
    return t;
  });
  res.status(201).json({ id: created.id, name: created.name });
});

// Rename a global tag option. The tag name is denormalized onto every character
// that has it applied (characters.appliedTags / manualTags store the literal
// string), so a rename here must rewrite those arrays too or the option drifts
// away from the tags already on characters. All done in one transaction.
router.patch("/directory/tag-options/:id", staffOnly, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = TagOptionCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    return;
  }
  const name = normalizeTag(parsed.data.name);
  const { ip, ua } = auditMeta(req);
  // Lock the option row FOR UPDATE, then re-read the old name, re-run the
  // case-insensitive uniqueness check, and propagate — all inside the same
  // transaction so a concurrent rename/create can't slip past the CI check
  // (the DB unique index on name is case-sensitive only) or make us propagate
  // a stale old name onto characters' denormalized tag arrays.
  let notFound = false;
  let noChange = false;
  let dupe = false;
  const updated = await db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(characterTagOptions)
      .where(eq(characterTagOptions.id, id))
      .for("update");
    if (!cur) {
      notFound = true;
      return null;
    }
    if (name === cur.name) {
      noChange = true;
      return null;
    }
    const [other] = await tx
      .select({ id: characterTagOptions.id })
      .from(characterTagOptions)
      .where(and(ilike(characterTagOptions.name, name), ne(characterTagOptions.id, id)));
    if (other) {
      dupe = true;
      return null;
    }
    const [t] = await tx
      .update(characterTagOptions)
      .set({ name })
      .where(eq(characterTagOptions.id, id))
      .returning();
    // Propagate the rename to characters that already carry the old tag, in
    // both the importer-owned appliedTags and staff-owned manualTags arrays.
    await tx.execute(sql`
      UPDATE characters
         SET applied_tags = array_replace(applied_tags, ${cur.name}, ${name})
       WHERE ${cur.name} = ANY(applied_tags)
    `);
    await tx.execute(sql`
      UPDATE characters
         SET manual_tags = array_replace(manual_tags, ${cur.name}, ${name})
       WHERE ${cur.name} = ANY(manual_tags)
    `);
    await tx.insert(auditLog).values({
      category: "character",
      action: "tag_option_rename",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "tag_option",
      targetId: String(id),
      message: `Renamed tag option "${cur.name}" → "${name}"`,
      beforeJson: { name: cur.name } as never,
      afterJson: { name } as never,
    });
    return t;
  });
  if (notFound) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (noChange) {
    res.status(400).json({ error: "No change" });
    return;
  }
  if (dupe) {
    res.status(409).json({ error: "A tag with that name already exists" });
    return;
  }
  res.json({ id: updated!.id, name: updated!.name });
});

router.delete("/directory/tag-options/:id", staffOnly, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [cur] = await db.select().from(characterTagOptions).where(eq(characterTagOptions.id, id));
  if (!cur) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { ip, ua } = auditMeta(req);
  await db.transaction(async (tx) => {
    await tx.delete(characterTagOptions).where(eq(characterTagOptions.id, id));
    await tx.insert(auditLog).values({
      category: "character",
      action: "tag_option_delete",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "tag_option",
      targetId: String(id),
      message: `Deleted tag option "${cur.name}"`,
      beforeJson: { name: cur.name } as never,
      afterJson: null,
    });
  });
  res.json({ ok: true });
});

export default router;
