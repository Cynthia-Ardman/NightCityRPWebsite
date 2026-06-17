import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  characters,
  characterUpdates,
  pendingCharacterEdits,
  pendingEditApprovals,
  users,
  activityEvents,
  type User,
  type Character,
} from "@workspace/db";
import type { Request } from "express";
import { requireAuth } from "../middlewares/auth";
import { hasRole, postToChannel, startThreadFromMessage } from "../lib/discord";
import { isReviewer, isEligibleReviewer, listEligibleReviewerIds, listEligibleReviewers, loadLastActivityBySubject, majorityOf, type ReviewActionResult } from "../lib/review";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

// Shape matches the partial PATCH payload accepted on characters.ts.
// Kept in sync manually — if you add an editable field to character,
// add it here AND to applyDiff() below.
const EditableSchema = z
  .object({
    name: z.string().trim().min(1),
    archetype: z.string().nullable(),
    background: z.string().nullable(),
    portraitUrl: z.string().nullable(),
    portraitUrls: z.array(z.string()),
    statsImageUrls: z.array(z.string()),
    // `preamble`/`sections` are the legacy free-form story shape. Sheet-created
    // characters instead store discrete story fields (physicalDescription,
    // appearance, …) plus gear/guns/identity at the top level of sheetData.
    // The inner object is non-strict (.passthrough) so those extra keys survive
    // the parse — without it the validator silently STRIPS them and a story edit
    // wipes everything the new-character form stored. See applyDiff (whole
    // replace) — the client always sends the merged blob, so nothing is lost.
    sheetData: z
      .object({
        preamble: z.string(),
        sections: z.record(z.string(), z.string()),
        physicalDescription: z.string().optional(),
        appearance: z.string().optional(),
        psychProfile: z.string().optional(),
        hooks: z.string().optional(),
        skills: z.string().optional(),
      })
      .passthrough(),
    lifeStatus: z.enum(["active", "dead", "missing", "loa", "retired"]),
    traumaTeamTier: z.enum(["silver", "gold", "platinum", "diamond", "corporate"]).nullable(),
    xanaduGold: z.boolean(),
  })
  .partial()
  .strict();

export type EditableDiff = z.infer<typeof EditableSchema>;

// Canonicalize a value so empty-ish placeholders ("", whitespace, null, empty
// array/object) collapse to undefined and object key order never registers as a
// change. Mirrors the portal's canonicalForDiff (lib/textDiff.ts) so the
// server-computed `changedFields` summary agrees exactly with the detail page's
// diff renderer — otherwise a no-op `sheetData` re-save (the edit form whole-
// replaces the blob, adding empty keys / reordering) shows up in the list card's
// field count but renders nothing in the diff.
function canonicalForDiff(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    const arr = v.map(canonicalForDiff).filter((x) => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => [k, canonicalForDiff(val)] as const)
      .filter(([, c]) => c !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return v;
}

function valuesDiffer(before: unknown, after: unknown): boolean {
  return JSON.stringify(canonicalForDiff(before)) !== JSON.stringify(canonicalForDiff(after));
}

// The meaningful changed fields for an edit: keys whose proposed value actually
// differs from the before-snapshot once empty/order noise is collapsed. Used by
// the list summary so queue cards and the detail diff never disagree.
function meaningfulChangedFields(
  proposedDiff: unknown,
  beforeSnapshot: unknown,
): string[] {
  const diff = (proposedDiff ?? {}) as Record<string, unknown>;
  const before = (beforeSnapshot ?? {}) as Record<string, unknown>;
  return Object.keys(diff).filter((f) => valuesDiffer(before[f], diff[f]));
}

// Apply an approved diff to the characters row. Mirrors the legacy
// PATCH /characters/:id apply logic so the eventual database state is
// identical to what the player would have gotten pre-review.
type DbConn = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyDiff(characterId: number, diff: EditableDiff, conn: DbConn = db): Promise<Character> {
  const u: Record<string, unknown> = {};
  if (diff.name !== undefined) u.name = diff.name;
  if (diff.archetype !== undefined) u.archetype = diff.archetype || null;
  if (diff.background !== undefined) u.background = diff.background || null;
  if (diff.portraitUrl !== undefined) u.portraitUrl = diff.portraitUrl || null;
  if (diff.portraitUrls !== undefined) u.portraitUrls = diff.portraitUrls;
  if (diff.statsImageUrls !== undefined) u.statsImageUrls = diff.statsImageUrls;
  if (diff.sheetData !== undefined) u.sheetData = diff.sheetData;
  if (diff.lifeStatus !== undefined) u.lifeStatus = diff.lifeStatus;
  if (diff.traumaTeamTier !== undefined) u.traumaTeamTier = diff.traumaTeamTier;
  if (diff.xanaduGold !== undefined) u.xanaduGold = diff.xanaduGold;
  const [updated] = await conn.update(characters).set(u).where(eq(characters.id, characterId)).returning();
  return updated;
}

// Fields that a player may change freely without staff review. Portraits,
// background bio, archetype, and the sheet's free-text preamble are presentation
// only — they never affect mechanics — so an edit touching ONLY these is applied
// instantly. Everything else (name, stat sections, stat images, life status,
// trauma tier, xanadu gold) still goes through the fixer review pipeline.
const COSMETIC_FIELDS = new Set(["portraitUrl", "portraitUrls", "background", "archetype"]);

// True when every changed field in `diff` is cosmetic. `sheetData` is special:
// it is cosmetic only when the ONLY thing that changed is the free-text
// `preamble` (framing prose / formatting). Any change to the stat `sections`
// OR to the discrete story fields the sheet/edit form stores at the top level
// (physicalDescription, appearance, psychProfile, hooks, skills, plus
// gear/guns/identity) is meaningful and must go through review.
function isCosmeticOnlyDiff(diff: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const keys = Object.keys(diff);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (COSMETIC_FIELDS.has(key)) continue;
    if (key === "sheetData") {
      // Compare every key of the sheet blob EXCEPT `preamble`. Comparing only
      // `sections` here was a silent bypass: a discrete story-field edit (e.g.
      // physicalDescription/appearance/psychProfile/hooks/skills) left
      // `sections` untouched, so it was wrongly treated as cosmetic and
      // auto-applied with no review request ever created.
      const before = (current.sheetData ?? {}) as Record<string, unknown>;
      const after = (diff.sheetData ?? {}) as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
      let meaningfulChange = false;
      for (const k of allKeys) {
        if (k === "preamble") continue;
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
          meaningfulChange = true;
          break;
        }
      }
      if (!meaningfulChange) continue;
      return false;
    }
    return false;
  }
  return true;
}

