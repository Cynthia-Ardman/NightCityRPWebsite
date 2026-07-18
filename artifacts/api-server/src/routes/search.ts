import { Router, type IRouter, type Request } from "express";
import { and, eq, ilike, or, sql, desc, asc } from "drizzle-orm";
import {
  db,
  characters,
  missions,
  loreEntries,
  guidebookPages,
  stores,
  ripperdocs,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { canSeeNcpdRecords } from "./ncpd";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Site-wide search (Ctrl+K command palette).
//
// One endpoint, grouped results, each group scoped with the SAME authorization
// predicate its existing list endpoint enforces:
//   - characters: roster metadata only, no sheet-body fields. The href must
//     land on a page the caller can actually OPEN: the archive detail
//     (/directory/characters/:id) is fixer/admin-only in the portal, and the
//     player character page (/characters/:id) is owned-or-staff server-side.
//     So staff search the full roster (non-owned rows flagged staffOnly with
//     archive hrefs, for View-as scrubbing) while players search their OWN
//     characters (player hrefs).
//   - missions: non-managers only see workflowState = 'posted' (mirrors
//     listMissionSummaries); managers (FIXER/ADMIN) see the full pipeline.
//   - lore: public-safe fields only (name/summary/aliases — never fixerBody),
//     mirroring /directory/lore.
//   - guidebook: any authed user, title/description/source only (matches the
//     "short fields" scope of the palette; /guidebook itself is auth-only).
//   - venues (stores + clinics): the directory list is public, so any authed
//     user gets these.
//   - ncpd: identity-only character hits, gated on the same role set as
//     /ncpd/* (NCPD / Commissioner / Fixer / Admin).
//
// Every item carries a portal `href` so the client never re-derives routing.
// ---------------------------------------------------------------------------

const GROUP_LIMIT = 8;

type SearchItem = {
  href: string;
  name: string;
  subtitle: string | null;
  imageUrl: string | null;
  // True when the row is only visible because the caller holds a staff or
  // officer role. The portal also hides these under "View as player".
  staffOnly?: boolean;
};

function isManager(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return hasRole(roles, "ADMIN") || hasRole(roles, "FIXER");
}

router.get("/search", requireAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const empty = {
    characters: [] as SearchItem[],
    missions: [] as SearchItem[],
    lore: [] as SearchItem[],
    guidebook: [] as SearchItem[],
    venues: [] as SearchItem[],
    ncpd: [] as SearchItem[],
  };
  if (q.length < 2) {
    res.json(empty);
    return;
  }
  const like = `%${q}%`;
  const manager = isManager(req);
  const ncpdAllowed = canSeeNcpdRecords(req.user!);

  const [charRows, missionRows, loreRows, guideRows, storeRows, clinicRows] =
    await Promise.all([
      // Roster-tile fields only — identical scope to /directory/characters.
      db
        .select({
          id: characters.id,
          ownerId: characters.ownerId,
          name: characters.name,
          kind: characters.kind,
          archetype: characters.archetype,
          portraitUrl: characters.portraitUrl,
          portraitUrls: characters.portraitUrls,
        })
        .from(characters)
        .where(
          and(
            or(ilike(characters.name, like), ilike(characters.legacyDiscordUsername, like)),
            // Non-staff can only open their OWN character pages, so only
            // those are searchable for them (see header comment).
            ...(manager ? [] : [eq(characters.ownerId, req.user!.id)]),
          ),
        )
        .orderBy(characters.archived, asc(characters.name))
        .limit(GROUP_LIMIT),
      db
        .select({
          id: missions.id,
          title: missions.title,
          tier: missions.tier,
          status: missions.status,
          workflowState: missions.workflowState,
        })
        .from(missions)
        .where(
          and(
            ilike(missions.title, like),
            // Same visibility rule as listMissionSummaries: players only ever
            // see posted missions; managers see the whole pipeline.
            ...(manager ? [] : [eq(missions.workflowState, "posted")]),
          ),
        )
        .orderBy(desc(missions.createdAt))
        .limit(GROUP_LIMIT),
      // Public-safe lore fields only — never the fixer-only body.
      db
        .select({
          id: loreEntries.id,
          name: loreEntries.name,
          category: loreEntries.category,
          summary: loreEntries.summary,
          imageUrl: loreEntries.imageUrl,
        })
        .from(loreEntries)
        .where(
          or(
            ilike(loreEntries.name, like),
            ilike(loreEntries.summary, like),
            sql`array_to_string(${loreEntries.aliases}, ' ') ILIKE ${like}`,
          ),
        )
        .orderBy(asc(loreEntries.name))
        .limit(GROUP_LIMIT),
      db
        .select({
          id: guidebookPages.id,
          title: guidebookPages.title,
          section: guidebookPages.section,
          description: guidebookPages.description,
        })
        .from(guidebookPages)
        .where(
          or(
            ilike(guidebookPages.title, like),
            ilike(guidebookPages.description, like),
            ilike(guidebookPages.sourceLabel, like),
          ),
        )
        .orderBy(asc(guidebookPages.position), asc(guidebookPages.title))
        .limit(GROUP_LIMIT),
      db
        .select({ id: stores.id, name: stores.name, location: stores.location, bannerUrl: stores.bannerUrl })
        .from(stores)
        .where(or(ilike(stores.name, like), ilike(stores.location, like)))
        .orderBy(asc(stores.name))
        .limit(GROUP_LIMIT),
      db
        .select({ id: ripperdocs.id, name: ripperdocs.name, location: ripperdocs.location, bannerUrl: ripperdocs.bannerUrl })
        .from(ripperdocs)
        .where(or(ilike(ripperdocs.name, like), ilike(ripperdocs.location, like)))
        .orderBy(asc(ripperdocs.name))
        .limit(GROUP_LIMIT),
    ]);

  // NCPD hits are the same identity-only projection /ncpd/characters returns,
  // linking into the rap-sheet screen. Role-gated exactly like the ncpd router.
  const ncpdRows = ncpdAllowed
    ? await db
        .select({ id: characters.id, name: characters.name, archetype: characters.archetype })
        .from(characters)
        .where(ilike(characters.name, like))
        .orderBy(asc(characters.name))
        .limit(GROUP_LIMIT)
    : [];

  res.json({
    characters: charRows.map((c) => {
      // View-as safety: rows the caller could only reach via the staff
      // archive are flagged staffOnly (and use the archive href) so the
      // client can hide them when the EFFECTIVE role is a plain player.
      // Owned rows always use the player page, which works for any role.
      const owned = c.ownerId === req.user!.id;
      return {
        href: owned ? `/characters/${c.id}` : `/directory/characters/${c.id}`,
        name: c.name,
        subtitle: c.archetype ?? (c.kind === "npc" ? "NPC" : "Character"),
        imageUrl: c.portraitUrls?.[0] ?? c.portraitUrl ?? null,
        ...(owned ? {} : { staffOnly: true }),
      };
    }),
    missions: missionRows.map((m) => ({
      href: `/missions/${m.id}`,
      name: m.title,
      subtitle: `Tier ${m.tier}${manager && m.workflowState !== "posted" ? ` · ${m.workflowState}` : ""}`,
      imageUrl: null,
      staffOnly: m.workflowState !== "posted",
    })),
    lore: loreRows.map((l) => ({
      href: `/directory/lore/${l.id}`,
      name: l.name,
      subtitle: l.category ?? null,
      imageUrl: l.imageUrl ?? null,
    })),
    guidebook: guideRows.map((g) => ({
      href: `/guidebook/${g.id}`,
      name: g.title,
      subtitle: g.section ?? null,
      imageUrl: null,
    })),
    venues: [
      ...storeRows.map((s) => ({
        href: `/directory/stores/${s.id}`,
        name: s.name,
        subtitle: s.location ? `Store · ${s.location}` : "Store",
        imageUrl: s.bannerUrl ?? null,
      })),
      ...clinicRows.map((r) => ({
        href: `/directory/ripperdocs/${r.id}`,
        name: r.name,
        subtitle: r.location ? `Clinic · ${r.location}` : "Clinic",
        imageUrl: r.bannerUrl ?? null,
      })),
      // Stores + clinics are queried separately (each capped), so re-cap the
      // merged group to keep every palette group at the same size.
    ].slice(0, GROUP_LIMIT),
    ncpd: ncpdRows.map((c) => ({
      href: `/ncpd/characters/${c.id}`,
      name: c.name,
      subtitle: c.archetype ? `NCPD record · ${c.archetype}` : "NCPD record",
      imageUrl: null,
      staffOnly: true,
    })),
  });
});

export default router;
