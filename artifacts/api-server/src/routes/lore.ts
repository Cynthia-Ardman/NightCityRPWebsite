import { Router, type IRouter, type Request } from "express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  loreEntries,
  lorePendingEdits,
  loreImportDrafts,
  users,
  type LoreEntry,
  type User,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { sendDirectMessage } from "../lib/discord";
import { createNotification } from "../lib/notifications";
import { hrefLoreEntry, hrefLoreMine } from "../lib/notificationHrefs";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { runLoreImport, type LoreSourceRef } from "../lib/loreImport";
import { isAdmin, isFixerOrAdmin } from "../lib/roleChecks";
import {
  isReviewer,
  isEligibleReviewer,
  tallyReviewVotes,
  castReviewVote,
  loadVotesBySubject,
  listEligibleReviewers,
  latestVoterIdFor,
  majorityOf,
  loadLastActivityBySubject,
  type ReviewActionResult,
} from "../lib/review";

// Lore Directory: public world-lore entries (Corporations / Gangs / Factions /
// Miscellaneous) with a PUBLIC body for everyone plus a FIXER-ONLY body and
// source references visible only to staff. Admins author/publish directly;
// fixer/admin-submitted proposals (lorePendingEdits) ride the SHARED
// majority-vote review pipeline (subject type "lore") alongside Misc Requests,
// Character Edits, and New Characters: reviewers vote, a majority stages the
// decision, and the diff is materialized via applyProposal only when a reviewer
// applies & closes the ticket. Admins may override the vote. Imported lore
// (loreImportDrafts / runLoreImport) keeps its separate single-admin flow.

const router: IRouter = Router();

// A db handle or an in-flight transaction — helpers run on either.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const CATEGORIES = ["corporation", "gang", "faction", "location", "misc"] as const;
const categoryEnum = z.enum(CATEGORIES);
const sourceSchema = z.object({ label: z.string().min(1), url: z.string().min(1) });

// Canonical Night City district tags — one per clickable region/marker on the
// interactive lore map embedded on /directory/lore (portal CityMap component).
// Keep in sync with the OpenAPI LoreDistrict enum and the portal's DISTRICTS list.
const DISTRICTS = [
  "watson",
  "westbrook",
  "city_center",
  "heywood",
  "santo_domingo",
  "pacifica",
  "north_badlands",
  "eastern_badlands",
  "southern_badlands",
  "beastside",
] as const;
const districtEnum = z.enum(DISTRICTS);

// Canonical sub-district (neighborhood) tags with their parent district — one
// per labeled neighborhood polygon on the portal map. Keep in sync with the
// OpenAPI LoreSubDistrict enum and SUB_DISTRICTS in the portal's districts.ts.
// Invariant: whenever an entry has a subDistrict, its district is the parent.
const SUB_DISTRICTS: Record<string, (typeof DISTRICTS)[number]> = {
  northside: "watson",
  arasaka_waterfront: "watson",
  kabuki: "watson",
  little_china: "watson",
  japantown: "westbrook",
  north_oaks: "westbrook",
  charter_hill: "westbrook",
  casino: "westbrook",
  downtown: "city_center",
  corpo_plaza: "city_center",
  wellsprings: "heywood",
  the_glen: "heywood",
  vista_del_rey: "heywood",
  arroyo: "santo_domingo",
  rancho_coronado: "santo_domingo",
  coast_view: "pacifica",
  west_wind_estate: "pacifica",
  dogtown: "pacifica",
};
const subDistrictEnum = z.enum(Object.keys(SUB_DISTRICTS) as [string, ...string[]]);

// Validate a (district, subDistrict) pair as it would land on the entry.
// Returns an error message when the caller explicitly supplied a district that
// conflicts with the sub-district's parent; otherwise returns the corrected
// pair (auto-filling district from the sub-district's parent).
function resolveDistrictPair(
  district: string | null | undefined,
  subDistrict: string | null | undefined,
  districtExplicit: boolean,
): { error: string } | { district: string | null; subDistrict: string | null } {
  if (!subDistrict) return { district: district ?? null, subDistrict: null };
  const parent = SUB_DISTRICTS[subDistrict];
  if (!parent) return { error: `Unknown sub-district: ${subDistrict}` };
  if (district && district !== parent) {
    if (districtExplicit) {
      return { error: `Sub-district "${subDistrict}" belongs to ${parent}, not ${district}` };
    }
  }
  return { district: parent, subDistrict };
}

