import { Router, type IRouter } from "express";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  characters,
  ncpdArrestReports,
  ncpdWarrants,
  ncpdCharacterNotes,
  ncpdLaws,
} from "@workspace/db";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

// NCPD records (arrest reports, warrants, notes, character lookup) are visible
// to NCPD officers, the Commissioner, fixers and admins — NEVER to the
// character's owner just because they own the character. Officer access is
// derived from the id-pinned NCPD role markers (see lib/discord.ts).
const NCPD_GROUPS = ["NCPD", "NCPD_COMMISSIONER", "FIXER", "ADMIN"] as const;
const requireNcpd = requireAnyRole([...NCPD_GROUPS]);
// Book of Laws WRITES are narrower: Commissioner / fixer / admin only —
// rank-and-file officers can read the restricted fields but not edit statutes.
const requireLawWriter = requireAnyRole(["NCPD_COMMISSIONER", "FIXER", "ADMIN"]);

function canSeeRestricted(user: { roles?: string[] | null }): boolean {
  const roles = user.roles ?? [];
  return NCPD_GROUPS.some((g) => hasRole(roles, g));
}

const WARRANT_STATUSES = ["open", "served", "revoked"] as const;
const SEVERITIES = ["misdemeanor", "felony"] as const;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function loadCharacter(id: number) {
  const [c] = await db.select().from(characters).where(eq(characters.id, id));
  return c ?? null;
}

// ---------------------------------------------------------------------------
// Character lookup + full record
// ---------------------------------------------------------------------------

// Lightweight name/id search so officers can find a character number without
// needing the fixer-only archive. Returns identity fields only.
router.get("/ncpd/characters", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const q = str(req.query.q);
  const idNum = q && /^\d+$/.test(q) ? Number(q) : null;
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      archived: characters.archived,
    })
    .from(characters)
    .where(
      q
        ? or(
            ilike(characters.name, `%${q}%`),
            ...(idNum !== null && Number.isSafeInteger(idNum) ? [eq(characters.id, idNum)] : []),
          )
        : sql`true`,
    )
    .orderBy(characters.name)
    .limit(25);
  res.json(rows);
});

// Full NCPD record for one character: identity + arrest reports + warrants +
// NCPD notes. This powers both the /ncpd lookup screen and the staff-only
// "NCPD" tab on the character page.
router.get("/ncpd/characters/:id/record", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) {
    res.status(400).json({ error: "invalid character id" });
    return;
  }
  const c = await loadCharacter(id);
  if (!c) {
    res.status(404).json({ error: "character not found" });
    return;
  }
  const [reports, warrants, notes] = await Promise.all([
    db
      .select()
      .from(ncpdArrestReports)
      .where(eq(ncpdArrestReports.characterId, id))
      .orderBy(desc(ncpdArrestReports.createdAt)),
    db
      .select()
      .from(ncpdWarrants)
      .where(eq(ncpdWarrants.characterId, id))
      .orderBy(desc(ncpdWarrants.createdAt)),
    db
      .select()
      .from(ncpdCharacterNotes)
      .where(eq(ncpdCharacterNotes.characterId, id))
      .orderBy(desc(ncpdCharacterNotes.createdAt)),
  ]);
  res.json({
    character: {
      id: c.id,
      name: c.name,
      kind: c.kind,
      archetype: c.archetype,
      archived: c.archived,
      lifeStatus: c.lifeStatus,
      portraitUrl: c.portraitUrls?.[0] ?? c.portraitUrl ?? null,
    },
    reports,
    warrants,
    notes,
  });
});

// ---------------------------------------------------------------------------
// Arrest reports
// ---------------------------------------------------------------------------

// Recent reports across all characters (NCPD dashboard feed).
router.get("/ncpd/reports", requireAuth, requireNcpd, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      report: ncpdArrestReports,
      characterName: characters.name,
    })
    .from(ncpdArrestReports)
    .innerJoin(characters, eq(characters.id, ncpdArrestReports.characterId))
    .orderBy(desc(ncpdArrestReports.createdAt))
    .limit(100);
  res.json(rows.map((r) => ({ ...r.report, characterName: r.characterName })));
});