// Posts the "new edit pending" message to the CS approval channel and
// records the message id so future cancel/decide flows can reply in
// thread (matches the existing sheets.ts pattern).
async function announceEdit(editId: number, character: Character, submitter: User, diff: EditableDiff, note: string | null): Promise<void> {
  if (!CS_CHANNEL_ID) return;
  const changedFields = Object.keys(diff);
  const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "");
  const reviewUrl = portalBase ? `https://${portalBase}/pending-edits/${editId}` : `/pending-edits/${editId}`;
  const msgId = await postToChannel(
    CS_CHANNEL_ID,
    `Character edit pending review: **${character.name}** by ${submitter.username}`,
    [
      {
        title: `Edit to ${character.name}`,
        description: note?.slice(0, 500) ?? "(no note)",
        fields: [
          { name: "Submitter", value: submitter.username, inline: true },
          { name: "Fields changed", value: changedFields.length > 0 ? changedFields.join(", ") : "—", inline: true },
          { name: "Review", value: reviewUrl, inline: false },
        ],
      },
    ],
  );
  if (msgId) {
    // Start a thread from the summary post; the portal mirrors it read-only.
    // Thread id == the OP message id. Only persist discordThreadId when a thread
    // genuinely exists — on a hard failure (null) leave it unset so a later
    // backfill can thread from the stored message id.
    const threadId = await startThreadFromMessage(CS_CHANNEL_ID, msgId, `Edit: ${character.name}`);
    await db
      .update(pendingCharacterEdits)
      .set({ discordMessageId: msgId, ...(threadId ? { discordThreadId: threadId } : {}) })
      .where(eq(pendingCharacterEdits.id, editId));
  }
}

// Public entry point used by PATCH /characters/:id. Encapsulates the
// "create pending edit" path so the characters router doesn't have to
// duplicate validation, ownership, single-pending-per-char enforcement,
// or Discord wiring.
//
// Returns the created edit row, or null + an error reason for the caller
// to surface as 4xx. We don't throw here because the caller already has
// its own response shape contract.
export type CreatePendingEditError =
  | { kind: "no_changes" }
  | { kind: "edit_already_pending"; editId: number }
  | { kind: "edit_already_decided"; editId: number }
  | { kind: "forbidden"; message: string }
  | { kind: "invalid"; details: unknown };

export async function createPendingEdit(opts: {
  character: Character;
  submitter: User;
  body: unknown;
}): Promise<
  | { ok: true; autoApplied: true; reason: "cosmetic"; character: Character }
  | { ok: true; autoApplied?: false; edit: typeof pendingCharacterEdits.$inferSelect }
  | { ok: false; error: CreatePendingEditError }
