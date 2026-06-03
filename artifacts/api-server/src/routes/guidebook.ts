import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  guidebookPages,
  guidebookPendingEdits,
  users,
  type GuidebookPage,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  runGuidebookImport,
  type GuidebookSourceRef,
} from "../lib/guidebookImport";

// Guidebook: browsable NCRP reference content grouped into fixed sections.
// Mirrors the Lore system — admins create/edit/publish directly; fixers propose
// changes that an admin approves (surfaced in Pending Requests). Imported
// Discord content upserts directly into live pages (see guidebookImport.ts);
// re-imports over on-site-edited pages stash a conflict for admin review here.

const router: IRouter = Router();

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Fixed section catalogue: key -> display label + blurb + ordering. The browse
// page renders one card per section in this order.
export const GUIDEBOOK_SECTIONS: Array<{ key: string; label: string; description: string }> = [
  { key: "getting_started", label: "Getting Started", description: "New here? Start with the basics of joining and playing on NCRP." },
  { key: "faq", label: "FAQ", description: "Answers to the questions players ask most often." },
  { key: "rules", label: "Rules & Restrictions", description: "The roleplay rules and avatar restrictions everyone must follow." },
  { key: "schedule", label: "Schedule & Events", description: "When sessions run and what's coming up." },
  { key: "systems", label: "Systems", description: "How the in-world systems — jobs, housing, cyberware and more — work." },
  { key: "character_creation", label: "Character Creation Help", description: "Guidance and cross-links for building your character." },
  { key: "setup", label: "VRChat / Discord Setup", description: "Get VRChat and Discord linked and ready to play." },
  { key: "npc_acting", label: "NPC Acting", description: "Tips and expectations for playing NPCs." },
];
const SECTION_KEYS = GUIDEBOOK_SECTIONS.map((s) => s.key) as [string, ...string[]];
const SECTION_ORDER = new Map(GUIDEBOOK_SECTIONS.map((s, i) => [s.key, i]));

const sectionEnum = z.enum(SECTION_KEYS);
const sourceSchema = z.object({ label: z.string().min(1), url: z.string().min(1) });

const pageInputSchema = z.object({
  section: sectionEnum,
  title: z.string().trim().min(1),
  description: z.string().nullish(),
  body: z.string().optional(),
  images: z.array(z.string()).optional(),
  sources: z.array(sourceSchema).optional(),
  position: z.number().int().optional(),
});
const pageUpdateSchema = pageInputSchema.partial();

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
      .slice(0, 80) || "page"
  );
}

async function uniqueSlug(executor: Executor, title: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const [hit] = await executor
      .select({ id: guidebookPages.id })
      .from(guidebookPages)
      .where(eq(guidebookPages.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

function sourcesOf(raw: unknown): GuidebookSourceRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is GuidebookSourceRef =>
      !!s && typeof s === "object" && typeof (s as GuidebookSourceRef).url === "string",
  );
}

function imagesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string");
}

