import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  loreEntries,
  lorePendingEdits,
  loreImportDrafts,
  users,
  type LoreEntry,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { runLoreImport, type LoreSourceRef } from "../lib/loreImport";

// Lore Directory: public world-lore entries (Corporations / Gangs / Factions /
// Miscellaneous) with a PUBLIC body for everyone plus a FIXER-ONLY body and
// source references visible only to staff. Admins author/publish directly;
// fixers propose changes that an admin approves (surfaced in Pending Requests).
// Imported lore lands in a staff review queue (loreImportDrafts) first.

const router: IRouter = Router();

// A db handle or an in-flight transaction — helpers run on either.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const CATEGORIES = ["corporation", "gang", "faction", "misc"] as const;
const categoryEnum = z.enum(CATEGORIES);
const sourceSchema = z.object({ label: z.string().min(1), url: z.string().min(1) });

const entryInputSchema = z.object({
  category: categoryEnum,
  name: z.string().trim().min(1),
  summary: z.string().nullish(),
  responsibleFixer: z.string().nullish(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  publicBody: z.string().optional(),
  fixerBody: z.string().nullish(),
  sources: z.array(sourceSchema).optional(),
});
const entryUpdateSchema = entryInputSchema.partial();

function isAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN");
}
function isFixerOrAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN") || hasRole(user.roles, "FIXER");
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "entry"
  );
}