> {
  // `updateNote` rides along in the same PATCH body but is metadata, not an
  // editable character field. Strip it BEFORE the strict parse — EditableSchema
  // is `.strict()`, so leaving it in rejects any noted edit as "invalid".
  const { updateNote: noteRaw, ...rest } = (opts.body ?? {}) as Record<string, unknown>;
  const parsed = EditableSchema.safeParse(rest);
  if (!parsed.success) {
    return { ok: false, error: { kind: "invalid", details: parsed.error.issues } };
  }
  // Strip noop fields (value identical to current character) so the
  // reviewer doesn't see a "changed" field that is in fact unchanged.
  const diff: Record<string, unknown> = {};
  const beforeSnapshot: Record<string, unknown> = {};
  const cur = opts.character as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    const before = cur[k];
    if (JSON.stringify(before) === JSON.stringify(v)) continue;
    diff[k] = v;
    beforeSnapshot[k] = before ?? null;
  }
  if (Object.keys(diff).length === 0) {
    return { ok: false, error: { kind: "no_changes" } };
  }

  // "Trauma Team Corporate" is a comped, corporate-sponsorship tier that only
  // staff may grant — players cannot self-assign it. The diff above is already
  // noop-stripped, so traumaTeamTier is only present here when it actually
  // CHANGED; this blocks a player switching INTO corporate while still letting
  // someone who already has it keep it (unchanged → not in the diff).
  if (
    diff.traumaTeamTier === "corporate" &&
    !hasRole(opts.submitter.roles, "ADMIN") &&
    !hasRole(opts.submitter.roles, "FIXER")
  ) {
    return {
      ok: false,
      error: { kind: "forbidden", message: "Only fixers can assign Trauma Team Corporate." },
    };
  }

  const updateNote = typeof noteRaw === "string" && noteRaw.trim().length > 0 ? noteRaw.trim().slice(0, 2000) : null;

  // NOTE: there is deliberately no admin/staff instant-apply path here. Every
  // non-cosmetic character edit — including an admin's or a fixer's — goes
  // through the fixer review queue like any other. Admins cannot vote on or
  // override their own edits (see the vote/override handlers), so an admin's
  // edit must be approved by a DIFFERENT reviewer. The cosmetic-only
  // short-circuit below still applies to everyone (it is not a staff
  // privilege).

  // Cosmetic-only edits (portraits, bio, archetype, sheet preamble/formatting)
  // bypass review entirely and apply on the spot. This runs BEFORE the
  // in-flight-edit logic so a player can always tweak presentation even while a
  // meaningful edit of theirs is still queued for fixer review — the two never
  // collide because cosmetic and meaningful fields are disjoint, and the queued
  // edit's own diff still wins when it is approved and closed.
  if (isCosmeticOnlyDiff(diff, cur)) {
    const character = await db.transaction(async (tx) => {
      const updated = await applyDiff(opts.character.id, diff as EditableDiff, tx);
      if (updateNote) {
        await tx.insert(characterUpdates).values({
          characterId: opts.character.id,
          authorId: opts.submitter.id,
          note: updateNote,
        });
      }
      await tx.insert(activityEvents).values({
        kind: "character_edit_applied",
        actorId: opts.submitter.id,
        actorName: opts.submitter.username,
        actorAvatarUrl: opts.submitter.avatarUrl,
        message: `${opts.submitter.username} updated ${opts.character.name} (cosmetic — auto-applied)`,
      });
      return updated;
    });
    return { ok: true, autoApplied: true, reason: "cosmetic", character };
  }

  // One in-flight edit per character. Since reviewer feedback now flows through
  // the non-blocking comment thread (not a blocking 'changes_requested' park),
  // the submitter must be able to AMEND their still-in-flight edit in place —
  // whether it is 'pending' or a legacy 'changes_requested' row. Amending
  // updates that same row and clears the prior round's votes/decision so the
  // review re-tallies against the new content, instead of spawning a duplicate
  // review. The 409 is reserved for the (practically impossible) case where a
  // DIFFERENT user already holds the pending edit for this character.
  const [inFlight] = await db
    .select()
    .from(pendingCharacterEdits)
    .where(
      and(
        eq(pendingCharacterEdits.characterId, opts.character.id),
        inArray(pendingCharacterEdits.status, ["pending", "changes_requested"]),
      ),
    )
    .orderBy(desc(pendingCharacterEdits.submittedAt));
  if (inFlight) {
    if (inFlight.submittedBy !== opts.submitter.id) {
      return { ok: false, error: { kind: "edit_already_pending", editId: inFlight.id } };
    }
    // Atomic state guard: only amend-in-place if the row is STILL in-flight. A
    // concurrent admin override/decision could have moved it to
    // approved/rejected between the select above and this update; the
    // status-scoped WHERE makes that update a no-op so we never revert a
    // decided edit back to pending.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(pendingCharacterEdits)
        .set({
          proposedDiff: diff,
          beforeSnapshot,
          updateNote,
          status: "pending",
          reviewComment: null,
          decisionSummary: null,
          decidedAt: null,
          submittedAt: new Date(),
        })
        .where(
          and(
            eq(pendingCharacterEdits.id, inFlight.id),
            inArray(pendingCharacterEdits.status, ["pending", "changes_requested"]),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.delete(pendingEditApprovals).where(eq(pendingEditApprovals.editId, inFlight.id));
      return row;
    });
    if (!updated) {
      // The edit was decided concurrently; falling through is unsafe (would
      // create a duplicate), so surface a conflict the client can refresh on.
      return { ok: false, error: { kind: "edit_already_decided", editId: inFlight.id } };
    }
    announceEdit(updated.id, opts.character, opts.submitter, diff as EditableDiff, updateNote).catch((e) => {
      console.error("[pending-edits] Discord announce failed", e);
    });
    await db.insert(activityEvents).values({
      kind: "character_edit_submitted",
      actorId: opts.submitter.id,
      actorName: opts.submitter.username,
      actorAvatarUrl: opts.submitter.avatarUrl,
      message: `${opts.submitter.username} updated an in-flight edit for ${opts.character.name}`,
    });
    return { ok: true, edit: updated };
  }

  const [edit] = await db
    .insert(pendingCharacterEdits)
    .values({
      characterId: opts.character.id,
      submittedBy: opts.submitter.id,
      proposedDiff: diff,
      beforeSnapshot,
      updateNote,
      status: "pending",
    })
    .returning();
  // Fire-and-forget; failures here must not block edit submission.
  announceEdit(edit.id, opts.character, opts.submitter, diff as EditableDiff, updateNote).catch((e) => {
    console.error("[pending-edits] Discord announce failed", e);
  });
  await db.insert(activityEvents).values({
    kind: "character_edit_submitted",
    actorId: opts.submitter.id,
    actorName: opts.submitter.username,
    actorAvatarUrl: opts.submitter.avatarUrl,
    message: `${opts.submitter.username} submitted an edit for ${opts.character.name}`,
  });
  return { ok: true, edit };
}