function shapePage(row: GuidebookPage, isStaff: boolean): Record<string, unknown> {
  return {
    id: row.id,
    section: row.section,
    title: row.title,
    slug: row.slug,
    description: row.description ?? null,
    body: row.body ?? "",
    images: imagesOf(row.images),
    sources: sourcesOf(row.sources),
    position: row.position,
    sourceLabel: row.sourceLabel ?? null,
    discordChannelId: isStaff ? (row.discordChannelId ?? null) : null,
    importedAt: row.importedAt ? row.importedAt.toISOString() : null,
    editedSinceImport: isStaff ? row.editedSinceImport : false,
    hasPendingImport: isStaff ? row.pendingImport != null : false,
    pendingImportAt: isStaff && row.pendingImportAt ? row.pendingImportAt.toISOString() : null,
    createdById: row.createdById ?? null,
    updatedById: row.updatedById ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function notifyFixerOfDecision(
  edit: typeof guidebookPendingEdits.$inferSelect,
  status: "approved" | "rejected",
  summary: string | null,
  pageTitle: string | null,
): Promise<void> {
  try {
    const [u] = await db
      .select({ discordId: users.discordId })
      .from(users)
      .where(eq(users.id, edit.submittedBy));
    if (!u?.discordId) return;
    const what = edit.kind === "create" ? "new Guidebook page" : "Guidebook edit";
    const name = pageTitle ?? "a page";
    let content =
      status === "approved"
        ? `Your ${what} "${name}" was approved and is now live.`
        : `Your ${what} "${name}" was rejected.`;
    if (summary) content += `\n${status === "approved" ? "Note" : "Reason"}: ${summary}`;
    await sendDirectMessage(u.discordId, content);
  } catch (err) {
    logger.warn({ err, editId: edit.id }, "guidebook decision DM failed");
  }
}

// ---- Public read -----------------------------------------------------------

// Browse the Guidebook: all pages grouped into the fixed sections, in order.
// Any signed-in user. Optional free-text `q` filters across public-safe fields
// (title, description, body, source name) so staff-only content can be excluded
// later without changing the contract.
router.get("/guidebook", requireAuth, async (req, res): Promise<void> => {
  const q = req.query.q ? String(req.query.q).trim() : "";
  let where = undefined;
  if (q) {
    const like = `%${q}%`;
    where = or(
      ilike(guidebookPages.title, like),
      ilike(guidebookPages.description, like),
      ilike(guidebookPages.body, like),
      ilike(guidebookPages.sourceLabel, like),
    );
  }
  const rows = (await db
    .select()
    .from(guidebookPages)
    .where(where)
    .orderBy(asc(guidebookPages.position), asc(guidebookPages.title))) as GuidebookPage[];

  const isStaff = isFixerOrAdmin(req.user!);
  const bySection = new Map<string, GuidebookPage[]>();
  for (const row of rows) {
    const arr = bySection.get(row.section) ?? [];
    arr.push(row);
    bySection.set(row.section, arr);
  }
  // Keep any pages whose section key isn't in the catalogue under a trailing
  // bucket so they're never silently hidden.
  const knownKeys = new Set(SECTION_KEYS);
  const extraKeys = [...bySection.keys()].filter((k) => !knownKeys.has(k)).sort();

  const sections = [
    ...GUIDEBOOK_SECTIONS.map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      pages: (bySection.get(s.key) ?? []).map((p) => shapePage(p, isStaff)),
    })),
    ...extraKeys.map((k) => ({
      key: k,
      label: k,
      description: "",
      pages: (bySection.get(k) ?? []).map((p) => shapePage(p, isStaff)),
    })),
  ];
  res.json({ sections });
});

// Section catalogue (key/label/description), used to populate the editor's
// section picker. Any signed-in user.
router.get("/guidebook/sections", requireAuth, (_req, res): void => {
  res.json(GUIDEBOOK_SECTIONS);
});

// ---- Fixer-proposed edits (declared before /:id to avoid capture) ----------

const proposalSchema = z.object({
  pageId: z.number().int().nullable().optional(),
  kind: z.enum(["create", "edit"]),
  diff: pageUpdateSchema,
  updateNote: z.string().nullish(),
});

function shapeEditRow(r: {
  id: number;
  pageId: number | null;
  pageTitle: string | null;
  pageSection: string | null;
  kind: string;
  submittedBy: string;
  submittedByName: string | null;
  proposedDiff: unknown;
  beforeSnapshot: unknown;
  updateNote: string | null;
  status: string;
  decidedById: string | null;
  decisionSummary: string | null;
  decidedAt: Date | null;
  appliedPageId: number | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    ...r,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

const editSelect = {
  id: guidebookPendingEdits.id,
  pageId: guidebookPendingEdits.pageId,
  pageTitle: guidebookPages.title,
  pageSection: guidebookPages.section,
  kind: guidebookPendingEdits.kind,
  submittedBy: guidebookPendingEdits.submittedBy,
  submittedByName: users.username,
  proposedDiff: guidebookPendingEdits.proposedDiff,
  beforeSnapshot: guidebookPendingEdits.beforeSnapshot,
  updateNote: guidebookPendingEdits.updateNote,
  status: guidebookPendingEdits.status,
  decidedById: guidebookPendingEdits.decidedById,
  decisionSummary: guidebookPendingEdits.decisionSummary,
  decidedAt: guidebookPendingEdits.decidedAt,
  appliedPageId: guidebookPendingEdits.appliedPageId,
  createdAt: guidebookPendingEdits.createdAt,
};

// List proposed Guidebook edits (fixer/admin). Defaults to pending.
router.get("/guidebook/edits", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const status = String(req.query.status ?? "pending");
  const rows = await db
    .select(editSelect)
    .from(guidebookPendingEdits)
    .leftJoin(guidebookPages, eq(guidebookPages.id, guidebookPendingEdits.pageId))
    .leftJoin(users, eq(users.id, guidebookPendingEdits.submittedBy))
    .where(eq(guidebookPendingEdits.status, status))
    .orderBy(desc(guidebookPendingEdits.createdAt));
  res.json(rows.map(shapeEditRow));
});

// The signed-in fixer's own Guidebook submissions across all statuses.
router.get("/guidebook/edits/mine", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const rows = await db
    .select(editSelect)
    .from(guidebookPendingEdits)
    .leftJoin(guidebookPages, eq(guidebookPages.id, guidebookPendingEdits.pageId))
    .leftJoin(users, eq(users.id, guidebookPendingEdits.submittedBy))
    .where(eq(guidebookPendingEdits.submittedBy, req.user!.id))
    .orderBy(desc(guidebookPendingEdits.createdAt));
  res.json(rows.map(shapeEditRow));
});

