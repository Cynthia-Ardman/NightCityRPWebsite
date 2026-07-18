import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  users,
  characters,
  ncpdArrestReports,
  ncpdWarrants,
  ncpdCharacterNotes,
  ncpdLaws,
  ncpdFines,
  stores,
  storeEmployees,
  ripperdocs,
  ripperdocEmployees,
  housing,
} from "@workspace/db";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import { hasRole, sendDirectMessage } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import { getBalance } from "../lib/unbelievaboat";
import { applyWalletDelta } from "../lib/economy";

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

// Exported so the site-wide search can gate its NCPD result group on the
// EXACT same predicate this router enforces (never a forked copy).
export function canSeeNcpdRecords(user: { roles?: string[] | null }): boolean {
  const roles = user.roles ?? [];
  return NCPD_GROUPS.some((g) => hasRole(roles, g));
}
const canSeeRestricted = canSeeNcpdRecords;

const WARRANT_STATUSES = ["open", "served", "revoked"] as const;
const SEVERITIES = ["infraction", "misdemeanor", "felony"] as const;

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
  // Dossier intel alongside the rap sheet: known affiliations (forum +
  // manual tags), places of employment, businesses owned, residences/leases
  // and how much money the suspect's account holds. The wallet is USER-level
  // (UnbelievaBoat), so an unclaimed character has no readable balance —
  // return null rather than 0 so the UI can say "UNKNOWN". allowStale is fine
  // here: a dossier is intel, not a money-moving path.
  const [reports, warrants, notes, fines, employmentStores, employmentClinics, ownedStores, ownedClinics, leases, balance] =
    await Promise.all([
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
      db
        .select()
        .from(ncpdFines)
        .where(eq(ncpdFines.characterId, id))
        .orderBy(desc(ncpdFines.createdAt)),
      db
        .select({ venueId: stores.id, venueName: stores.name, location: stores.location, role: storeEmployees.role })
        .from(storeEmployees)
        .innerJoin(stores, eq(stores.id, storeEmployees.storeId))
        .where(eq(storeEmployees.characterId, id)),
      db
        .select({ venueId: ripperdocs.id, venueName: ripperdocs.name, location: ripperdocs.location, role: ripperdocEmployees.role })
        .from(ripperdocEmployees)
        .innerJoin(ripperdocs, eq(ripperdocs.id, ripperdocEmployees.ripperdocId))
        .where(eq(ripperdocEmployees.characterId, id)),
      db
        .select({ venueId: stores.id, venueName: stores.name, location: stores.location })
        .from(stores)
        .where(eq(stores.ownerCharacterId, id)),
      db
        .select({ venueId: ripperdocs.id, venueName: ripperdocs.name, location: ripperdocs.location })
        .from(ripperdocs)
        .where(eq(ripperdocs.ownerCharacterId, id)),
      db
        .select({
          id: housing.id,
          address: housing.address,
          district: housing.district,
          tier: housing.tier,
          kind: housing.kind,
          monthlyRent: housing.monthlyRent,
        })
        .from(housing)
        .where(eq(housing.characterId, id)),
      c.ownerId ? getBalance(c.ownerId, { allowStale: true }) : Promise.resolve(null),
    ]);
  const tagSet = new Set<string>();
  for (const t of [...(c.appliedTags ?? []), ...(c.manualTags ?? [])]) {
    const v = typeof t === "string" ? t.trim() : "";
    if (v) tagSet.add(v);
  }
  res.json({
    character: {
      id: c.id,
      name: c.name,
      kind: c.kind,
      archetype: c.archetype,
      archived: c.archived,
      lifeStatus: c.lifeStatus,
      portraitUrl: c.portraitUrls?.[0] ?? c.portraitUrl ?? null,
      tags: [...tagSet],
    },
    reports,
    warrants,
    notes,
    fines,
    employment: [
      ...employmentStores.map((e) => ({ ...e, venueType: "store" as const })),
      ...employmentClinics.map((e) => ({ ...e, venueType: "ripperdoc" as const })),
    ],
    businesses: [
      ...ownedStores.map((b) => ({ ...b, venueType: "store" as const })),
      ...ownedClinics.map((b) => ({ ...b, venueType: "ripperdoc" as const })),
    ],
    housing: leases,
    balance: typeof balance?.total === "number" ? balance.total : null,
  });
});

// ---------------------------------------------------------------------------
// Officer roster
// ---------------------------------------------------------------------------