// Hydrate one or more edits with the joined character + submitter info
// the UI needs for list rendering and the diff view.
async function hydrateEdits(
  rows: Array<typeof pendingCharacterEdits.$inferSelect>,
  opts: { viewerId: string; includeRoster: boolean },
) {
  if (rows.length === 0) return [];
  const charIds = Array.from(new Set(rows.map((r) => r.characterId)));
  const userIds = Array.from(new Set(rows.map((r) => r.submittedBy)));
  const editIds = rows.map((r) => r.id);
  const chars = await db.select().from(characters).where(inArray(characters.id, charIds));
  const subs = await db.select().from(users).where(inArray(users.id, userIds));
  const charById = new Map(chars.map((c) => [c.id, c]));
  const subById = new Map(subs.map((u) => [u.id, u]));

  // Full eligible reviewer pool, computed once. Per-edit threshold excludes
  // that edit's own submitter (you can't vote on your own edit), matching
  // the detail endpoint's math so list and detail never disagree.
  const reviewerRows = await db
    .select({ id: users.id, roles: users.roles, name: users.username, avatarUrl: users.avatarUrl })
    .from(users);
  const reviewerPool = reviewerRows
    .filter((r) => isEligibleReviewer({ roles: r.roles ?? [] } as User))
    .map((r) => ({ id: r.id, name: r.name, avatarUrl: r.avatarUrl }));
  const reviewerIds = reviewerPool.map((r) => r.id);

  // All votes across the listed edits, joined to voter names, in one query.
  const allVotes = await db
    .select({
      editId: pendingEditApprovals.editId,
      voterId: pendingEditApprovals.voterId,
      voterName: users.username,
      voterAvatarUrl: users.avatarUrl,
      vote: pendingEditApprovals.vote,
      note: pendingEditApprovals.note,
      votedAt: pendingEditApprovals.votedAt,
    })
    .from(pendingEditApprovals)
    .leftJoin(users, eq(users.id, pendingEditApprovals.voterId))
    .where(inArray(pendingEditApprovals.editId, editIds))
    .orderBy(desc(pendingEditApprovals.votedAt));
  const votesByEdit = new Map<number, typeof allVotes>();
  for (const v of allVotes) {
    const list = votesByEdit.get(v.editId);
    if (list) list.push(v);
    else votesByEdit.set(v.editId, [v]);
  }

  // "Last activity" = max(submittedAt, newest review comment) so the queue can
  // sort by recently-updated, mirroring the unread-badge signal.
  const activityByEdit = await loadLastActivityBySubject(
    "edit",
    rows.map((r) => ({ id: r.id, baseAt: r.submittedAt })),
  );

  return rows.map((r) => {
    const c = charById.get(r.characterId);
    const s = subById.get(r.submittedBy);
    const eligible = reviewerPool.filter((rv) => rv.id !== r.submittedBy);
    const eligibleCount = eligible.length;
    const eligibleSet = new Set(eligible.map((rv) => rv.id));
    const allVotes = votesByEdit.get(r.id) ?? [];
    // Count only eligible-pool votes so an ineligible (e.g. admin-only) vote
    // can't skew the displayed tally — mirrors the decision math.
    const votes = allVotes.filter((v) => eligibleSet.has(v.voterId));
    const approveCount = votes.filter((v) => v.vote === "approve").length;
    const rejectCount = votes.filter((v) => v.vote === "reject").length;
    const myVote = allVotes.find((v) => v.voterId === opts.viewerId) ?? null;
    return {
      id: r.id,
      characterId: r.characterId,
      characterName: c?.name ?? "(deleted)",
      submittedBy: r.submittedBy,
      submitterName: s?.username ?? null,
      submitterAvatarUrl: s?.avatarUrl ?? null,
      proposedDiff: r.proposedDiff,
      // Only the fields that meaningfully changed (canonical compare vs the
      // before-snapshot) so the queue card's field count matches the detail
      // page's diff exactly — a no-op sheetData re-save is excluded.
      changedFields: meaningfulChangedFields(r.proposedDiff, r.beforeSnapshot),
      updateNote: r.updateNote,
      status: r.status,
      decisionSummary: r.decisionSummary,
      reviewComment: r.reviewComment,
      overriddenBy: r.overriddenBy,
      submittedAt: r.submittedAt,
      lastActivityAt: (activityByEdit.get(r.id) ?? r.submittedAt).toISOString(),
      decidedAt: r.decidedAt,
      approveCount,
      rejectCount,
      threshold: majorityOf(eligibleCount),
      myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
      voters: votes.map((v) => ({
        id: v.voterId,
        name: v.voterName ?? "(unknown)",
        avatarUrl: v.voterAvatarUrl ?? null,
        vote: v.vote,
      })),
      // Full eligible-reviewer roster (incl. who hasn't voted) is reviewer-only
      // info — omit it for the player-facing "my own submissions" view.
      ...(opts.includeRoster ? { eligibleReviewers: eligible } : {}),
    };
  });
}