// Submit a Guidebook create/edit proposal for admin approval (fixer/admin).
router.post("/guidebook/edits", requireAuth, async (req, res): Promise<void> => {
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
  let pageId = parsed.data.pageId ?? null;
  const beforeSnapshot: Record<string, unknown> = {};

  if (kind === "edit") {
    if (!pageId) {
      res.status(400).json({ error: "pageId is required for an edit proposal" });
      return;
    }
    const [page] = await db.select().from(guidebookPages).where(eq(guidebookPages.id, pageId));
    if (!page) {
      res.status(400).json({ error: "Guidebook page not found" });
      return;
    }
    // Snapshot only the fields named in the diff, captured now.
    for (const key of Object.keys(diff)) {
      beforeSnapshot[key] = (page as Record<string, unknown>)[key] ?? null;
    }
  } else {
    pageId = null;
    if (!diff.title || !diff.section) {
      res.status(400).json({ error: "title and section are required for a create proposal" });
      return;
    }
  }

  const [inserted] = await db
    .insert(guidebookPendingEdits)
    .values({
      pageId,
      kind,
      submittedBy: req.user!.id,
      proposedDiff: diff as never,
      beforeSnapshot: beforeSnapshot as never,
      updateNote: updateNote ?? null,
    })
    .returning();

  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_edit_submit",
    targetType: "guidebook_pending_edit",
    targetId: inserted.id,
    message: `Proposed Guidebook ${kind}: ${diff.title ?? `page #${pageId}`}`,
    after: { kind, pageId, diff },
  });

  res.status(201).json({
    ...inserted,
    decidedAt: inserted.decidedAt ? inserted.decidedAt.toISOString() : null,
    createdAt: inserted.createdAt.toISOString(),
    pageTitle: null,
    pageSection: null,
    submittedByName: req.user!.username,
  });
});

// Apply a proposed diff onto a (new or existing) page. Used by approve.
async function applyProposal(
  tx: Executor,
  edit: typeof guidebookPendingEdits.$inferSelect,
  actorId: string,
): Promise<GuidebookPage> {
  const diff = (edit.proposedDiff ?? {}) as z.infer<typeof pageUpdateSchema>;
  if (edit.kind === "create") {
    const title = diff.title!;
    const slug = await uniqueSlug(tx, title);
    const [created] = await tx
      .insert(guidebookPages)
      .values({
        section: diff.section ?? "misc",
        title,
        slug,
        description: diff.description ?? null,
        body: diff.body ?? "",
        images: (diff.images ?? []) as never,
        sources: (diff.sources ?? []) as never,
        position: diff.position ?? 0,
        editedSinceImport: false,
        createdById: actorId,
        updatedById: actorId,
      })
      .returning();
    return created;
  }
  const set: Record<string, unknown> = {
    updatedById: actorId,
    updatedAt: new Date(),
    // An on-site content change must shield the page from a re-import clobber.
    editedSinceImport: true,
  };
  if (diff.section !== undefined) set.section = diff.section;
  if (diff.title !== undefined) set.title = diff.title;
  if (diff.description !== undefined) set.description = diff.description ?? null;
  if (diff.body !== undefined) set.body = diff.body;
  if (diff.images !== undefined) set.images = diff.images;
  if (diff.sources !== undefined) set.sources = diff.sources;
  if (diff.position !== undefined) set.position = diff.position;
  const [updated] = await tx
    .update(guidebookPages)
    .set(set)
    .where(eq(guidebookPages.id, edit.pageId!))
    .returning();
  return updated;
}