// Generate a slug unique against existing entries (suffixing -2, -3, ... on
// collision). Runs on the provided executor so it can be used inside a txn.
async function uniqueSlug(executor: Executor, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const [hit] = await executor
      .select({ id: loreEntries.id })
      .from(loreEntries)
      .where(eq(loreEntries.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

function sourcesOf(raw: unknown): LoreSourceRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is LoreSourceRef =>
      !!s && typeof s === "object" && typeof (s as LoreSourceRef).url === "string",
  );
}

function shapeEntry(row: LoreEntry, canViewFixer: boolean): Record<string, unknown> {
  const sources = sourcesOf(row.sources);
  const hasFixerContent = !!(row.fixerBody && row.fixerBody.trim()) || sources.length > 0;
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    slug: row.slug,
    aliases: row.aliases ?? [],
    summary: row.summary ?? null,
    responsibleFixer: row.responsibleFixer ?? null,
    publicBody: row.publicBody ?? "",
    fixerBody: canViewFixer ? (row.fixerBody ?? null) : null,
    sources: canViewFixer ? sources : [],
    canViewFixer,
    hasFixerContent,
    createdById: row.createdById ?? null,
    updatedById: row.updatedById ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function shapeSummary(row: LoreEntry): Record<string, unknown> {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    slug: row.slug,
    aliases: row.aliases ?? [],
    summary: row.summary ?? null,
    responsibleFixer: row.responsibleFixer ?? null,
    hasFixerContent: !!(row.fixerBody && row.fixerBody.trim()) || sourcesOf(row.sources).length > 0,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- Public read -----------------------------------------------------------

// List entries. Any signed-in user; optional category + free-text filter.
router.get("/directory/lore", requireAuth, async (req, res): Promise<void> => {
  const category = req.query.category ? String(req.query.category) : null;
  const q = req.query.q ? String(req.query.q).trim() : "";
  const clauses = [];
  if (category && (CATEGORIES as readonly string[]).includes(category)) {
    clauses.push(eq(loreEntries.category, category));
  }
  if (q) {
    clauses.push(or(ilike(loreEntries.name, `%${q}%`), ilike(loreEntries.summary, `%${q}%`)));
  }
  const where = clauses.length ? and(...clauses) : undefined;
  const rows = (await db
    .select()
    .from(loreEntries)
    .where(where)
    .orderBy(desc(loreEntries.updatedAt))) as LoreEntry[];
  res.json(rows.map(shapeSummary));
});

// ---- Fixer-proposed edits (must be declared before /:id to avoid capture) ---

const proposalSchema = z.object({
  loreEntryId: z.number().int().nullable().optional(),
  kind: z.enum(["create", "edit"]),
  diff: entryUpdateSchema,
  updateNote: z.string().nullish(),
});

// List proposed lore edits (fixer/admin). Defaults to pending.
router.get("/directory/lore/edits", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const status = String(req.query.status ?? "pending");
  const rows = await db
    .select({
      id: lorePendingEdits.id,
      loreEntryId: lorePendingEdits.loreEntryId,
      entryName: loreEntries.name,
      kind: lorePendingEdits.kind,
      submittedBy: lorePendingEdits.submittedBy,
      submittedByName: users.username,
      proposedDiff: lorePendingEdits.proposedDiff,
      beforeSnapshot: lorePendingEdits.beforeSnapshot,
      updateNote: lorePendingEdits.updateNote,
      status: lorePendingEdits.status,
      decidedById: lorePendingEdits.decidedById,
      decisionSummary: lorePendingEdits.decisionSummary,
      decidedAt: lorePendingEdits.decidedAt,
      appliedEntryId: lorePendingEdits.appliedEntryId,
      createdAt: lorePendingEdits.createdAt,
    })
    .from(lorePendingEdits)
    .leftJoin(loreEntries, eq(loreEntries.id, lorePendingEdits.loreEntryId))
    .leftJoin(users, eq(users.id, lorePendingEdits.submittedBy))
    .where(eq(lorePendingEdits.status, status))
    .orderBy(desc(lorePendingEdits.createdAt));
  res.json(
    rows.map((r) => ({
      ...r,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

// Submit a lore create/edit proposal for admin approval (fixer/admin).
router.post("/directory/lore/edits", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const parsed = proposalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const { kind, diff, updateNote } = parsed.data;
  let loreEntryId = parsed.data.loreEntryId ?? null;
  let beforeSnapshot: Record<string, unknown> = {};

  if (kind === "edit") {
    if (!loreEntryId) {
      res.status(400).json({ error: "loreEntryId is required for an edit proposal" });
      return;
    }
    const [entry] = await db.select().from(loreEntries).where(eq(loreEntries.id, loreEntryId));
    if (!entry) {
      res.status(400).json({ error: "Lore entry not found" });
      return;
    }
    // Snapshot only the fields named in the diff, captured now so the
    // reviewer's before/after view doesn't drift if the entry changes later.
    for (const key of Object.keys(diff)) {
      beforeSnapshot[key] = (entry as Record<string, unknown>)[key] ?? null;
    }
  } else {
    loreEntryId = null;
    if (!diff.name || !diff.category) {
      res.status(400).json({ error: "name and category are required for a create proposal" });
      return;
    }
  }

  const [inserted] = await db
    .insert(lorePendingEdits)
    .values({
      loreEntryId,
      kind,
      submittedBy: req.user!.id,
      proposedDiff: diff as never,
      beforeSnapshot: beforeSnapshot as never,
      updateNote: updateNote ?? null,
    })
    .returning();

  await recordAudit({
    req,
    category: "lore",
    action: "lore_edit_submit",
    targetType: "lore_pending_edit",
    targetId: inserted.id,
    message: `Proposed lore ${kind}: ${diff.name ?? `entry #${loreEntryId}`}`,
    after: { kind, loreEntryId, diff },
  });

  res.status(201).json({
    ...inserted,
    decidedAt: inserted.decidedAt ? inserted.decidedAt.toISOString() : null,
    createdAt: inserted.createdAt.toISOString(),
    entryName: null,
    submittedByName: req.user!.username,
  });
});

// Apply a proposed diff onto a (new or existing) entry. Used by approve.
async function applyProposal(
  tx: Executor,
  edit: typeof lorePendingEdits.$inferSelect,
  actorId: string,
): Promise<LoreEntry> {
  const diff = (edit.proposedDiff ?? {}) as z.infer<typeof entryUpdateSchema>;
  if (edit.kind === "create") {
    const name = diff.name!;
    const slug = await uniqueSlug(tx, name);
    const [created] = await tx
      .insert(loreEntries)
      .values({
        category: diff.category ?? "misc",
        name,
        slug,
        aliases: diff.aliases ?? [],
        summary: diff.summary ?? null,
        responsibleFixer: diff.responsibleFixer ?? null,
        publicBody: diff.publicBody ?? "",
        fixerBody: diff.fixerBody ?? null,
        sources: (diff.sources ?? []) as never,
        createdById: actorId,
        updatedById: actorId,
      })
      .returning();
    return created;
  }
  const set: Record<string, unknown> = { updatedById: actorId, updatedAt: new Date() };
  if (diff.category !== undefined) set.category = diff.category;
  if (diff.name !== undefined) set.name = diff.name;
  if (diff.summary !== undefined) set.summary = diff.summary ?? null;
  if (diff.responsibleFixer !== undefined) set.responsibleFixer = diff.responsibleFixer ?? null;
  if (diff.aliases !== undefined) set.aliases = diff.aliases;
  if (diff.publicBody !== undefined) set.publicBody = diff.publicBody;
  if (diff.fixerBody !== undefined) set.fixerBody = diff.fixerBody ?? null;
  if (diff.sources !== undefined) set.sources = diff.sources;
  const [updated] = await tx
    .update(loreEntries)
    .set(set)
    .where(eq(loreEntries.id, edit.loreEntryId!))
    .returning();
  return updated;
}

// Approve a proposed edit (admin only). Locks + status-guards so a concurrent
// reject can't clobber the decision, then applies the diff.
router.post("/directory/lore/edits/:id/approve", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const summary =
    typeof req.body?.decisionSummary === "string" && req.body.decisionSummary.trim()
      ? req.body.decisionSummary.trim()
      : null;

  const result = await db.transaction(async (tx) => {
    const [edit] = await tx
      .select()
      .from(lorePendingEdits)
      .where(eq(lorePendingEdits.id, id))
      .for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    if (edit.status !== "pending") {
      return { error: { status: 409, body: { error: `Proposal already ${edit.status}` } } };
    }
    if (edit.kind === "edit" && edit.loreEntryId) {
      const [exists] = await tx
        .select({ id: loreEntries.id })
        .from(loreEntries)
        .where(eq(loreEntries.id, edit.loreEntryId));
      if (!exists) return { error: { status: 400, body: { error: "Target entry no longer exists" } } };
    }
    const entry = await applyProposal(tx, edit, req.user!.id);
    await tx
      .update(lorePendingEdits)
      .set({
        status: "approved",
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decisionSummary: summary,
        appliedEntryId: entry.id,
      })
      .where(eq(lorePendingEdits.id, id));
    return { ok: { entry, edit } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_edit_approve",
    targetType: "lore_pending_edit",
    targetId: id,
    message: `Approved lore ${result.ok.edit.kind}: ${result.ok.entry.name}`,
    after: { entryId: result.ok.entry.id },
  });
  res.json({
    ...result.ok.edit,
    status: "approved",
    appliedEntryId: result.ok.entry.id,
    decidedAt: new Date().toISOString(),
    createdAt: result.ok.edit.createdAt.toISOString(),
  });
});

// Reject a proposed edit (admin only).
router.post("/directory/lore/edits/:id/reject", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const summary =
    typeof req.body?.decisionSummary === "string" && req.body.decisionSummary.trim()
      ? req.body.decisionSummary.trim()
      : null;

  const result = await db.transaction(async (tx) => {
    const [edit] = await tx
      .select()
      .from(lorePendingEdits)
      .where(eq(lorePendingEdits.id, id))
      .for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    if (edit.status !== "pending") {
      return { error: { status: 409, body: { error: `Proposal already ${edit.status}` } } };
    }
    await tx
      .update(lorePendingEdits)
      .set({
        status: "rejected",
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decisionSummary: summary,
      })
      .where(eq(lorePendingEdits.id, id));
    return { ok: { edit } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_edit_reject",
    targetType: "lore_pending_edit",
    targetId: id,
    message: `Rejected lore ${result.ok.edit.kind} proposal`,
  });
  res.json({
    ...result.ok.edit,
    status: "rejected",
    decidedAt: new Date().toISOString(),
    createdAt: result.ok.edit.createdAt.toISOString(),
  });
});

// ---- Import pipeline (admin only) -----------------------------------------

router.post("/directory/lore/import/run", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  try {
    const result = await runLoreImport();
    await recordAudit({
      req,
      category: "lore",
      action: "lore_import_run",
      targetType: "lore_import",
      message: `Lore import: ${result.created} new draft(s), ${result.duplicates} duplicate(s)`,
      after: result,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "runLoreImport failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Import failed" });
  }
});

function shapeDraft(row: typeof loreImportDrafts.$inferSelect, mergeName: string | null): Record<string, unknown> {
  return {
    id: row.id,
    groupKey: row.groupKey,
    proposedName: row.proposedName,
    proposedCategory: row.proposedCategory,
    proposedFixer: row.proposedFixer ?? null,
    aliases: row.aliases ?? [],
    summary: row.summary ?? null,
    publicBody: row.publicBody ?? "",
    fixerBody: row.fixerBody ?? null,
    sources: sourcesOf(row.sources),
    suggestedMergeEntryId: row.suggestedMergeEntryId ?? null,
    suggestedMergeName: mergeName,
    status: row.status,
    appliedEntryId: row.appliedEntryId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/directory/lore/import/drafts", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const status = String(req.query.status ?? "pending");
  const rows = await db
    .select({
      draft: loreImportDrafts,
      mergeName: loreEntries.name,
    })
    .from(loreImportDrafts)
    .leftJoin(loreEntries, eq(loreEntries.id, loreImportDrafts.suggestedMergeEntryId))
    .where(eq(loreImportDrafts.status, status))
    .orderBy(desc(loreImportDrafts.createdAt));
  res.json(rows.map((r) => shapeDraft(r.draft, r.mergeName)));
});

const draftUpdateSchema = z.object({
  proposedName: z.string().trim().min(1).optional(),
  proposedCategory: categoryEnum.optional(),
  proposedFixer: z.string().nullish(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  summary: z.string().nullish(),
  publicBody: z.string().optional(),
  fixerBody: z.string().nullish(),
  sources: z.array(sourceSchema).optional(),
  suggestedMergeEntryId: z.number().int().nullable().optional(),
});

router.patch("/directory/lore/import/drafts/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const parsed = draftUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const d = parsed.data;
  const set: Record<string, unknown> = {};
  if (d.proposedName !== undefined) set.proposedName = d.proposedName;
  if (d.proposedCategory !== undefined) set.proposedCategory = d.proposedCategory;
  if (d.proposedFixer !== undefined) set.proposedFixer = d.proposedFixer ?? null;
  if (d.aliases !== undefined) set.aliases = d.aliases;
  if (d.summary !== undefined) set.summary = d.summary ?? null;
  if (d.publicBody !== undefined) set.publicBody = d.publicBody;
  if (d.fixerBody !== undefined) set.fixerBody = d.fixerBody ?? null;
  if (d.sources !== undefined) set.sources = d.sources;
  if (d.suggestedMergeEntryId !== undefined) set.suggestedMergeEntryId = d.suggestedMergeEntryId;
  if (Object.keys(set).length === 0) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }
  const [updated] = await db
    .update(loreImportDrafts)
    .set(set)
    .where(and(eq(loreImportDrafts.id, id), eq(loreImportDrafts.status, "pending")))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Draft not found or already decided" });
    return;
  }
  let mergeName: string | null = null;
  if (updated.suggestedMergeEntryId) {
    const [m] = await db
      .select({ name: loreEntries.name })
      .from(loreEntries)
      .where(eq(loreEntries.id, updated.suggestedMergeEntryId));
    mergeName = m?.name ?? null;
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_import_draft_edit",
    targetType: "lore_import_draft",
    targetId: String(updated.id),
    message: `Edited import draft "${updated.proposedName}" before review`,
    after: set,
  });
  res.json(shapeDraft(updated, mergeName));
});

// Promote a draft into a published entry: merge into the suggested entry if set,
// otherwise create a new one. Locks + status-guards for idempotency.
router.post("/directory/lore/import/drafts/:id/approve", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);

  const result = await db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(loreImportDrafts)
      .where(eq(loreImportDrafts.id, id))
      .for("update");
    if (!draft) return { error: { status: 404, body: { error: "Draft not found" } } };
    if (draft.status !== "pending") {
      return { error: { status: 409, body: { error: `Draft already ${draft.status}` } } };
    }

    let entry: LoreEntry;
    if (draft.suggestedMergeEntryId) {
      const [existing] = await tx
        .select()
        .from(loreEntries)
        .where(eq(loreEntries.id, draft.suggestedMergeEntryId))
        .for("update");
      if (!existing) {
        // The merge target vanished — fall through to create instead.
        entry = await createFromDraft(tx, draft, req.user!.id);
      } else {
        const mergedAliases = Array.from(
          new Set([...(existing.aliases ?? []), ...(draft.aliases ?? []), existing.name].filter((a) => a !== draft.proposedName)),
        );
        const mergedSources = mergeSources(sourcesOf(existing.sources), sourcesOf(draft.sources));
        const [updated] = await tx
          .update(loreEntries)
          .set({
            category: draft.proposedCategory,
            name: draft.proposedName,
            responsibleFixer: draft.proposedFixer ?? existing.responsibleFixer,
            summary: draft.summary ?? existing.summary,
            publicBody: draft.publicBody,
            fixerBody: draft.fixerBody ?? existing.fixerBody,
            aliases: mergedAliases,
            sources: mergedSources as never,
            updatedById: req.user!.id,
            updatedAt: new Date(),
          })
          .where(eq(loreEntries.id, existing.id))
          .returning();
        entry = updated;
      }
    } else {
      entry = await createFromDraft(tx, draft, req.user!.id);
    }

    await tx
      .update(loreImportDrafts)
      .set({
        status: "approved",
        decidedById: req.user!.id,
        decidedAt: new Date(),
        appliedEntryId: entry.id,
      })
      .where(eq(loreImportDrafts.id, id));
    return { ok: { entry, draft } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_import_approve",
    targetType: "lore_entry",
    targetId: result.ok.entry.id,
    message: `Published imported lore: ${result.ok.entry.name}`,
    after: { draftId: id, entryId: result.ok.entry.id, merged: !!result.ok.draft.suggestedMergeEntryId },
  });
  res.json(shapeEntry(result.ok.entry, true));
});