// Re-evaluate one still-`pending` edit against the LIVE eligible-reviewer
// majority and, if it now resolves, apply the same staged transition the vote
// handler makes. Self-heals edits stranded `pending` after the eligible pool
// shrank (a reviewer's role was revoked or they left) below the already-cast
// tally — the decision is otherwise only evaluated at vote-cast time, so the
// edit never surfaces its Close & Apply action. Locked (FOR UPDATE) + status-
// guarded, so it is idempotent and races safely with a real vote or admin
// override. Effects stay DEFERRED to close (the diff is applied then). Returns
// the decided status, or null if it stayed pending. Reviewer-gated by caller.
async function finalizeDecidedEdit(req: Request, id: number): Promise<"approved" | "rejected" | null> {
  const result = await db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, status, character_id, submitted_by
          FROM pending_character_edits
          WHERE id = ${id}
          FOR UPDATE`,
    );
    const locked = (lockedRows as unknown as { rows: Array<{ status: string; character_id: number; submitted_by: string }> }).rows?.[0]
      ?? (lockedRows as unknown as Array<{ status: string; character_id: number; submitted_by: string }>)[0];
    if (!locked || locked.status !== "pending") return null;
    const allVotes = await tx.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, id));
    const eligibleIds = await listEligibleReviewerIds(locked.submitted_by);
    const eligibleSet = new Set(eligibleIds);
    const effective = allVotes.filter((v) => eligibleSet.has(v.voterId));
    const approves = effective.filter((v) => v.vote === "approve").length;
    const rejects = effective.filter((v) => v.vote === "reject").length;
    const threshold = majorityOf(eligibleIds.length);
    let decided: "approved" | "rejected" | null = null;
    if (approves >= threshold) decided = "approved";
    else if (rejects >= threshold) decided = "rejected";
    if (!decided) return null;
    await tx
      .update(pendingCharacterEdits)
      .set({
        status: decided,
        decidedAt: new Date(),
        decisionSummary: `${approves} approve / ${rejects} reject (threshold ${threshold} of ${eligibleIds.length})`,
      })
      .where(eq(pendingCharacterEdits.id, id));
    if (decided === "rejected") {
      await tx.insert(activityEvents).values({
        kind: "character_edit_rejected",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorAvatarUrl: req.user!.avatarUrl,
        message: `Edit on character #${locked.character_id} rejected (${rejects}/${threshold})`,
      });
    }
    return decided;
  });
  return result ?? null;
}

// GET /pending-edits — fixer/admin sees ALL pending; everyone else sees
// only their own (so a player can find their submission). Closed edits
// drop off the list after 7 days to keep it readable.
router.get("/pending-edits", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const isStaff = isReviewer(u);
  // Reviewers can scope the staff queue to a lifecycle bucket (active /
  // resolved / archive). With no bucket we keep the legacy default: open edits
  // plus anything decided in the last 7 days.
  const bucket = req.query.bucket ? String(req.query.bucket) : null;
  let staffWhere;
  if (bucket === "active") {
    staffWhere = inArray(pendingCharacterEdits.status, ["pending", "changes_requested"]);
  } else if (bucket === "resolved") {
    staffWhere = inArray(pendingCharacterEdits.status, ["approved", "rejected", "cancelled"]);
  } else if (bucket === "archive") {
    staffWhere = eq(pendingCharacterEdits.status, "closed");
  } else {
    staffWhere = or(
      eq(pendingCharacterEdits.status, "pending"),
      eq(pendingCharacterEdits.status, "changes_requested"),
      sql`${pendingCharacterEdits.decidedAt} > NOW() - INTERVAL '7 days'`,
    );
  }
  const rows = await db
    .select()
    .from(pendingCharacterEdits)
    .where(isStaff ? staffWhere : eq(pendingCharacterEdits.submittedBy, u.id))
    .orderBy(desc(pendingCharacterEdits.submittedAt));
  const out = await hydrateEdits(rows, { viewerId: u.id, includeRoster: isStaff });
  // Self-heal any edit whose tally already passes the (possibly shrunk)
  // majority but was left pending — reviewer-only — see finalizeDecidedEdit.
  if (isStaff) {
    for (const entry of out) {
      if (entry.status !== "pending") continue;
      if (entry.approveCount < entry.threshold && entry.rejectCount < entry.threshold) continue;
      const decided = await finalizeDecidedEdit(req, entry.id);
      if (decided) entry.status = decided;
    }
  }
  res.json(out);
});

// GET /pending-edits/:id — full detail + before/after snapshot + votes.
// The "before" snapshot is the LIVE character row (not a snapshot at
// submission time). This is intentional: if the underlying character
// has drifted since submission, the reviewer needs to see it. The
// majority threshold and current tally are included so the UI can
// render "2 of 3 approvals" without re-deriving the math client-side.
router.get("/pending-edits/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  let [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const u = req.user!;
  const isStaff = isReviewer(u);
  // Only fixers / cs-approvers cast counted votes; a pure admin reviews via
  // OVERRIDE, not the vote/request-changes flow.
  const canCast = isEligibleReviewer(u);
  const isSubmitter = row.submittedBy === u.id;
  if (!isStaff && !isSubmitter) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Self-heal an edit whose tally already passes the (possibly shrunk) majority
  // but was left pending, then re-read it so the response reflects the decision.
  if (isStaff && row.status === "pending") {
    const decided = await finalizeDecidedEdit(req, id);
    if (decided) [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, row.characterId));
  const [submitter] = await db.select().from(users).where(eq(users.id, row.submittedBy));
  const votes = await db
    .select({
      id: pendingEditApprovals.id,
      voterId: pendingEditApprovals.voterId,
      voterName: users.username,
      voterAvatarUrl: users.avatarUrl,
      vote: pendingEditApprovals.vote,
      note: pendingEditApprovals.note,
      votedAt: pendingEditApprovals.votedAt,
    })
    .from(pendingEditApprovals)
    .leftJoin(users, eq(users.id, pendingEditApprovals.voterId))
    .where(eq(pendingEditApprovals.editId, id))
    .orderBy(desc(pendingEditApprovals.votedAt));
  const eligibleReviewers = await listEligibleReviewers(row.submittedBy);
  const eligibleIds = eligibleReviewers.map((r) => r.id);
  const eligibleSet = new Set(eligibleIds);
  const threshold = majorityOf(eligibleIds.length);
  // Count only eligible-pool votes so an ineligible (e.g. admin-only) vote can't
  // skew the displayed tally — mirrors the decision math.
  const effectiveVotes = votes.filter((v) => eligibleSet.has(v.voterId));
  const approveCount = effectiveVotes.filter((v) => v.vote === "approve").length;
  const rejectCount = effectiveVotes.filter((v) => v.vote === "reject").length;
  const myVote = votes.find((v) => v.voterId === u.id) ?? null;
  // Build a field-by-field before/after preview. We use the snapshot
  // captured at submission time so the reviewer sees what the submitter
  // saw, not values that may have drifted since (e.g. admin edits).
  const diff = (row.proposedDiff ?? {}) as Record<string, unknown>;
  const before = (row.beforeSnapshot ?? {}) as Record<string, unknown>;
  res.json({
    id: row.id,
    characterId: row.characterId,
    characterName: c?.name ?? "(deleted)",
    characterOwnerId: c?.ownerId ?? null,
    submittedBy: row.submittedBy,
    submitterName: submitter?.username ?? null,
    submitterAvatarUrl: submitter?.avatarUrl ?? null,
    proposedDiff: diff,
    before,
    updateNote: row.updateNote,
    status: row.status,
    decisionSummary: row.decisionSummary,
    reviewComment: row.reviewComment,
    overriddenBy: row.overriddenBy,
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    votes,
    // Reviewer-only: the full eligible-reviewer roster (incl. who hasn't voted)
    // is staff info — don't expose it to the submitter viewing their own edit.
    eligibleReviewers: isStaff ? eligibleReviewers : undefined,
    eligibleVoterCount: eligibleIds.length,
    threshold,
    approveCount,
    rejectCount,
    myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
    canVote: canCast && !isSubmitter && row.status === "pending",
    // Fixers / cs-approvers (not the submitter) can request changes on a pending
    // edit. Admins are excluded here (they use override).
    canRequestChanges: canCast && !isSubmitter && row.status === "pending",
    // Admins can override a pending edit to immediate approval.
    canOverride: hasRole(u.roles, "ADMIN") && !isSubmitter && row.status === "pending",
    // The submitter can resubmit once changes were requested.
    canResubmit: isSubmitter && row.status === "changes_requested",
    // Any reviewer can apply-and-close an edit once all approvals are in.
    canClose: isStaff && row.status === "approved",
  });
});