router.post("/guidebook/edits/:id/approve", requireAuth, async (req, res): Promise<void> => {
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
      .from(guidebookPendingEdits)
      .where(eq(guidebookPendingEdits.id, id))
      .for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    if (edit.status !== "pending") {
      return { error: { status: 409, body: { error: `Proposal already ${edit.status}` } } };
    }
    if (edit.kind === "edit" && edit.pageId) {
      const [exists] = await tx
        .select({ id: guidebookPages.id })
        .from(guidebookPages)
        .where(eq(guidebookPages.id, edit.pageId));
      if (!exists) return { error: { status: 400, body: { error: "Target page no longer exists" } } };
    }
    const page = await applyProposal(tx, edit, req.user!.id);
    await tx
      .update(guidebookPendingEdits)
      .set({
        status: "approved",
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decisionSummary: summary,
        appliedPageId: page.id,
      })
      .where(eq(guidebookPendingEdits.id, id));
    return { ok: { page, edit } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_edit_approve",
    targetType: "guidebook_pending_edit",
    targetId: id,
    message: `Approved Guidebook ${result.ok.edit.kind}: ${result.ok.page.title}`,
    after: { pageId: result.ok.page.id },
  });
  await notifyFixerOfDecision(result.ok.edit, "approved", summary, result.ok.page.title);
  res.json({
    ...result.ok.edit,
    status: "approved",
    appliedPageId: result.ok.page.id,
    decidedAt: new Date().toISOString(),
    createdAt: result.ok.edit.createdAt.toISOString(),
  });
});

router.post("/guidebook/edits/:id/reject", requireAuth, async (req, res): Promise<void> => {
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
      .from(guidebookPendingEdits)
      .where(eq(guidebookPendingEdits.id, id))
      .for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    if (edit.status !== "pending") {
      return { error: { status: 409, body: { error: `Proposal already ${edit.status}` } } };
    }
    await tx
      .update(guidebookPendingEdits)
      .set({
        status: "rejected",
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decisionSummary: summary,
      })
      .where(eq(guidebookPendingEdits.id, id));
    return { ok: { edit } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_edit_reject",
    targetType: "guidebook_pending_edit",
    targetId: id,
    message: `Rejected Guidebook ${result.ok.edit.kind} proposal`,
  });
  {
    const rejectedDiff = (result.ok.edit.proposedDiff ?? {}) as z.infer<typeof pageUpdateSchema>;
    let rejectedName: string | null = rejectedDiff.title ?? null;
    if (!rejectedName && result.ok.edit.pageId) {
      const [p] = await db
        .select({ title: guidebookPages.title })
        .from(guidebookPages)
        .where(eq(guidebookPages.id, result.ok.edit.pageId));
      rejectedName = p?.title ?? null;
    }
    await notifyFixerOfDecision(result.ok.edit, "rejected", summary, rejectedName);
  }
  res.json({
    ...result.ok.edit,
    status: "rejected",
    decidedAt: new Date().toISOString(),
    createdAt: result.ok.edit.createdAt.toISOString(),
  });
});

// ---- Import pipeline (admin only) -----------------------------------------

router.post("/guidebook/import/run", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  try {
    const result = await runGuidebookImport(req.user!.id);
    await recordAudit({
      req,
      category: "guidebook",
      action: "guidebook_import_run",
      targetType: "guidebook_import",
      message: `Guidebook import: ${result.created} new, ${result.updated} updated, ${result.conflicts} conflict(s), ${result.errors} error(s)`,
      after: result,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "runGuidebookImport failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Import failed" });
  }
});

function shapeReview(row: GuidebookPage): Record<string, unknown> {
  const pi = (row.pendingImport ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    section: row.section,
    title: row.title,
    slug: row.slug,
    sourceLabel: row.sourceLabel ?? null,
    discordChannelId: row.discordChannelId ?? null,
    pendingImportAt: row.pendingImportAt ? row.pendingImportAt.toISOString() : null,
    currentBody: row.body ?? "",
    currentImages: imagesOf(row.images),
    incomingBody: typeof pi.body === "string" ? pi.body : "",
    incomingImages: imagesOf(pi.images),
    incomingSources: sourcesOf(pi.sources),
    incomingSourceLabel: typeof pi.sourceLabel === "string" ? pi.sourceLabel : null,
  };
}

// List pages with a stashed re-import awaiting admin review (admin only).
router.get("/guidebook/import/review", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const rows = (await db
    .select()
    .from(guidebookPages)
    .where(sql`${guidebookPages.pendingImport} is not null`)
    .orderBy(desc(guidebookPages.pendingImportAt))) as GuidebookPage[];
  res.json(rows.map(shapeReview));
});