// Non-400 coercion for materialization paths (draft approve/merge, proposal
// apply): a sub-district always forces its parent district; an unknown
// sub-district is dropped. Never throws — stored rows may predate validation.
function normalizeDistrictPair(
  district: string | null,
  subDistrict: string | null,
): { district: string | null; subDistrict: string | null } {
  if (!subDistrict) return { district, subDistrict: null };
  const parent = SUB_DISTRICTS[subDistrict];
  if (!parent) return { district, subDistrict: null };
  return { district: parent, subDistrict };
}

const entryInputSchema = z.object({
  category: categoryEnum,
  name: z.string().trim().min(1),
  summary: z.string().nullish(),
  responsibleFixer: z.string().nullish(),
  imageUrl: z.string().nullish(),
  district: districtEnum.nullish(),
  subDistrict: subDistrictEnum.nullish(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  publicBody: z.string().optional(),
  fixerBody: z.string().nullish(),
  sources: z.array(sourceSchema).optional(),
});
const entryUpdateSchema = entryInputSchema.partial();

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
    imageUrl: row.imageUrl ?? null,
    district: row.district ?? null,
    subDistrict: row.subDistrict ?? null,
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
    imageUrl: row.imageUrl ?? null,
    district: row.district ?? null,
    subDistrict: row.subDistrict ?? null,
    hasFixerContent: !!(row.fixerBody && row.fixerBody.trim()) || sourcesOf(row.sources).length > 0,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Best-effort Discord DM to the fixer who proposed a lore change, telling them
// the admin's decision (and the decision summary, if any). Resolves the
// submitter's Discord id from `users`. Never throws — a delivery miss (DMs
// closed, no bot token, network error) must not affect the already-committed
// approve/reject decision.
async function notifyFixerOfLoreDecision(
  edit: typeof lorePendingEdits.$inferSelect,
  status: "approved" | "rejected",
  summary: string | null,
  entryName: string | null,
): Promise<void> {
  // In-portal bell notification — additive to the Discord DM below.
  {
    const what = edit.kind === "create" ? "new lore entry" : "lore edit";
    const name = entryName ?? "an entry";
    void createNotification({
      userId: edit.submittedBy,
      type: "lore_decision",
      title: `${status === "approved" ? "Approved" : "Rejected"}: ${what} "${name}"`,
      body: summary ? `${status === "approved" ? "Note" : "Reason"}: ${summary}` : null,
      href: edit.appliedEntryId
        ? hrefLoreEntry(edit.appliedEntryId)
        : edit.loreEntryId
          ? hrefLoreEntry(edit.loreEntryId)
          : hrefLoreMine(),
    });
  }
  try {
    const [u] = await db
      .select({ discordId: users.discordId })
      .from(users)
      .where(eq(users.id, edit.submittedBy));
    if (!u?.discordId) return;
    const what = edit.kind === "create" ? "new lore entry" : "lore edit";
    const name = entryName ?? "an entry";
    let content =
      status === "approved"
        ? `Your ${what} "${name}" was approved and is now live.`
        : `Your ${what} "${name}" was rejected.`;
    if (summary) content += `\n${status === "approved" ? "Note" : "Reason"}: ${summary}`;
    await sendDirectMessage(u.discordId, content);
  } catch (err) {
    logger.warn({ err, editId: edit.id }, "lore decision DM failed");
  }
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
    // Search public-safe fields only — never the fixer-only body — so a regular
    // player's query can't probe restricted intel. aliases is a text[]; match it
    // case-insensitively by collapsing the array to a string.
    const like = `%${q}%`;
    clauses.push(
      or(
        ilike(loreEntries.name, like),
        ilike(loreEntries.summary, like),
        ilike(loreEntries.responsibleFixer, like),
        ilike(loreEntries.publicBody, like),
        sql`array_to_string(${loreEntries.aliases}, ' ') ILIKE ${like}`,
      ),
    );
  }
  const where = clauses.length ? and(...clauses) : undefined;
  // Sort: "alpha" = A→Z by name, "recent" (default) = newest-updated first.
  const sort = req.query.sort === "alpha" ? "alpha" : "recent";
  const orderBy = sort === "alpha" ? asc(loreEntries.name) : desc(loreEntries.updatedAt);
  const rows = (await db
    .select()
    .from(loreEntries)
    .where(where)
    .orderBy(orderBy)) as LoreEntry[];
  res.json(rows.map(shapeSummary));
});