router.post("/ncpd/reports", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const { characterId, title, body, charges, arrestedAt } = req.body ?? {};
  const cid = Number(characterId);
  const t = str(title);
  const b = str(body);
  if (!Number.isSafeInteger(cid) || !t || !b) {
    res.status(400).json({ error: "characterId, title and body are required" });
    return;
  }
  const c = await loadCharacter(cid);
  if (!c) {
    res.status(404).json({ error: "character not found" });
    return;
  }
  let arrested: Date | null = null;
  if (arrestedAt != null && arrestedAt !== "") {
    arrested = new Date(arrestedAt);
    if (isNaN(arrested.getTime())) {
      res.status(400).json({ error: "invalid arrestedAt" });
      return;
    }
  }
  const [row] = await db
    .insert(ncpdArrestReports)
    .values({
      characterId: cid,
      officerId: req.user!.id,
      officerName: req.user!.username,
      title: t,
      body: b,
      charges: str(charges),
      arrestedAt: arrested,
    })
    .returning();
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_report_created",
    targetType: "character",
    targetId: cid,
    message: `NCPD arrest report "${t}" filed on ${c.name}`,
    after: row,
  });
  res.status(201).json(row);
});

router.patch("/ncpd/reports/:id", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdArrestReports).where(eq(ncpdArrestReports.id, id));
  if (!existing) {
    res.status(404).json({ error: "report not found" });
    return;
  }
  const { title, body, charges, arrestedAt } = req.body ?? {};
  const patch: Partial<typeof ncpdArrestReports.$inferInsert> = {};
  if (title !== undefined) {
    const t = str(title);
    if (!t) {
      res.status(400).json({ error: "title cannot be empty" });
      return;
    }
    patch.title = t;
  }
  if (body !== undefined) {
    const b = str(body);
    if (!b) {
      res.status(400).json({ error: "body cannot be empty" });
      return;
    }
    patch.body = b;
  }
  if (charges !== undefined) patch.charges = str(charges);
  if (arrestedAt !== undefined) {
    if (arrestedAt === null || arrestedAt === "") {
      patch.arrestedAt = null;
    } else {
      const d = new Date(arrestedAt);
      if (isNaN(d.getTime())) {
        res.status(400).json({ error: "invalid arrestedAt" });
        return;
      }
      patch.arrestedAt = d;
    }
  }
  const [row] = await db
    .update(ncpdArrestReports)
    .set(patch)
    .where(eq(ncpdArrestReports.id, id))
    .returning();
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_report_updated",
    targetType: "character",
    targetId: existing.characterId,
    message: `NCPD arrest report #${id} updated`,
    before: existing,
    after: row,
  });
  res.json(row);
});

router.delete("/ncpd/reports/:id", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdArrestReports).where(eq(ncpdArrestReports.id, id));
  if (!existing) {
    res.status(404).json({ error: "report not found" });
    return;
  }
  await db.delete(ncpdArrestReports).where(eq(ncpdArrestReports.id, id));
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_report_deleted",
    targetType: "character",
    targetId: existing.characterId,
    message: `NCPD arrest report #${id} deleted`,
    before: existing,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Warrants
// ---------------------------------------------------------------------------

router.get("/ncpd/warrants", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const status = str(req.query.status);
  if (status && !WARRANT_STATUSES.includes(status as (typeof WARRANT_STATUSES)[number])) {
    res.status(400).json({ error: "invalid status" });
    return;
  }
  const rows = await db
    .select({ warrant: ncpdWarrants, characterName: characters.name })
    .from(ncpdWarrants)
    .innerJoin(characters, eq(characters.id, ncpdWarrants.characterId))
    .where(status ? eq(ncpdWarrants.status, status) : undefined)
    .orderBy(desc(ncpdWarrants.createdAt))
    .limit(200);
  res.json(rows.map((r) => ({ ...r.warrant, characterName: r.characterName })));
});