const VoteSchema = z.object({
  vote: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
});

// POST /pending-edits/:id/vote — record a reviewer's vote and, if the
// vote pushes either side past the majority threshold, decide the edit
// (apply diff on approve, just mark rejected on reject). Votes are
// upserted: a reviewer can change their mind while the edit is still
// pending.
router.post("/pending-edits/:id/vote", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  if (!isEligibleReviewer(u)) {
    res.status(403).json({ error: "Only fixers / approvers can vote. Admins use override." });
    return;
  }
  const parsed = VoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid vote", details: parsed.error.issues });
    return;
  }
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: `Edit already ${row.status}` });
    return;
  }
  if (row.submittedBy === u.id) {
    res.status(403).json({ error: "You cannot vote on your own edit" });
    return;
  }
  // Wrap upsert + tally + decision in a single transaction with a row
  // lock on the edit so two concurrent voters can't both observe
  // "threshold - 1" and double-apply the diff or write conflicting
  // decisionSummary strings.
  const result = await db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, status, character_id, submitted_by, proposed_diff, update_note
          FROM pending_character_edits
          WHERE id = ${id}
          FOR UPDATE`,
    );
    const locked = (lockedRows as unknown as { rows: Array<{ status: string; character_id: number; submitted_by: string; proposed_diff: unknown; update_note: string | null }> }).rows?.[0]
      ?? (lockedRows as unknown as Array<{ status: string; character_id: number; submitted_by: string; proposed_diff: unknown; update_note: string | null }>)[0];
    if (!locked) return { kind: "not_found" as const };
    if (locked.status !== "pending") return { kind: "already_decided" as const, status: locked.status };

    await tx
      .insert(pendingEditApprovals)
      .values({
        editId: id,
        voterId: u.id,
        vote: parsed.data.vote,
        note: parsed.data.note ?? null,
      })
      .onConflictDoUpdate({
        target: [pendingEditApprovals.editId, pendingEditApprovals.voterId],
        set: { vote: parsed.data.vote, note: parsed.data.note ?? null, votedAt: new Date() },
      });

    const allVotes = await tx.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, id));
    const eligibleIds = await listEligibleReviewerIds(locked.submitted_by);
    const eligibleSet = new Set(eligibleIds);
    const effective = allVotes.filter((v) => eligibleSet.has(v.voterId));
    const approves = effective.filter((v) => v.vote === "approve").length;
    const rejects = effective.filter((v) => v.vote === "reject").length;
    const threshold = majorityOf(eligibleIds.length);
    let decided: "approved" | "rejected" | null = null;
    if (approves >= threshold) decided = "approved";
    else if (rejects >= threshold) decided = "rejected";

    // Effects are DEFERRED: a majority approve only STAGES the decision; the
    // proposed diff is applied to the character when a fixer closes the ticket.
    // Rejection has no effect to defer, so we keep its activity-feed event.
    if (decided) {
      await tx
        .update(pendingCharacterEdits)
        .set({
          status: decided,
          decidedAt: new Date(),
          decisionSummary: `${approves} approve / ${rejects} reject (threshold ${threshold} of ${eligibleIds.length})`,
        })
        .where(eq(pendingCharacterEdits.id, id));
      if (decided === "rejected") {
        await tx.insert(activityEvents).values({
          kind: "character_edit_rejected",
          actorId: u.id,
          actorName: u.username,
          actorAvatarUrl: u.avatarUrl,
          message: `Edit on character #${locked.character_id} rejected (${rejects}/${threshold})`,
        });
      }
    }
    return { kind: "ok" as const, decided, approves, rejects, threshold, eligibleVoterCount: eligibleIds.length };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (result.kind === "already_decided") {
    res.status(409).json({ error: `Edit already ${result.status}` });
    return;
  }
  res.json({
    ok: true,
    status: result.decided ?? "pending",
    approveCount: result.approves,
    rejectCount: result.rejects,
    threshold: result.threshold,
    eligibleVoterCount: result.eligibleVoterCount,
  });
});