// ---- Fixer-proposed edits (must be declared before /:id to avoid capture) ---

const proposalSchema = z.object({
  loreEntryId: z.number().int().nullable().optional(),
  kind: z.enum(["create", "edit"]),
  diff: entryUpdateSchema,
  updateNote: z.string().nullish(),
});

// Column set for a proposal row joined to its target entry name + submitter
// name. Shared by every read path (list, mine, detail) so they stay identical.
const editSelectCols = {
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
  closedAt: lorePendingEdits.closedAt,
  appliedEntryId: lorePendingEdits.appliedEntryId,
  overriddenBy: lorePendingEdits.overriddenBy,
  createdAt: lorePendingEdits.createdAt,
} as const;

type LoreEditRow = {
  id: number;
  loreEntryId: number | null;
  entryName: string | null;
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
  closedAt: Date | null;
  appliedEntryId: number | null;
  overriddenBy: string | null;
  createdAt: Date;
};

function shapeEditRow(r: LoreEditRow): Record<string, unknown> {
  return {
    id: r.id,
    loreEntryId: r.loreEntryId,
    entryName: r.entryName,
    kind: r.kind,
    submittedBy: r.submittedBy,
    submittedByName: r.submittedByName,
    proposedDiff: r.proposedDiff,
    beforeSnapshot: r.beforeSnapshot,
    updateNote: r.updateNote,
    status: r.status,
    decidedById: r.decidedById,
    decisionSummary: r.decisionSummary,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    appliedEntryId: r.appliedEntryId,
    overriddenBy: r.overriddenBy,
    createdAt: r.createdAt.toISOString(),
  };
}

// Attach the shared review-pipeline tally (vote counts, threshold, the viewer's
// own vote) to a set of proposal rows — the lore mirror of requests'
// attachTallies. `includeRoster` exposes reviewer identities (the eligible
// roster + per-voter identity + the can* action flags); it MUST be false for
// the player-facing /edits/mine endpoint so a submitter can't enumerate the
// reviewer pool or see who voted.
async function attachLoreTallies(
  rows: LoreEditRow[],
  viewer: User,
  includeRoster: boolean,
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const viewerId = viewer.id;
  const votesById = await loadVotesBySubject({ subjectType: "lore", subjectIds: rows.map((r) => r.id) });
  const activityById = await loadLastActivityBySubject(
    "lore",
    rows.map((r) => ({ id: r.id, baseAt: r.createdAt })),
  );
  const reviewerPool = await listEligibleReviewers(null);
  return rows.map((r) => {
    const eligible = reviewerPool.filter((rv) => rv.id !== r.submittedBy);
    const eligibleSet = new Set(eligible.map((rv) => rv.id));
    const votes = (votesById.get(r.id) ?? []).filter((v) => eligibleSet.has(v.voterId));
    const approveCount = votes.filter((v) => v.vote === "approve").length;
    const rejectCount = votes.filter((v) => v.vote === "reject").length;
    const mine = (votesById.get(r.id) ?? []).find((v) => v.voterId === viewerId);
    const isOwn = r.submittedBy === viewerId;
    return {
      ...shapeEditRow(r),
      lastActivityAt: (activityById.get(r.id) ?? r.createdAt).toISOString(),
      approveCount,
      rejectCount,
      threshold: majorityOf(eligible.length),
      eligibleVoterCount: eligible.length,
      myVote: mine?.vote ?? null,
      ...(includeRoster ? { eligibleReviewers: eligible } : {}),
      voters: includeRoster
        ? votes.map((v) => ({ id: v.voterId, name: v.voterName, avatarUrl: v.voterAvatarUrl, vote: v.vote }))
        : [],
      canVote: includeRoster && isEligibleReviewer(viewer) && !isOwn && r.status === "pending",
      canOverride:
        includeRoster &&
        isAdmin(viewer) &&
        !isOwn &&
        (r.status === "pending" || r.status === "changes_requested" || r.status === "approved") &&
        !r.appliedEntryId,
      canClose: includeRoster && isReviewer(viewer) && (r.status === "approved" || r.status === "rejected"),
      canReopen:
        includeRoster && isReviewer(viewer) && (r.status === "approved" || r.status === "rejected" || r.status === "closed"),
    };
  });
}