// Apply a stashed re-import, overwriting the live page (admin only).
router.post("/guidebook/import/review/:id/apply", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const result = await db.transaction(async (tx) => {
    const [page] = await tx
      .select()
      .from(guidebookPages)
      .where(eq(guidebookPages.id, id))
      .for("update");
    if (!page) return { error: { status: 404, body: { error: "Page not found" } } };
    if (page.pendingImport == null) {
      return { error: { status: 409, body: { error: "No pending import for this page" } } };
    }
    const pi = page.pendingImport as Record<string, unknown>;
    const [updated] = await tx
      .update(guidebookPages)
      .set({
        body: typeof pi.body === "string" ? pi.body : page.body,
        images: imagesOf(pi.images) as never,
        sources: sourcesOf(pi.sources) as never,
        sourceLabel: typeof pi.sourceLabel === "string" ? pi.sourceLabel : page.sourceLabel,
        importedAt: new Date(),
        editedSinceImport: false,
        pendingImport: null,
        pendingImportAt: null,
        updatedById: req.user!.id,
        updatedAt: new Date(),
      })
      .where(eq(guidebookPages.id, id))
      .returning();
    return { ok: updated };
  });
  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_import_apply",
    targetType: "guidebook_page",
    targetId: id,
    message: `Applied re-import overwrite for "${result.ok.title}"`,
  });
  res.json(shapePage(result.ok, true));
});

// Dismiss a stashed re-import, keeping the on-site edits (admin only).
router.post("/guidebook/import/review/:id/dismiss", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [updated] = await db
    .update(guidebookPages)
    .set({ pendingImport: null, pendingImportAt: null })
    .where(and(eq(guidebookPages.id, id), sql`${guidebookPages.pendingImport} is not null`))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "No pending import for this page" });
    return;
  }
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_import_dismiss",
    targetType: "guidebook_page",
    targetId: id,
    message: `Dismissed re-import for "${updated.title}"`,
  });
  res.json(shapePage(updated, true));
});

// ---- Detail + admin mutations (param routes last) --------------------------

router.get("/guidebook/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [row] = await db.select().from(guidebookPages).where(eq(guidebookPages.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(shapePage(row as GuidebookPage, isFixerOrAdmin(req.user!)));
});

// Create a page (admin only — publishes directly).
router.post("/guidebook", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const parsed = pageInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const d = parsed.data;
  const slug = await uniqueSlug(db, d.title);
  const [created] = await db
    .insert(guidebookPages)
    .values({
      section: d.section,
      title: d.title,
      slug,
      description: d.description ?? null,
      body: d.body ?? "",
      images: (d.images ?? []) as never,
      sources: (d.sources ?? []) as never,
      position: d.position ?? 0,
      editedSinceImport: false,
      createdById: req.user!.id,
      updatedById: req.user!.id,
    })
    .returning();
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_create",
    targetType: "guidebook_page",
    targetId: created.id,
    message: `Created Guidebook page: ${created.title}`,
    after: { id: created.id, section: created.section, title: created.title },
  });
  res.status(201).json(shapePage(created, true));
});

// Edit a page (admin only — publishes directly).
router.patch("/guidebook/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const parsed = pageUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const d = parsed.data;
  const set: Record<string, unknown> = {
    updatedById: req.user!.id,
    updatedAt: new Date(),
    editedSinceImport: true,
  };
  if (d.section !== undefined) set.section = d.section;
  if (d.title !== undefined) set.title = d.title;
  if (d.description !== undefined) set.description = d.description ?? null;
  if (d.body !== undefined) set.body = d.body;
  if (d.images !== undefined) set.images = d.images;
  if (d.sources !== undefined) set.sources = d.sources;
  if (d.position !== undefined) set.position = d.position;
  const [updated] = await db
    .update(guidebookPages)
    .set(set)
    .where(eq(guidebookPages.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_update",
    targetType: "guidebook_page",
    targetId: id,
    message: `Edited Guidebook page: ${updated.title}`,
    after: set,
  });
  res.json(shapePage(updated, true));
});

// Delete a page (admin only).
router.delete("/guidebook/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Requires admin role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [deleted] = await db
    .delete(guidebookPages)
    .where(eq(guidebookPages.id, id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordAudit({
    req,
    category: "guidebook",
    action: "guidebook_delete",
    targetType: "guidebook_page",
    targetId: id,
    message: `Deleted Guidebook page: ${deleted.title}`,
    before: { id: deleted.id, title: deleted.title, section: deleted.section },
  });
  res.status(204).end();
});

export default router;