// POST /pending-edits/:id/override — admin-only immediate approval that
// bypasses the majority vote. Records who overrode (overriddenBy). Works on a
// pending OR changes_requested edit. Mirrors the vote-approved apply path.
router.post("/pending-edits/:id/override", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  if (!hasRole(u.roles, "ADMIN")) {
    res.status(403).json({ error: "Only admins can override" });
    return;
  }
  // Override can approve (default) OR deny, both bypassing the majority vote.
  const deny = req.body?.decision === "deny";
  const newStatus = deny ? "rejected" : "approved";
  const result = await db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, status, character_id, submitted_by, proposed_diff, update_note
          FROM pending_character_edits WHERE id = ${id} FOR UPDATE`,
    );
    const locked = (lockedRows as unknown as { rows: Array<{ status: string; character_id: number; submitted_by: string; proposed_diff: unknown; update_note: string | null }> }).rows?.[0]
      ?? (lockedRows as unknown as Array<{ status: string; character_id: number; submitted_by: string; proposed_diff: unknown; update_note: string | null }>)[0];
    if (!locked) return { kind: "not_found" as const };
    if (locked.status !== "pending" && locked.status !== "changes_requested") {
      return { kind: "already_decided" as const, status: locked.status };
    }
    if (locked.submitted_by === u.id) return { kind: "own" as const };
    // Effects deferred: staging the decision only; an approved diff is applied
    // when the ticket is closed, a denied one is simply archived on close.
    await tx
      .update(pendingCharacterEdits)
      .set({
        status: newStatus,
        decidedAt: new Date(),
        overriddenBy: u.id,
        decisionSummary: `${deny ? "Denied" : "Approved"} via admin override by ${u.username}`,
      })
      .where(eq(pendingCharacterEdits.id, id));
    return { kind: "ok" as const };
  });
  if (result.kind === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (result.kind === "own") { res.status(403).json({ error: "You cannot override your own edit" }); return; }
  if (result.kind === "already_decided") { res.status(409).json({ error: `Edit already ${result.status}` }); return; }
  res.json({ ok: true, status: newStatus });
});

// POST /pending-edits/:id/request-changes — RETIRED. Reviewers no longer park
// edits in a blocking `changes_requested` state; comments via the /review thread
// are non-blocking communication and never gate approval. Legacy rows already
// in `changes_requested` still resubmit normally. Endpoint kept registered so
// stale clients get a clear 410 rather than a 404.
router.post("/pending-edits/:id/request-changes", requireAuth, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Request-changes is retired. Use the comment thread; it never blocks approval." });
});

// POST /pending-edits/:id/resubmit — the submitter sends a changes_requested
// edit back to the review queue. Votes are cleared so the next round starts
// fresh; resubmitting with no further changes is allowed.
router.post("/pending-edits/:id/resubmit", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.submittedBy !== u.id && !hasRole(u.roles, "ADMIN")) {
    res.status(403).json({ error: "Only the submitter can resubmit" });
    return;
  }
  if (row.status !== "changes_requested") {
    res.status(409).json({ error: `Edit is ${row.status}, not awaiting changes` });
    return;
  }
  // Another pending edit may have been opened on this character meanwhile; the
  // unique index only covers status='pending', so guard explicitly.
  const [conflict] = await db
    .select({ id: pendingCharacterEdits.id })
    .from(pendingCharacterEdits)
    .where(and(eq(pendingCharacterEdits.characterId, row.characterId), eq(pendingCharacterEdits.status, "pending")));
  if (conflict) {
    res.status(409).json({ error: "Another edit for this character is already pending" });
    return;
  }
  // Atomic: only flip back to pending (and clear votes) if the edit is STILL
  // changes_requested. A concurrent admin override could have already approved
  // it; flipping it back would let a later vote apply the edit a second time.
  const resubmitted = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(pendingCharacterEdits)
      .set({ status: "pending", reviewComment: null, decisionSummary: null, decidedAt: null, submittedAt: new Date() })
      .where(and(eq(pendingCharacterEdits.id, id), eq(pendingCharacterEdits.status, "changes_requested")))
      .returning();
    if (!changed) return false;
    await tx.delete(pendingEditApprovals).where(eq(pendingEditApprovals.editId, id));
    return true;
  });
  if (!resubmitted) { res.status(409).json({ error: "Edit is no longer awaiting changes" }); return; }
  const [c] = await db.select().from(characters).where(eq(characters.id, row.characterId));
  if (c) {
    announceEdit(id, c, u, (row.proposedDiff ?? {}) as EditableDiff, row.updateNote).catch((e) =>
      console.error("[pending-edits] resubmit announce failed", e),
    );
  }
  res.json({ ok: true, status: "pending" });
});

// POST /pending-edits/:id/cancel — submitter (or admin) withdraws the
// pending edit. Closed edits can't be cancelled (no-op 409).
router.post("/pending-edits/:id/cancel", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const isOwner = row.submittedBy === u.id;
  const isAdmin = hasRole(u.roles, "ADMIN");
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: `Edit already ${row.status}` });
    return;
  }
  await db
    .update(pendingCharacterEdits)
    .set({ status: "cancelled", decidedAt: new Date(), decisionSummary: `cancelled by ${u.username}` })
    .where(eq(pendingCharacterEdits.id, id));
  res.json({ ok: true, status: "cancelled" });
});

// GET /characters/:id/pending-edit — convenience endpoint used by the
// character detail page to render a "pending review" badge. Returns 204
// when nothing is pending so the client can branch cheaply.
router.get("/characters/:id/pending-edit", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [row] = await db
    .select()
    .from(pendingCharacterEdits)
    .where(and(eq(pendingCharacterEdits.characterId, id), eq(pendingCharacterEdits.status, "pending")));
  if (!row) {
    res.status(204).end();
    return;
  }
  res.json({ id: row.id, submittedAt: row.submittedAt, submittedBy: row.submittedBy });
});

// Close a RESOLVED character edit (approved | rejected | cancelled) → archived.
// Closing an APPROVED edit commits the proposed diff to the character exactly
// once (an edit becomes `closed` and is terminal, so it can't be re-applied);
// closing a rejected/cancelled edit just archives it. Idempotent: re-closing an
// already-closed edit is a 200 no-op. The diff is applied inside the locked txn
// so apply + status flip are atomic. Caller has already verified the actor is a
// reviewer.
export async function closeEdit(req: Request, id: number, note?: string): Promise<ReviewActionResult> {
  const u = req.user!;
  const result = await db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, status, character_id, submitted_by, proposed_diff, update_note
          FROM pending_character_edits WHERE id = ${id} FOR UPDATE`,
    );
    const locked = (lockedRows as unknown as { rows: Array<{ status: string; character_id: number; submitted_by: string; proposed_diff: unknown; update_note: string | null }> }).rows?.[0]
      ?? (lockedRows as unknown as Array<{ status: string; character_id: number; submitted_by: string; proposed_diff: unknown; update_note: string | null }>)[0];
    if (!locked) return { kind: "error" as const, status: 404, body: { error: "Not found" } };
    if (locked.status === "closed") return { kind: "noop" as const };
    if (locked.status !== "approved" && locked.status !== "rejected" && locked.status !== "cancelled") {
      return { kind: "error" as const, status: 409, body: { error: `Only a resolved edit can be closed (this one is ${locked.status})` } };
    }
    if (locked.status === "approved") {
      const diff = (locked.proposed_diff ?? {}) as EditableDiff;
      await applyDiff(locked.character_id, diff, tx);
      if (locked.update_note) {
        await tx.insert(characterUpdates).values({
          characterId: locked.character_id,
          authorId: locked.submitted_by,
          note: locked.update_note,
        });
      }
      await tx.insert(activityEvents).values({
        kind: "character_edit_approved",
        actorId: u.id,
        actorName: u.username,
        actorAvatarUrl: u.avatarUrl,
        message: `Edit on character #${locked.character_id} applied on close${note ? ` — note: ${note}` : ""}`,
      });
    }
    await tx
      .update(pendingCharacterEdits)
      .set({ status: "closed", closedAt: new Date(), closedBy: u.id })
      .where(eq(pendingCharacterEdits.id, id));
    return { kind: "ok" as const, status: locked.status };
  });
  if (result.kind === "error") return { status: result.status, body: result.body };
  if (result.kind === "ok") {
    await recordAudit({
      req,
      category: "character",
      action: "edit_closed",
      targetType: "pending_character_edit",
      targetId: id,
      message: `Closed character edit (${result.status})${note ? ` — note: ${note}` : ""}`,
    });
  }
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  return { status: 200, body: { ok: true, status: "closed", id: row?.id } };
}