// Fetch one proposal (with target/submitter names) and attach its tally.
async function fetchEditWithTallies(
  id: number,
  viewer: User,
  includeRoster: boolean,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select(editSelectCols)
    .from(lorePendingEdits)
    .leftJoin(loreEntries, eq(loreEntries.id, lorePendingEdits.loreEntryId))
    .leftJoin(users, eq(users.id, lorePendingEdits.submittedBy))
    .where(eq(lorePendingEdits.id, id));
  if (rows.length === 0) return null;
  const [shaped] = await attachLoreTallies(rows as LoreEditRow[], viewer, includeRoster);
  return shaped;
}

// Re-evaluate one still-`pending` proposal against the LIVE eligible-reviewer
// majority and, if it now resolves, STAGE the same decision the vote handler
// makes (effects are deferred to close). Self-heals tickets stranded pending
// after the eligible pool shrank below the already-cast tally. Locked +
// status-guarded, so it is idempotent and races safely with a concurrent vote
// or admin override. Returns the decided status, or null if it stayed pending.
async function finalizeDecidedLore(
  req: Request,
  eid: number,
): Promise<"approved" | "rejected" | null> {
  const txResult = await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, eid)).for("update");
    if (!edit || edit.status !== "pending") return null;
    const tally = await tallyReviewVotes({ subjectType: "lore", subjectId: eid, submitterId: edit.submittedBy, conn: tx });
    if (!tally.decided) return null;
    const deciderId =
      (await latestVoterIdFor({
        subjectType: "lore",
        subjectId: eid,
        vote: tally.decided === "approved" ? "approve" : "reject",
        conn: tx,
      })) ?? req.user!.id;
    await tx
      .update(lorePendingEdits)
      .set({ status: tally.decided, decidedById: deciderId, decidedAt: new Date(), decisionSummary: null })
      .where(eq(lorePendingEdits.id, eid));
    return { decided: tally.decided, edit };
  });
  if (!txResult) return null;
  await recordAudit({
    req,
    category: "lore",
    action: txResult.decided === "approved" ? "lore_auto_finalize_approve" : "lore_auto_finalize_reject",
    targetType: "lore_pending_edit",
    targetId: eid,
    message: `Auto-finalized lore ${txResult.edit.kind} → ${txResult.decided} (majority reached after reviewer-pool change; pending close)`,
    after: { autoFinalized: true },
  });
  return txResult.decided;
}

// Walk an attachLoreTallies result and auto-finalize any row whose live tally
// already resolves while it is still `pending`. Mutates `entries` in place so
// the response reflects the freshly-staged status.
async function finalizeDecidedLoreInPlace(req: Request, entries: Record<string, unknown>[]): Promise<void> {
  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    const approve = entry.approveCount as number;
    const reject = entry.rejectCount as number;
    const threshold = entry.threshold as number;
    if (approve < threshold && reject < threshold) continue;
    const decided = await finalizeDecidedLore(req, entry.id as number);
    if (decided) entry.status = decided;
  }
}

// List proposed lore edits — the staff review queue. Reviewer-gated (FIXER /
// CS_APPROVER / ADMIN) to match the shared pipeline's pool. Defaults to pending.
router.get("/directory/lore/edits", requireAuth, async (req, res): Promise<void> => {
  if (!isReviewer(req.user!)) {
    res.status(403).json({ error: "Requires reviewer role" });
    return;
  }
  const status = String(req.query.status ?? "pending");
  const rows = await db
    .select(editSelectCols)
    .from(lorePendingEdits)
    .leftJoin(loreEntries, eq(loreEntries.id, lorePendingEdits.loreEntryId))
    .leftJoin(users, eq(users.id, lorePendingEdits.submittedBy))
    .where(eq(lorePendingEdits.status, status))
    .orderBy(desc(lorePendingEdits.createdAt));
  const out = await attachLoreTallies(rows as LoreEditRow[], req.user!, true);
  await finalizeDecidedLoreInPlace(req, out);
  res.json(out);
});