async function createFromDraft(
  tx: Executor,
  draft: typeof loreImportDrafts.$inferSelect,
  actorId: string,
): Promise<LoreEntry> {
  const slug = await uniqueSlug(tx, draft.proposedName);
  const [created] = await tx
    .insert(loreEntries)
    .values({
      category: draft.proposedCategory,
      name: draft.proposedName,
      slug,
      aliases: draft.aliases ?? [],
      summary: draft.summary ?? null,
      responsibleFixer: draft.proposedFixer ?? null,
      publicBody: draft.publicBody ?? "",
      fixerBody: draft.fixerBody ?? null,
      sources: sourcesOf(draft.sources) as never,
      createdById: actorId,
      updatedById: actorId,
    })
    .returning();
  return created;
}

function mergeSources(a: LoreSourceRef[], b: LoreSourceRef[]): LoreSourceRef[] {
  const out = [...a];
  for (const s of b) if (!out.some((e) => e.url === s.url)) out.push(s);
  return out;
}

router.post("/directory/lore/import/drafts/:id/discard", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [updated] = await db
    .update(loreImportDrafts)
    .set({ status: "discarded", decidedById: req.user!.id, decidedAt: new Date() })
    .where(and(eq(loreImportDrafts.id, id), eq(loreImportDrafts.status, "pending")))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "Draft not found or already decided" });
    return;
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_import_discard",
    targetType: "lore_import_draft",
    targetId: id,
    message: `Discarded imported lore draft: ${updated.proposedName}`,
  });
  res.json(shapeDraft(updated, null));
});

