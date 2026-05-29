import { Router, type IRouter } from "express";
import { eq, and, or, ilike, isNull, isNotNull, desc, asc, sql, arrayOverlaps, inArray } from "drizzle-orm";
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
  catalogGuns,
  catalogCyberware,
  catalogRent,
  characterTagOptions,
  housing,
} from "@workspace/db";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { sumCwpByCharacter } from "../lib/cyberware";
import { deriveCyberwareBand } from "../lib/jobs";

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
      appliedTags: characters.appliedTags,
      manualTags: characters.manualTags,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(characters.createdAt))
    .limit(2000);

  res.json(rows.map(({ manualTags, ...r }) => ({ ...r, tags: mergeTags(r.appliedTags, manualTags) })));
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
      fixerDiscordId: characters.fixerDiscordId,
      playerDiscordId: characters.playerDiscordId,
      appliedTags: characters.appliedTags,
      manualTags: characters.manualTags,
      createdAt: characters.createdAt,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(sort === "name" ? asc(characters.name) : desc(characters.createdAt))
    .limit(2000);

  // CWP band is derived from each character's real installed chrome (parsed from
  // their cyberware inventory), so resolve it per row from a single bulk lookup.
  const chromeCounts = await sumCwpByCharacter(rows.map((r) => r.id));
  let out = rows.map(({ appliedTags, manualTags, isOrganic, cyberwareLevel, ...r }) => ({
    ...r,
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
  if (edit.sheetData !== undefined) {
    patch.sheetData = edit.sheetData;
    mark("sheetData", cur.sheetData, edit.sheetData);
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
    notes: nullableText,
    imageUrl: nullableText,
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
      notes: d.notes ?? null,
      imageUrl: d.imageUrl ?? null,
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
    if (edit.notes !== undefined) mark("notes", cur.notes, edit.notes);
    if (edit.imageUrl !== undefined) mark("imageUrl", cur.imageUrl, edit.imageUrl);
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
router.get("/catalog/cyberware", async (_req, res): Promise<void> => {
  res.json(await db.select().from(catalogCyberware));
});
router.get("/catalog/rent", async (_req, res): Promise<void> => {
  // Mark listings that already have an active lease so the UI can
  // disable the LEASE button instead of letting players submit a
  // request that the housing flow would have to reject anyway.
  const [listings, occupied] = await Promise.all([
    db.select().from(catalogRent),
    db
      .selectDistinct({ listingId: housing.listingId })
      .from(housing)
      .where(isNotNull(housing.listingId)),
  ]);
  const occupiedSet = new Set(occupied.map((r) => r.listingId).filter((id): id is number => id != null));
  res.json(listings.map((l) => ({ ...l, occupied: occupiedSet.has(l.id) })));
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

// ======================= CHARACTER TAG OPTIONS (registry) ===================
// A global, reusable catalog of tag names. Staff "create" options here; the
// per-character picker then "adds" existing options to a character (writing
// into characters.manualTags via the archive edit path). Any authenticated
// user may LIST options (the picker needs them); only staff create/delete.
router.get("/directory/tag-options", requireAuth, async (_req, res): Promise<void> => {
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