// The signed-in submitter's own lore submissions across all statuses, so they
// can track what's pending, approved, or rejected. includeRoster=false: the
// player-facing view never exposes the reviewer pool or per-voter identities.
// Declared before /edits/:id-style routes to avoid capture.
router.get("/directory/lore/edits/mine", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const rows = await db
    .select(editSelectCols)
    .from(lorePendingEdits)
    .leftJoin(loreEntries, eq(loreEntries.id, lorePendingEdits.loreEntryId))
    .leftJoin(users, eq(users.id, lorePendingEdits.submittedBy))
    .where(eq(lorePendingEdits.submittedBy, req.user!.id))
    .orderBy(desc(lorePendingEdits.createdAt));
  const out = await attachLoreTallies(rows as LoreEditRow[], req.user!, false);
  res.json(out);
});

// Detail for a single proposal — reviewer-gated. Runs finalize-on-read so a
// proposal stranded pending after the eligible pool shrank surfaces its
// resolved state (and Close & Apply action) when opened.
router.get("/directory/lore/edits/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isReviewer(req.user!)) {
    res.status(403).json({ error: "Requires reviewer role" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  let shaped = await fetchEditWithTallies(id, req.user!, true);
  if (!shaped) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  if (shaped.status === "pending") {
    const wrapped = [shaped];
    await finalizeDecidedLoreInPlace(req, wrapped);
    if (wrapped[0].status !== "pending") {
      shaped = (await fetchEditWithTallies(id, req.user!, true)) ?? shaped;
    }
  }
  res.json(shaped);
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
  // Enforce sub-district → parent-district consistency on the proposed diff at
  // submit time (applyProposal re-normalizes defensively at materialize).
  if (diff.subDistrict) {
    const pair = resolveDistrictPair(diff.district ?? null, diff.subDistrict, diff.district !== undefined && diff.district !== null);
    if ("error" in pair) {
      res.status(400).json({ error: pair.error });
      return;
    }
    diff.district = pair.district as typeof diff.district;
  }
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
  // Defensive re-normalization at materialize time: a sub-district always
  // forces its parent district (old proposals may predate the invariant).
  if (diff.subDistrict) {
    const parent = SUB_DISTRICTS[diff.subDistrict];
    if (parent) diff.district = parent;
    else diff.subDistrict = null;
  }
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
        imageUrl: diff.imageUrl ?? null,
        district: diff.district ?? null,
        subDistrict: diff.subDistrict ?? null,
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
  if (diff.imageUrl !== undefined) set.imageUrl = diff.imageUrl ?? null;
  if (diff.district !== undefined) set.district = diff.district ?? null;
  if (diff.subDistrict !== undefined) set.subDistrict = diff.subDistrict ?? null;
  // Changing the district away from a kept sub-district's parent clears the
  // sub-district (keeps the parent invariant when only district is edited).
  if (diff.district !== undefined && diff.subDistrict === undefined) {
    const [current] = await tx
      .select({ subDistrict: loreEntries.subDistrict })
      .from(loreEntries)
      .where(eq(loreEntries.id, edit.loreEntryId!));
    const cur = current?.subDistrict;
    if (cur && SUB_DISTRICTS[cur] !== (diff.district ?? null)) set.subDistrict = null;
  }
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

// Cast a majority-vote review vote on a lore proposal (eligible reviewers only;
// admins use override). Mirrors the requests pipeline: lock + re-check pending,
// exclude the submitter, toggle the vote (re-casting the same value clears it),
// then re-tally. A resolved majority STAGES the decision (status flip only) —
// the diff is materialized later by closeLore at apply & close.
router.post("/directory/lore/edits/:id/vote", requireAuth, async (req, res): Promise<void> => {
  if (!isEligibleReviewer(req.user!)) {
    res.status(403).json({ error: "Only eligible reviewers can vote. Admins use override." });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  const body = (req.body ?? {}) as { vote?: unknown; note?: unknown };
  const vote = body.vote === "approve" ? "approve" : body.vote === "reject" ? "reject" : null;
  if (!vote) {
    res.status(400).json({ error: "vote must be 'approve' or 'reject'" });
    return;
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const result = await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, id)).for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    if (edit.status !== "pending") return { error: { status: 409, body: { error: `Proposal already ${edit.status}` } } };
    if (edit.submittedBy === req.user!.id) {
      return { error: { status: 403, body: { error: "You cannot vote on a proposal you submitted" } } };
    }
    const castResult = await castReviewVote({
      subjectType: "lore",
      subjectId: id,
      voterId: req.user!.id,
      vote,
      note,
      conn: tx,
    });
    const cleared = castResult === null;
    const tally = await tallyReviewVotes({ subjectType: "lore", subjectId: id, submitterId: edit.submittedBy, conn: tx });
    if (tally.decided) {
      await tx
        .update(lorePendingEdits)
        .set({ status: tally.decided, decidedById: req.user!.id, decidedAt: new Date(), decisionSummary: note })
        .where(eq(lorePendingEdits.id, id));
    }
    return { ok: { edit, decided: tally.decided, cleared } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  await recordAudit({
    req,
    category: "lore",
    action: result.ok.decided
      ? result.ok.decided === "approved"
        ? "lore_vote_approve"
        : "lore_vote_reject"
      : result.ok.cleared
        ? "lore_vote_clear"
        : "lore_vote",
    targetType: "lore_pending_edit",
    targetId: id,
    message: result.ok.cleared
      ? `Cleared review vote on lore ${result.ok.edit.kind} proposal`
      : `Voted ${vote} on lore ${result.ok.edit.kind} proposal${result.ok.decided ? ` → ${result.ok.decided}` : ""}`,
  });
  const shaped = await fetchEditWithTallies(id, req.user!, true);
  res.json({ ...(shaped ?? {}), decided: result.ok.decided ?? null, cleared: result.ok.cleared });
});

// Admin override: unilaterally resolve a proposal (approve or deny), bypassing
// the vote. Editable while pending/changes_requested/approved and not yet
// applied; stamps overriddenBy. Effects still materialize at close (idempotent).
router.post("/directory/lore/edits/:id/override", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Only admins can override" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  const body = (req.body ?? {}) as { decision?: unknown; reviewerNote?: unknown; decisionSummary?: unknown };
  const deny = body.decision === "deny";
  const note =
    typeof body.reviewerNote === "string" && body.reviewerNote.trim()
      ? body.reviewerNote.trim()
      : typeof body.decisionSummary === "string" && body.decisionSummary.trim()
        ? body.decisionSummary.trim()
        : null;

  const result = await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, id)).for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    const editable = edit.status === "pending" || edit.status === "changes_requested" || edit.status === "approved";
    if (!editable || edit.appliedEntryId) {
      return { error: { status: 409, body: { error: `Proposal already ${edit.appliedEntryId ? "applied" : edit.status}` } } };
    }
    if (edit.submittedBy === req.user!.id) {
      return { error: { status: 403, body: { error: "You cannot override your own proposal" } } };
    }
    await tx
      .update(lorePendingEdits)
      .set({
        status: deny ? "rejected" : "approved",
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decisionSummary: note,
        overriddenBy: req.user!.id,
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
    action: deny ? "lore_override_reject" : "lore_override_approve",
    targetType: "lore_pending_edit",
    targetId: id,
    message: `Admin override → ${deny ? "rejected" : "approved"} lore ${result.ok.edit.kind} proposal`,
  });
  const shaped = await fetchEditWithTallies(id, req.user!, true);
  res.json(shaped);
});

// Apply & close a resolved proposal. EXPORTED for routes/review.ts's generic
// close dispatcher. Materializes the diff via applyProposal ONLY when the row
// is approved and not yet applied (effects deferred to close, per the shared
// pipeline), idempotent under FOR UPDATE + the appliedEntryId/status guards.
// Rejected rows just archive (and DM the submitter). Re-closing is a no-op.
export async function closeLore(req: Request, id: number, note?: string): Promise<ReviewActionResult> {
  const u = req.user!;
  const result = await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, id)).for("update");
    if (!edit) return { kind: "error" as const, status: 404, body: { error: "Proposal not found" } };
    if (edit.status === "closed") return { kind: "noop" as const };
    if (edit.status !== "approved" && edit.status !== "rejected") {
      return { kind: "error" as const, status: 409, body: { error: `Only a resolved proposal can be closed (this one is ${edit.status})` } };
    }
    if (edit.status === "approved" && !edit.appliedEntryId) {
      if (edit.kind === "edit" && edit.loreEntryId) {
        const [exists] = await tx.select({ id: loreEntries.id }).from(loreEntries).where(eq(loreEntries.id, edit.loreEntryId));
        if (!exists) return { kind: "error" as const, status: 400, body: { error: "Target entry no longer exists" } };
      }
      const entry = await applyProposal(tx, edit, u.id);
      await tx
        .update(lorePendingEdits)
        .set({ status: "closed", closedAt: new Date(), closedBy: u.id, appliedEntryId: entry.id })
        .where(eq(lorePendingEdits.id, id));
      return { kind: "applied" as const, edit, entry };
    }
    await tx
      .update(lorePendingEdits)
      .set({ status: "closed", closedAt: new Date(), closedBy: u.id })
      .where(eq(lorePendingEdits.id, id));
    return { kind: "archived" as const, edit };
  });

  if (result.kind === "error") return { status: result.status, body: result.body };
  if (result.kind === "noop") {
    const shaped = await fetchEditWithTallies(id, u, true);
    return { status: 200, body: shaped ?? { id, status: "closed" } };
  }
  if (result.kind === "applied") {
    await recordAudit({
      req,
      category: "lore",
      action: "lore_edit_apply",
      targetType: "lore_pending_edit",
      targetId: id,
      message: `Applied & closed lore ${result.edit.kind}: ${result.entry.name}`,
      after: { entryId: result.entry.id },
    });
    await notifyFixerOfLoreDecision(result.edit, "approved", note ?? result.edit.decisionSummary ?? null, result.entry.name);
  } else {
    await recordAudit({
      req,
      category: "lore",
      action: "lore_edit_close",
      targetType: "lore_pending_edit",
      targetId: id,
      message: `Closed lore ${result.edit.kind} proposal (${result.edit.status})${note ? ` — note: ${note}` : ""}`,
    });
    if (result.edit.status === "rejected") {
      const rejectedDiff = (result.edit.proposedDiff ?? {}) as z.infer<typeof entryUpdateSchema>;
      let rejectedName: string | null = rejectedDiff.name ?? null;
      if (!rejectedName && result.edit.loreEntryId) {
        const [e] = await db.select({ name: loreEntries.name }).from(loreEntries).where(eq(loreEntries.id, result.edit.loreEntryId));
        rejectedName = e?.name ?? null;
      }
      await notifyFixerOfLoreDecision(result.edit, "rejected", note ?? result.edit.decisionSummary ?? null, rejectedName);
    }
  }
  const shaped = await fetchEditWithTallies(id, u, true);
  return { status: 200, body: shaped ?? { id, status: "closed" } };
}