// Reopen a RESOLVED-but-not-archived character edit (approved | rejected) back
// to pending for another review round. Votes are deleted and the decision fields
// are wiped. Because effects are deferred, an approved-not-closed edit has not
// been applied yet, so reopening it is safe. cancelled and closed edits cannot
// be reopened.
export async function reopenEdit(req: Request, id: number): Promise<ReviewActionResult> {
  const result = await db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, status, character_id FROM pending_character_edits WHERE id = ${id} FOR UPDATE`,
    );
    const locked = (lockedRows as unknown as { rows: Array<{ status: string; character_id: number }> }).rows?.[0]
      ?? (lockedRows as unknown as Array<{ status: string; character_id: number }>)[0];
    if (!locked) return { error: { status: 404, body: { error: "Not found" } } };
    if (locked.status !== "approved" && locked.status !== "rejected") {
      return { error: { status: 409, body: { error: `Only an approved or rejected edit can be reopened (this one is ${locked.status})` } } };
    }
    // Another pending edit may exist on this character; the partial unique
    // index only covers status='pending', so guard explicitly.
    const [conflict] = await tx
      .select({ id: pendingCharacterEdits.id })
      .from(pendingCharacterEdits)
      .where(and(eq(pendingCharacterEdits.characterId, locked.character_id), eq(pendingCharacterEdits.status, "pending")));
    if (conflict) return { error: { status: 409, body: { error: "Another edit for this character is already pending" } } };
    await tx
      .update(pendingCharacterEdits)
      .set({ status: "pending", decidedAt: null, decisionSummary: null, reviewComment: null, overriddenBy: null, submittedAt: new Date() })
      .where(eq(pendingCharacterEdits.id, id));
    await tx.delete(pendingEditApprovals).where(eq(pendingEditApprovals.editId, id));
    return { ok: true as const };
  });
  if ("error" in result && result.error) return result.error;
  await recordAudit({
    req,
    category: "character",
    action: "edit_reopened",
    targetType: "pending_character_edit",
    targetId: id,
    message: `Reopened character edit`,
  });
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  return { status: 200, body: { ok: true, status: "pending", id: row?.id } };
}

export default router;