router.post("/ncpd/warrants", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const { characterId, reason, notes } = req.body ?? {};
  const cid = Number(characterId);
  const r = str(reason);
  if (!Number.isSafeInteger(cid) || !r) {
    res.status(400).json({ error: "characterId and reason are required" });
    return;
  }
  const c = await loadCharacter(cid);
  if (!c) {
    res.status(404).json({ error: "character not found" });
    return;
  }
  const [row] = await db
    .insert(ncpdWarrants)
    .values({
      characterId: cid,
      issuedById: req.user!.id,
      issuedByName: req.user!.username,
      reason: r,
      notes: str(notes),
    })
    .returning();
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_warrant_issued",
    targetType: "character",
    targetId: cid,
    message: `NCPD warrant issued on ${c.name}: ${r.slice(0, 120)}`,
    after: row,
  });
  res.status(201).json(row);
});

router.patch("/ncpd/warrants/:id", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdWarrants).where(eq(ncpdWarrants.id, id));
  if (!existing) {
    res.status(404).json({ error: "warrant not found" });
    return;
  }
  const { reason, notes, status } = req.body ?? {};
  const patch: Partial<typeof ncpdWarrants.$inferInsert> = {};
  if (reason !== undefined) {
    const r = str(reason);
    if (!r) {
      res.status(400).json({ error: "reason cannot be empty" });
      return;
    }
    patch.reason = r;
  }
  if (notes !== undefined) patch.notes = str(notes);
  if (status !== undefined) {
    if (!WARRANT_STATUSES.includes(status as (typeof WARRANT_STATUSES)[number])) {
      res.status(400).json({ error: "status must be open, served or revoked" });
      return;
    }
    patch.status = status;
  }
  const [row] = await db.update(ncpdWarrants).set(patch).where(eq(ncpdWarrants.id, id)).returning();
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_warrant_updated",
    targetType: "character",
    targetId: existing.characterId,
    message: `NCPD warrant #${id} updated${status !== undefined ? ` (status → ${status})` : ""}`,
    before: existing,
    after: row,
  });
  res.json(row);
});

router.delete("/ncpd/warrants/:id", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdWarrants).where(eq(ncpdWarrants.id, id));
  if (!existing) {
    res.status(404).json({ error: "warrant not found" });
    return;
  }
  await db.delete(ncpdWarrants).where(eq(ncpdWarrants.id, id));
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_warrant_deleted",
    targetType: "character",
    targetId: existing.characterId,
    message: `NCPD warrant #${id} deleted`,
    before: existing,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// NCPD notes on a character
// ---------------------------------------------------------------------------

router.post("/ncpd/characters/:id/notes", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const cid = Number(req.params.id);
  const note = str(req.body?.note);
  if (!Number.isSafeInteger(cid) || !note) {
    res.status(400).json({ error: "note is required" });
    return;
  }
  const c = await loadCharacter(cid);
  if (!c) {
    res.status(404).json({ error: "character not found" });
    return;
  }
  const [row] = await db
    .insert(ncpdCharacterNotes)
    .values({
      characterId: cid,
      authorId: req.user!.id,
      authorName: req.user!.username,
      note,
    })
    .returning();
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_note_added",
    targetType: "character",
    targetId: cid,
    message: `NCPD note added to ${c.name}`,
    after: row,
  });
  res.status(201).json(row);
});

router.delete("/ncpd/notes/:id", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdCharacterNotes).where(eq(ncpdCharacterNotes.id, id));
  if (!existing) {
    res.status(404).json({ error: "note not found" });
    return;
  }
  await db.delete(ncpdCharacterNotes).where(eq(ncpdCharacterNotes.id, id));
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_note_deleted",
    targetType: "character",
    targetId: existing.characterId,
    message: `NCPD note #${id} deleted`,
    before: existing,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Book of Laws
// ---------------------------------------------------------------------------

