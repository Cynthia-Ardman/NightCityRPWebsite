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
import { hasRole, postToChannel } from "../lib/discord";

const router: IRouter = Router();

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

// A reviewer is anyone with FIXER, CS_APPROVER, or ADMIN. Admins are
// included so the operator team can always unstick a vote. The submitter
// themself is excluded from the eligible-voter pool at vote-tally time
// (you can't approve your own edit).
function isReviewer(u: User): boolean {
  return hasRole(u.roles, "FIXER") || hasRole(u.roles, "CS_APPROVER") || hasRole(u.roles, "ADMIN");
}

// All distinct users currently holding a reviewer role. We compute this
// live on every vote so role grants/revokes take immediate effect on the
// majority threshold. Small set in practice (handful of staff).
async function listEligibleReviewerIds(excludeUserId: string): Promise<string[]> {
  const rows = await db.select({ id: users.id, roles: users.roles }).from(users);
  return rows
    .filter((r) => {
      const fakeUser = { roles: r.roles ?? [] } as User;
      return isReviewer(fakeUser);
    })
    .map((r) => r.id)
    .filter((id) => id !== excludeUserId);
}

// Majority = floor(n / 2) + 1. With n=0 (no other reviewers) we return 1
// so any single qualified vote applies — but in practice the route also
// refuses to accept a vote from someone who isn't a reviewer, so the
// edit can stay pending forever if there are literally no staff besides
// the submitter (acceptable: hire more staff).
function majorityOf(n: number): number {
  return Math.floor(n / 2) + 1;
}

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
  const chars = await db.select().from(characters).where(inArray(characters.id, charIds));
  const subs = await db.select().from(users).where(inArray(users.id, userIds));
  const charById = new Map(chars.map((c) => [c.id, c]));
  const subById = new Map(subs.map((u) => [u.id, u]));
  return rows.map((r) => {
    const c = charById.get(r.characterId);
    const s = subById.get(r.submittedBy);
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
      submittedAt: r.submittedAt,
      decidedAt: r.decidedAt,
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
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    votes,
    eligibleVoterCount: eligibleIds.length,
    threshold,
    approveCount,
    rejectCount,
    myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
    canVote: isStaff && !isSubmitter && row.status === "pending",
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