// The NCPD roster: every user who holds an id-derived NCPD role marker
// (officer or commissioner), paired with their player characters. Officer
// membership is a USER-level Discord fact (not per-character), so we resolve
// the members first and then attach each one's PCs. We load the small user
// set in full and filter with the same hasRole() the access gate uses, so the
// roster can never drift from who actually has clearance (matching a role
// renamed in Discord but still id-pinned).
router.get("/ncpd/officers", requireAuth, requireNcpd, async (_req, res): Promise<void> => {
  const allUsers = await db
    .select({
      id: users.id,
      username: users.username,
      globalName: users.globalName,
      avatarUrl: users.avatarUrl,
      roles: users.roles,
    })
    .from(users);
  const officers = allUsers
    .map((u) => ({ ...u, roles: u.roles ?? [] }))
    .filter((u) => hasRole(u.roles, "NCPD") || hasRole(u.roles, "NCPD_COMMISSIONER"));

  const officerIds = officers.map((u) => u.id);
  const chars = officerIds.length
    ? await db
        .select({
          id: characters.id,
          name: characters.name,
          ownerId: characters.ownerId,
          archetype: characters.archetype,
          lifeStatus: characters.lifeStatus,
          archived: characters.archived,
          portraitUrl: characters.portraitUrl,
          portraitUrls: characters.portraitUrls,
        })
        .from(characters)
        // Officer status is a USER-level Discord role, but a player who holds
        // it may run several PCs of which only one is actually a cop. The
        // roster should list the NCPD characters, not every character the
        // officer owns. The source of truth is the explicit NCPD self-declaration
        // flag on the sheet (sheetData.ncpd, mirrored from the character-sheet
        // checkbox). We also keep the legacy archetype match (e.g. "NCPD / Beat
        // Patrol") as a fallback so characters created before the checkbox still
        // surface until staff set the flag.
        .where(
          and(
            inArray(characters.ownerId, officerIds),
            eq(characters.kind, "pc"),
            or(
              sql`(${characters.sheetData} ->> 'ncpd') = 'true'`,
              ilike(characters.archetype, "%ncpd%"),
            ),
          ),
        )
        .orderBy(characters.archived, characters.name)
    : [];

  const charsByOwner = new Map<string, typeof chars>();
  for (const ch of chars) {
    if (!ch.ownerId) continue;
    const list = charsByOwner.get(ch.ownerId) ?? [];
    list.push(ch);
    charsByOwner.set(ch.ownerId, list);
  }

  const roster = officers
    .map((u) => ({
      userId: u.id,
      displayName: u.globalName?.trim() || u.username,
      avatarUrl: u.avatarUrl ?? null,
      isCommissioner: hasRole(u.roles, "NCPD_COMMISSIONER"),
      characters: (charsByOwner.get(u.id) ?? []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        archetype: ch.archetype,
        lifeStatus: ch.lifeStatus,
        archived: ch.archived,
        portraitUrl: ch.portraitUrls?.[0] ?? ch.portraitUrl ?? null,
      })),
    }))
    // Commissioner(s) lead the roster, then alphabetical by display name.
    .sort((a, b) => {
      if (a.isCommissioner !== b.isCommissioner) return a.isCommissioner ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

  res.json(roster);
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
// Fines
// ---------------------------------------------------------------------------
//
// An officer issues a fine against a character; the character's CURRENT owner
// pays it from their UnbelievaBoat wallet. Issuing is NCPD-gated; paying and
// listing "my fines" are owner-scoped and open to any authenticated player.

// Player-facing: every fine levied on a character the requester currently owns
// (surfaced in the portal's Inbox page). Ordered newest first, unpaid
// before paid so outstanding balances lead.
router.get("/ncpd/fines/mine", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select({ fine: ncpdFines, characterName: characters.name })
    .from(ncpdFines)
    .innerJoin(characters, eq(characters.id, ncpdFines.characterId))
    .where(and(eq(characters.ownerId, req.user!.id), or(eq(ncpdFines.status, "unpaid"), eq(ncpdFines.status, "paid"))))
    .orderBy(desc(ncpdFines.createdAt));
  res.json(rows.map((r) => ({ ...r.fine, characterName: r.characterName })));
});

// Officer issues a fine. Amount is always positive eddies.
router.post("/ncpd/fines", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const { characterId, amount, reason } = req.body ?? {};
  const cid = Number(characterId);
  const amt = Number(amount);
  const r = str(reason);
  if (!Number.isSafeInteger(cid) || !r) {
    res.status(400).json({ error: "characterId and reason are required" });
    return;
  }
  if (!Number.isSafeInteger(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive whole number" });
    return;
  }
  const c = await loadCharacter(cid);
  if (!c) {
    res.status(404).json({ error: "character not found" });
    return;
  }
  const [row] = await db
    .insert(ncpdFines)
    .values({
      characterId: cid,
      issuedById: req.user!.id,
      officerName: req.user!.username,
      amount: amt,
      reason: r,
    })
    .returning();
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_fine_issued",
    targetType: "character",
    targetId: cid,
    message: `NCPD fine of €$${amt.toLocaleString()} issued to ${c.name}: ${r}`,
    after: row,
  });
  // Best-effort DM to the character's current owner so they know to pay it.
  if (c.ownerId) {
    void (async () => {
      const [owner] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, c.ownerId!));
      if (owner?.discordId) {
        await sendDirectMessage(
          owner.discordId,
          `🚨 **NCPD Fine Issued** — ${c.name} has been fined **€$${amt.toLocaleString()}**.\nReason: ${r}\nPay it from the "Inbox" page in the Night City portal.`,
        );
      }
    })();
  }
  res.status(201).json(row);
});