// Reopen a resolved/archived proposal back to pending. EXPORTED for the generic
// reopen dispatcher. Wipes the decision + close lifecycle but PRESERVES votes
// (finalize-on-read re-evaluates them) and appliedEntryId (so a re-close won't
// re-apply an already-materialized diff).
export async function reopenLore(req: Request, id: number): Promise<ReviewActionResult> {
  const result = await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, id)).for("update");
    if (!edit) return { error: { status: 404, body: { error: "Proposal not found" } } };
    if (edit.status !== "approved" && edit.status !== "rejected" && edit.status !== "closed") {
      return { error: { status: 409, body: { error: `Only a resolved or archived proposal can be reopened (this one is ${edit.status})` } } };
    }
    await tx
      .update(lorePendingEdits)
      .set({
        status: "pending",
        decidedById: null,
        decidedAt: null,
        decisionSummary: null,
        overriddenBy: null,
        closedAt: null,
        closedBy: null,
      })
      .where(eq(lorePendingEdits.id, id));
    return { ok: { edit } };
  });

  if (!("ok" in result) || !result.ok) {
    const err = (result as { error: { status: number; body: { error: string } } }).error;
    return { status: err.status, body: err.body };
  }
  await recordAudit({
    req,
    category: "lore",
    action: "lore_edit_reopen",
    targetType: "lore_pending_edit",
    targetId: id,
    message: `Reopened lore ${result.ok.edit.kind} proposal`,
  });
  const shaped = await fetchEditWithTallies(id, req.user!, true);
  return { status: 200, body: shaped ?? { id, status: "pending" } };
}