// Public (any signed-in member) list of laws. Severity, punishment and
// restricted notes are stripped SERVER-SIDE for viewers outside NCPD/fixer/
// admin — the restriction must never rely on the client hiding fields.
router.get("/ncpd/laws", requireAuth, async (req, res): Promise<void> => {
  const privileged = canSeeRestricted(req.user!);
  const rows = await db
    .select()
    .from(ncpdLaws)
    .orderBy(ncpdLaws.sortOrder, ncpdLaws.id);
  res.json(
    rows.map((l) =>
      privileged
        ? l
        : {
            id: l.id,
            title: l.title,
            body: l.body,
            sortOrder: l.sortOrder,
            createdAt: l.createdAt,
            updatedAt: l.updatedAt,
          },
    ),
  );
});

router.post("/ncpd/laws", requireAuth, requireLawWriter, async (req, res): Promise<void> => {
  const { title, body, severity, punishment, restrictedNotes, sortOrder } = req.body ?? {};
  const t = str(title);
  const b = str(body);
  if (!t || !b) {
    res.status(400).json({ error: "title and body are required" });
    return;
  }
  if (severity != null && severity !== "" && !SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) {
    res.status(400).json({ error: "severity must be misdemeanor or felony" });
    return;
  }
  const [row] = await db
    .insert(ncpdLaws)
    .values({
      title: t,
      body: b,
      severity: str(severity),
      punishment: str(punishment),
      restrictedNotes: str(restrictedNotes),
      sortOrder: Number.isSafeInteger(Number(sortOrder)) ? Number(sortOrder) : 0,
      createdById: req.user!.id,
    })
    .returning();
  void recordAudit({
    req,
    category: "admin",
    action: "ncpd_law_created",
    targetType: "ncpd_law",
    targetId: row.id,
    message: `Law "${t}" added to the Book of Laws`,
    after: row,
  });
  res.status(201).json(row);
});

router.patch("/ncpd/laws/:id", requireAuth, requireLawWriter, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdLaws).where(eq(ncpdLaws.id, id));
  if (!existing) {
    res.status(404).json({ error: "law not found" });
    return;
  }
  const { title, body, severity, punishment, restrictedNotes, sortOrder } = req.body ?? {};
  const patch: Partial<typeof ncpdLaws.$inferInsert> = {};
  if (title !== undefined) {
    const t = str(title);
    if (!t) {
      res.status(400).json({ error: "title cannot be empty" });
      return;
    }
    patch.title = t;
  }
  if (body !== undefined) {
    const b = str(body);
    if (!b) {
      res.status(400).json({ error: "body cannot be empty" });
      return;
    }
    patch.body = b;
  }
  if (severity !== undefined) {
    if (severity != null && severity !== "" && !SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) {
      res.status(400).json({ error: "severity must be misdemeanor or felony" });
      return;
    }
    patch.severity = str(severity);
  }
  if (punishment !== undefined) patch.punishment = str(punishment);
  if (restrictedNotes !== undefined) patch.restrictedNotes = str(restrictedNotes);
  if (sortOrder !== undefined) {
    const n = Number(sortOrder);
    if (!Number.isSafeInteger(n)) {
      res.status(400).json({ error: "invalid sortOrder" });
      return;
    }
    patch.sortOrder = n;
  }
  const [row] = await db.update(ncpdLaws).set(patch).where(eq(ncpdLaws.id, id)).returning();
  void recordAudit({
    req,
    category: "admin",
    action: "ncpd_law_updated",
    targetType: "ncpd_law",
    targetId: id,
    message: `Law "${row.title}" updated`,
    before: existing,
    after: row,
  });
  res.json(row);
});

router.delete("/ncpd/laws/:id", requireAuth, requireLawWriter, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdLaws).where(eq(ncpdLaws.id, id));
  if (!existing) {
    res.status(404).json({ error: "law not found" });
    return;
  }
  await db.delete(ncpdLaws).where(eq(ncpdLaws.id, id));
  void recordAudit({
    req,
    category: "admin",
    action: "ncpd_law_deleted",
    targetType: "ncpd_law",
    targetId: id,
    message: `Law "${existing.title}" removed from the Book of Laws`,
    before: existing,
  });
  res.json({ ok: true });
});

export default router;