// Officer voids an UNPAID fine (issued in error). Paid fines are permanent.
router.delete("/ncpd/fines/:id", requireAuth, requireNcpd, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ncpdFines).where(eq(ncpdFines.id, id));
  if (!existing) {
    res.status(404).json({ error: "fine not found" });
    return;
  }
  if (existing.status !== "unpaid") {
    res.status(409).json({ error: "only unpaid fines can be voided" });
    return;
  }
  const [row] = await db
    .update(ncpdFines)
    .set({ status: "void" })
    .where(and(eq(ncpdFines.id, id), eq(ncpdFines.status, "unpaid")))
    .returning();
  if (!row) {
    res.status(409).json({ error: "fine is no longer unpaid" });
    return;
  }
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_fine_voided",
    targetType: "character",
    targetId: existing.characterId,
    message: `NCPD fine #${id} voided`,
    before: existing,
    after: row,
  });
  res.json(row);
});

// Player pays an outstanding fine. Must be the character's CURRENT owner. The
// debit goes through applyWalletDelta (idempotent, reserve-before-call) with
// the characterId set so the charge appears in the character's wallet history.
router.post("/ncpd/fines/:id/pay", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) {
    res.status(400).json({ error: "invalid fine id" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    // Lock the fine row so two concurrent pay attempts can't both debit.
    const [fine] = await tx.select().from(ncpdFines).where(eq(ncpdFines.id, id)).for("update");
    if (!fine) return { http: 404 as const, error: "fine not found" };
    const [c] = await tx.select().from(characters).where(eq(characters.id, fine.characterId));
    if (!c) return { http: 404 as const, error: "character not found" };
    // Gate on the CURRENT owner, never a snapshot taken at issue time.
    if (c.ownerId !== req.user!.id) return { http: 403 as const, error: "you do not own this character" };
    if (fine.status === "paid") return { http: 409 as const, error: "fine already paid" };
    if (fine.status !== "unpaid") return { http: 409 as const, error: "fine is not payable" };

    const [owner] = await tx.select({ discordId: users.discordId }).from(users).where(eq(users.id, req.user!.id));
    if (!owner?.discordId) return { http: 400 as const, error: "your account has no linked Discord wallet" };

    const debit = await applyWalletDelta({
      userId: req.user!.id,
      discordId: owner.discordId,
      amount: -fine.amount,
      source: "website",
      kind: "ncpd_fine",
      reason: `NCPD fine: ${fine.reason}`,
      characterId: fine.characterId,
      relatedEntityType: "ncpd_fine",
      relatedEntityId: fine.id,
      idempotencyKey: `ncpd-fine:${fine.id}`,
    });
    if (!debit.ok) {
      if (debit.status === "insufficient_funds") {
        return { http: 402 as const, error: "Insufficient funds to pay this fine." };
      }
      if (debit.status === "disabled") {
        return { http: 409 as const, error: "The economy is currently disabled." };
      }
      if (debit.status === "dry_run") {
        // Test mode: no money moved. Still mark the fine paid so flows are testable.
      } else {
        return { http: 409 as const, error: debit.error ?? "Payment could not be processed." };
      }
    }
    const [row] = await tx
      .update(ncpdFines)
      .set({ status: "paid", paidAt: new Date(), paidByUserId: req.user!.id })
      .where(and(eq(ncpdFines.id, id), eq(ncpdFines.status, "unpaid")))
      .returning();
    if (!row) return { http: 409 as const, error: "fine is no longer unpaid" };
    return { http: 200 as const, fine: row, character: c };
  });

  if (result.http !== 200) {
    res.status(result.http).json({ error: result.error });
    return;
  }

  const fine = result.fine;
  const c = result.character;
  void recordAudit({
    req,
    category: "character",
    action: "ncpd_fine_paid",
    targetType: "character",
    targetId: fine.characterId,
    message: `NCPD fine #${fine.id} of €$${fine.amount.toLocaleString()} paid`,
    after: fine,
  });
  // Notify the issuing officer that the fine was settled.
  if (fine.issuedById) {
    void (async () => {
      const [officer] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, fine.issuedById!));
      if (officer?.discordId) {
        await sendDirectMessage(
          officer.discordId,
          `✅ **NCPD Fine Paid** — ${c.name} has paid the €$${fine.amount.toLocaleString()} fine you issued.\nReason: ${fine.reason}`,
        );
      }
    })();
  }
  res.json(fine);
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
    res.status(400).json({ error: "severity must be infraction, misdemeanor or felony" });
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
      res.status(400).json({ error: "severity must be infraction, misdemeanor or felony" });
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