// Legacy single-admin approve/reject — retired in favor of the shared
// majority-vote pipeline (vote / override + apply at close via /review).
router.post("/directory/lore/edits/:id/approve", requireAuth, (_req, res): void => {
  res.status(410).json({ error: "Lore proposals now use the shared review pipeline. Vote or override, then apply & close." });
});
router.post("/directory/lore/edits/:id/reject", requireAuth, (_req, res): void => {
  res.status(410).json({ error: "Lore proposals now use the shared review pipeline. Vote or override, then apply & close." });
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
    imageUrl: row.imageUrl ?? null,
    district: row.district ?? null,
    subDistrict: row.subDistrict ?? null,
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
  imageUrl: z.string().nullish(),
  district: districtEnum.nullish(),
  subDistrict: subDistrictEnum.nullish(),
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
  if (d.subDistrict) {
    const pair = resolveDistrictPair(d.district ?? null, d.subDistrict, d.district !== undefined && d.district !== null);
    if ("error" in pair) {
      res.status(400).json({ error: pair.error });
      return;
    }
    d.district = pair.district as typeof d.district;
  }
  const set: Record<string, unknown> = {};
  if (d.proposedName !== undefined) set.proposedName = d.proposedName;
  if (d.proposedCategory !== undefined) set.proposedCategory = d.proposedCategory;
  if (d.proposedFixer !== undefined) set.proposedFixer = d.proposedFixer ?? null;
  if (d.aliases !== undefined) set.aliases = d.aliases;
  if (d.summary !== undefined) set.summary = d.summary ?? null;
  if (d.imageUrl !== undefined) set.imageUrl = d.imageUrl ?? null;
  if (d.district !== undefined) set.district = d.district ?? null;
  if (d.subDistrict !== undefined) set.subDistrict = d.subDistrict ?? null;
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
        // Invariant at materialize: a kept/incoming sub-district forces its
        // parent district; if the draft moves the district away from the
        // existing sub-district's parent (without its own sub), clear the sub.
        const mergedPair = normalizeDistrictPair(
          draft.district ?? existing.district,
          draft.subDistrict ?? (draft.district && existing.subDistrict && SUB_DISTRICTS[existing.subDistrict] !== draft.district ? null : existing.subDistrict),
        );
        const [updated] = await tx
          .update(loreEntries)
          .set({
            category: draft.proposedCategory,
            name: draft.proposedName,
            responsibleFixer: draft.proposedFixer ?? existing.responsibleFixer,
            summary: draft.summary ?? existing.summary,
            imageUrl: draft.imageUrl ?? existing.imageUrl,
            district: mergedPair.district,
            subDistrict: mergedPair.subDistrict,
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
  const pair = normalizeDistrictPair(draft.district ?? null, draft.subDistrict ?? null);
  const [created] = await tx
    .insert(loreEntries)
    .values({
      category: draft.proposedCategory,
      name: draft.proposedName,
      slug,
      aliases: draft.aliases ?? [],
      summary: draft.summary ?? null,
      imageUrl: draft.imageUrl ?? null,
      district: pair.district,
      subDistrict: pair.subDistrict,
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
  if (d.subDistrict) {
    const pair = resolveDistrictPair(d.district ?? null, d.subDistrict, d.district !== undefined && d.district !== null);
    if ("error" in pair) {
      res.status(400).json({ error: pair.error });
      return;
    }
    d.district = pair.district as typeof d.district;
  }
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
      imageUrl: d.imageUrl ?? null,
      district: d.district ?? null,
      subDistrict: d.subDistrict ?? null,
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
  // Keep the parent invariant across partial updates:
  // - explicit subDistrict + explicit conflicting district → 400
  // - explicit subDistrict alone → district auto-set to its parent
  // - explicit district change away from a KEPT sub-district's parent → clear it
  if (d.subDistrict) {
    const pair = resolveDistrictPair(
      d.district !== undefined ? d.district : before.district,
      d.subDistrict,
      d.district !== undefined && d.district !== null,
    );
    if ("error" in pair) {
      res.status(400).json({ error: pair.error });
      return;
    }
    d.district = pair.district as typeof d.district;
  } else if (
    d.district !== undefined &&
    d.subDistrict === undefined &&
    before.subDistrict &&
    SUB_DISTRICTS[before.subDistrict] !== d.district
  ) {
    d.subDistrict = null;
  }
  const set: Record<string, unknown> = { updatedById: req.user!.id, updatedAt: new Date() };
  if (d.category !== undefined) set.category = d.category;
  if (d.name !== undefined) set.name = d.name;
  if (d.summary !== undefined) set.summary = d.summary ?? null;
  if (d.responsibleFixer !== undefined) set.responsibleFixer = d.responsibleFixer ?? null;
  if (d.imageUrl !== undefined) set.imageUrl = d.imageUrl ?? null;
  if (d.district !== undefined) set.district = d.district ?? null;
  if (d.subDistrict !== undefined) set.subDistrict = d.subDistrict ?? null;
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