// ---- Detail + admin mutations (param routes last) --------------------------

router.get("/directory/lore/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(shapeEntry(row as LoreEntry, isFixerOrAdmin(req.user!)));
});

// Create an entry (admin only — publishes directly).
router.post("/directory/lore", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const parsed = entryInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const d = parsed.data;
  const slug = await uniqueSlug(db, d.name);
  const [created] = await db
    .insert(loreEntries)
    .values({
      category: d.category,
      name: d.name,
      slug,
      aliases: d.aliases ?? [],
      summary: d.summary ?? null,
      responsibleFixer: d.responsibleFixer ?? null,
      publicBody: d.publicBody ?? "",
      fixerBody: d.fixerBody ?? null,
      sources: (d.sources ?? []) as never,
      createdById: req.user!.id,
      updatedById: req.user!.id,
    })
    .returning();
  await recordAudit({
    req,
    category: "lore",
    action: "lore_create",
    targetType: "lore_entry",
    targetId: created.id,
    message: `Created lore entry: ${created.name}`,
    after: { category: created.category, name: created.name },
  });
  res.status(201).json(shapeEntry(created, true));
});

// Edit an entry (admin only — publishes directly).
router.patch("/directory/lore/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const parsed = entryUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const d = parsed.data;
  const [before] = await db.select().from(loreEntries).where(eq(loreEntries.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const set: Record<string, unknown> = { updatedById: req.user!.id, updatedAt: new Date() };
  if (d.category !== undefined) set.category = d.category;
  if (d.name !== undefined) set.name = d.name;
  if (d.summary !== undefined) set.summary = d.summary ?? null;
  if (d.responsibleFixer !== undefined) set.responsibleFixer = d.responsibleFixer ?? null;
  if (d.aliases !== undefined) set.aliases = d.aliases;
  if (d.publicBody !== undefined) set.publicBody = d.publicBody;
  if (d.fixerBody !== undefined) set.fixerBody = d.fixerBody ?? null;
  if (d.sources !== undefined) set.sources = d.sources;
  const [updated] = await db.update(loreEntries).set(set).where(eq(loreEntries.id, id)).returning();
  await recordAudit({
    req,
    category: "lore",
    action: "lore_update",
    targetType: "lore_entry",
    targetId: id,
    message: `Edited lore entry: ${updated.name}`,
    before: { category: before.category, name: before.name, summary: before.summary, responsibleFixer: before.responsibleFixer },
    after: set,
  });
  res.json(shapeEntry(updated, true));
});

// Delete an entry (admin only).
router.delete("/directory/lore/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [deleted] = await db.delete(loreEntries).where(eq(loreEntries.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_delete",
    targetType: "lore_entry",
    targetId: id,
    message: `Deleted lore entry: ${deleted.name}`,
    before: { category: deleted.category, name: deleted.name },
  });
  res.status(204).end();
});

export default router;
