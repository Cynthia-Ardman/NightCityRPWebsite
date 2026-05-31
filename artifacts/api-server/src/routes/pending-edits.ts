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
import { requireAuth } from "../middlewares/auth";
import { hasRole, postToChannel, sendDirectMessage } from "../lib/discord";
import { isReviewer, listEligibleReviewerIds, majorityOf } from "../lib/review";

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
    sheetData: z.object({
      preamble: z.string(),
      sections: z.record(z.string(), z.string()),
    }),
    lifeStatus: z.enum(["active", "dead", "missing", "loa", "retired"]),
    traumaTeamTier: z.enum(["silver", "gold", "platinum", "diamond"]).nullable(),
    xanaduGold: z.boolean(),
  })
  .partial()
  .strict();

export type EditableDiff = z.infer<typeof EditableSchema>;

// Apply an approved diff to the characters row. Mirrors the legacy
// PATCH /characters/:id apply logic so the eventual database state is
// identical to what the player would have gotten pre-review.
async function applyDiff(characterId: number, diff: EditableDiff): Promise<Character> {
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
  const [updated] = await db.update(characters).set(u).where(eq(characters.id, characterId)).returning();
  return updated;
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
    await db.update(pendingCharacterEdits).set({ discordMessageId: msgId }).where(eq(pendingCharacterEdits.id, editId));
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
  | { kind: "invalid"; details: unknown };

export async function createPendingEdit(opts: {
  character: Character;
  submitter: User;
  body: unknown;
}): Promise<{ ok: true; edit: typeof pendingCharacterEdits.$inferSelect } | { ok: false; error: CreatePendingEditError }> {
  const parsed = EditableSchema.safeParse(opts.body ?? {});
  if (!parsed.success) {
    return { ok: false, error: { kind: "invalid", details: parsed.error.issues } };
  }
  const { updateNote: _ignored, ...rest } = (opts.body ?? {}) as Record<string, unknown>;
  void _ignored;
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
  const [existing] = await db
    .select()
    .from(pendingCharacterEdits)
    .where(and(eq(pendingCharacterEdits.characterId, opts.character.id), eq(pendingCharacterEdits.status, "pending")));
  if (existing) {
    return { ok: false, error: { kind: "edit_already_pending", editId: existing.id } };
  }
  const noteRaw = (opts.body as Record<string, unknown>)?.updateNote;
  const updateNote = typeof noteRaw === "string" && noteRaw.trim().length > 0 ? noteRaw.trim().slice(0, 2000) : null;
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
async function hydrateEdits(rows: Array<typeof pendingCharacterEdits.$inferSelect>) {
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
  const reviewerRows = await db.select({ id: users.id, roles: users.roles }).from(users);
  const reviewerIds = reviewerRows
    .filter((r) => isReviewer({ roles: r.roles ?? [] } as User))
    .map((r) => r.id);

  // All votes across the listed edits, joined to voter names, in one query.
  const allVotes = await db
    .select({
      editId: pendingEditApprovals.editId,
      voterId: pendingEditApprovals.voterId,
      voterName: users.username,
      voterAvatarUrl: users.avatarUrl,
      vote: pendingEditApprovals.vote,
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

  return rows.map((r) => {
    const c = charById.get(r.characterId);
    const s = subById.get(r.submittedBy);
    const votes = votesByEdit.get(r.id) ?? [];
    const approveCount = votes.filter((v) => v.vote === "approve").length;
    const rejectCount = votes.filter((v) => v.vote === "reject").length;
    const eligibleCount = reviewerIds.filter((id) => id !== r.submittedBy).length;
    return {
      id: r.id,
      characterId: r.characterId,
      characterName: c?.name ?? "(deleted)",
      submittedBy: r.submittedBy,
      submitterName: s?.username ?? null,
      submitterAvatarUrl: s?.avatarUrl ?? null,
      proposedDiff: r.proposedDiff,
      updateNote: r.updateNote,
      status: r.status,
      decisionSummary: r.decisionSummary,
      reviewComment: r.reviewComment,
      overriddenBy: r.overriddenBy,
      submittedAt: r.submittedAt,
      decidedAt: r.decidedAt,
      approveCount,
      rejectCount,
      threshold: majorityOf(eligibleCount),
      voters: votes.map((v) => ({
        name: v.voterName ?? "(unknown)",
        avatarUrl: v.voterAvatarUrl ?? null,
        vote: v.vote,
      })),
    };
  });
}

// GET /pending-edits — fixer/admin sees ALL pending; everyone else sees
// only their own (so a player can find their submission). Closed edits
// drop off the list after 7 days to keep it readable.
router.get("/pending-edits", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const isStaff = isReviewer(u);
  const rows = await db
    .select()
    .from(pendingCharacterEdits)
    .where(
      isStaff
        ? or(
            eq(pendingCharacterEdits.status, "pending"),
            eq(pendingCharacterEdits.status, "changes_requested"),
            sql`${pendingCharacterEdits.decidedAt} > NOW() - INTERVAL '7 days'`,
          )
        : eq(pendingCharacterEdits.submittedBy, u.id),
    )
    .orderBy(desc(pendingCharacterEdits.submittedAt));
  res.json(await hydrateEdits(rows));
});

// GET /pending-edits/:id — full detail + before/after snapshot + votes.
// The "before" snapshot is the LIVE character row (not a snapshot at
// submission time). This is intentional: if the underlying character
// has drifted since submission, the reviewer needs to see it. The
// majority threshold and current tally are included so the UI can
// render "2 of 3 approvals" without re-deriving the math client-side.
router.get("/pending-edits/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const u = req.user!;
  const isStaff = isReviewer(u);
  const isSubmitter = row.submittedBy === u.id;
  if (!isStaff && !isSubmitter) {
    res.status(403).json({ error: "Forbidden" });
    return;
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
  const eligibleIds = await listEligibleReviewerIds(row.submittedBy);
  const threshold = majorityOf(eligibleIds.length);
  const approveCount = votes.filter((v) => v.vote === "approve").length;
  const rejectCount = votes.filter((v) => v.vote === "reject").length;
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
    eligibleVoterCount: eligibleIds.length,
    threshold,
    approveCount,
    rejectCount,
    myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
    canVote: isStaff && !isSubmitter && row.status === "pending",
    // Reviewers (not the submitter) can request changes on a pending edit.
    canRequestChanges: isStaff && !isSubmitter && row.status === "pending",
    // Admins can override a pending edit to immediate approval.
    canOverride: hasRole(u.roles, "ADMIN") && !isSubmitter && row.status === "pending",
    // The submitter can resubmit once changes were requested.
    canResubmit: isSubmitter && row.status === "changes_requested",
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
  if (!isReviewer(u)) {
    res.status(403).json({ error: "Only fixers / approvers / admins can vote" });
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

    if (decided === "approved") {
      const diff = (locked.proposed_diff ?? {}) as EditableDiff;
      // applyDiff issues its own non-tx update; OK because we hold the
      // row lock on the pending edit and the characters row is the only
      // other write target.
      await applyDiff(locked.character_id, diff);
      if (locked.update_note) {
        await tx.insert(characterUpdates).values({
          characterId: locked.character_id,
          authorId: locked.submitted_by,
          note: locked.update_note,
        });
      }
    }
    if (decided) {
      await tx
        .update(pendingCharacterEdits)
        .set({
          status: decided,
          decidedAt: new Date(),
          decisionSummary: `${approves} approve / ${rejects} reject (threshold ${threshold} of ${eligibleIds.length})`,
        })
        .where(eq(pendingCharacterEdits.id, id));
      await tx.insert(activityEvents).values({
        kind: decided === "approved" ? "character_edit_approved" : "character_edit_rejected",
        actorId: u.id,
        actorName: u.username,
        actorAvatarUrl: u.avatarUrl,
        message: `Edit on character #${locked.character_id} ${decided} (${approves}/${threshold})`,
      });
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
    const diff = (locked.proposed_diff ?? {}) as EditableDiff;
    await applyDiff(locked.character_id, diff);
    if (locked.update_note) {
      await tx.insert(characterUpdates).values({
        characterId: locked.character_id,
        authorId: locked.submitted_by,
        note: locked.update_note,
      });
    }
    await tx
      .update(pendingCharacterEdits)
      .set({
        status: "approved",
        decidedAt: new Date(),
        overriddenBy: u.id,
        decisionSummary: `Approved via admin override by ${u.username}`,
      })
      .where(eq(pendingCharacterEdits.id, id));
    await tx.insert(activityEvents).values({
      kind: "character_edit_approved",
      actorId: u.id,
      actorName: u.username,
      actorAvatarUrl: u.avatarUrl,
      message: `Edit on character #${locked.character_id} approved via admin override`,
    });
    return { kind: "ok" as const };
  });
  if (result.kind === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (result.kind === "own") { res.status(403).json({ error: "You cannot override your own edit" }); return; }
  if (result.kind === "already_decided") { res.status(409).json({ error: `Edit already ${result.status}` }); return; }
  res.json({ ok: true, status: "approved" });
});

const CommentSchema = z.object({ comment: z.string().trim().min(1).max(2000) });

// POST /pending-edits/:id/request-changes — a reviewer (not the submitter)
// parks the edit in changes_requested with a comment and DMs the submitter.
// The submitter then resubmits to send it back to the queue.
router.post("/pending-edits/:id/request-changes", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  if (!isReviewer(u)) {
    res.status(403).json({ error: "Only fixers / approvers / admins can request changes" });
    return;
  }
  const parsed = CommentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "A comment is required", details: parsed.error.issues });
    return;
  }
  const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.submittedBy === u.id) { res.status(403).json({ error: "You cannot review your own edit" }); return; }
  // Atomic state guard: only flip to changes_requested if the edit is STILL
  // pending. A concurrent vote/override (FOR UPDATE) may have already decided
  // it; an unconditional update would clobber that decision.
  const [changed] = await db
    .update(pendingCharacterEdits)
    .set({ status: "changes_requested", reviewComment: parsed.data.comment, decidedAt: null })
    .where(and(eq(pendingCharacterEdits.id, id), eq(pendingCharacterEdits.status, "pending")))
    .returning();
  if (!changed) { res.status(409).json({ error: "Edit is no longer pending" }); return; }
  const [c] = await db.select().from(characters).where(eq(characters.id, row.characterId));
  await db.insert(activityEvents).values({
    kind: "character_edit_changes_requested",
    actorId: u.id,
    actorName: u.username,
    actorAvatarUrl: u.avatarUrl,
    message: `Changes requested on edit for ${c?.name ?? `character #${row.characterId}`}`,
  });
  // Best-effort DM — the state change is already committed.
  sendDirectMessage(
    row.submittedBy,
    `Changes were requested on your edit for **${c?.name ?? "your character"}**:\n> ${parsed.data.comment}\n\nEdit and resubmit when ready.`,
  ).catch((e) => console.error("[pending-edits] request-changes DM failed", e));
  res.json({ ok: true, status: "changes_requested" });
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

export default router;
