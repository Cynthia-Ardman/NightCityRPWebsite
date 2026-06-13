import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, characterSheets, characters, characterStatus, inventoryItems, inventoryEvents, users, activityEvents, catalogCyberware, type User } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { postToChannel, startThreadFromMessage, hasRole, addGuildMemberRole, APPROVED_CHARACTER_ROLE_ID } from "../lib/discord";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";
import { collectCyberware, buildCyberwareCostMap, entryPoints, validateCyberware } from "../lib/cyberware-cap";
import { validateSheetFields } from "../lib/sheet-validation";
import { areCharacterSubmissionsDisabled } from "../lib/characterSubmissions";
import {
  isReviewer,
  listEligibleReviewers,
  majorityOf,
  tallyReviewVotes,
  castReviewVote,
  clearReviewVotes,
  listReviewVotes,
  loadVotesBySubject,
  type ReviewActionResult,
} from "../lib/review";
import type { Request } from "express";

type SheetRow = typeof characterSheets.$inferSelect;
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

const router: IRouter = Router();

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

// NPC is a fixer/admin-only sheet type and is exempt from the new-character
// submission kill switch. Canonicalize so "npc" / " Npc " also match.
function sheetDataIsNpc(data: unknown): boolean {
  const v = (data as Record<string, unknown> | null | undefined)?.sheetType;
  return typeof v === "string" && v.trim().toUpperCase() === "NPC";
}

const SUBMISSIONS_DISABLED_MSG =
  "New character submissions are temporarily disabled by staff.";

router.get("/sheets", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(characterSheets)
    .where(eq(characterSheets.ownerId, req.user!.id))
    .orderBy(desc(characterSheets.createdAt));
  res.json(rows);
});

router.get("/sheets/pending", requireAuth, async (req, res): Promise<void> => {
  // Any reviewer (FIXER / CS_APPROVER / ADMIN) sees the queue, not just CS
  // approvers — sheets now decide by majority vote like edits and requests.
  if (!isReviewer(req.user!)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Reviewers can scope the queue to a lifecycle bucket (active / resolved /
  // archive). With no bucket we keep the legacy default: pending only.
  const bucket = req.query.bucket ? String(req.query.bucket) : null;
  let statusWhere;
  if (bucket === "active") {
    statusWhere = inArray(characterSheets.status, ["pending", "changes_requested"]);
  } else if (bucket === "resolved") {
    statusWhere = inArray(characterSheets.status, ["approved", "rejected", "cancelled"]);
  } else if (bucket === "archive") {
    statusWhere = eq(characterSheets.status, "closed");
  } else {
    statusWhere = eq(characterSheets.status, "pending");
  }
  const rows = await db
    .select({
      id: characterSheets.id,
      name: characterSheets.name,
      status: characterSheets.status,
      createdAt: characterSheets.createdAt,
      ownerId: characterSheets.ownerId,
      ownerName: users.username,
      ownerAvatarUrl: users.avatarUrl,
    })
    .from(characterSheets)
    .leftJoin(users, eq(users.id, characterSheets.ownerId))
    .where(statusWhere)
    .orderBy(desc(characterSheets.createdAt));
  // Attach the vote tally + reviewer roster for each sheet in a fixed number of
  // queries (no N+1). The eligible pool for each sheet excludes that sheet's
  // owner. The roster (eligibleReviewers + per-voter identity) lets the queue
  // card render the same "who has voted" panel as custom requests; it's
  // reviewer-only info and this endpoint is already reviewer-gated above.
  const votesBySheet = await loadVotesBySubject({ subjectType: "sheet", subjectIds: rows.map((r) => r.id) });
  const reviewerPool = await listEligibleReviewers(null);
  const out = rows.map((r) => {
    const eligible = reviewerPool.filter((rv) => rv.id !== r.ownerId);
    const eligibleSet = new Set(eligible.map((rv) => rv.id));
    const allVotes = votesBySheet.get(r.id) ?? [];
    const votes = allVotes.filter((v) => eligibleSet.has(v.voterId));
    const approveCount = votes.filter((v) => v.vote === "approve").length;
    const rejectCount = votes.filter((v) => v.vote === "reject").length;
    const myVote = allVotes.find((v) => v.voterId === req.user!.id) ?? null;
    return {
      ...r,
      approveCount,
      rejectCount,
      threshold: majorityOf(eligible.length),
      myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
      eligibleReviewers: eligible,
      voters: votes.map((v) => ({
        id: v.voterId,
        name: v.voterName,
        avatarUrl: v.voterAvatarUrl,
        vote: v.vote,
      })),
    };
  });
  res.json(out);
});

router.get("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const isOwner = s.ownerId === req.user!.id;
  // Staff who can review/edit a sheet may also view it: CS approvers, admins,
  // and fixers. Kept in lockstep with the PATCH /sheets/:id edit permission.
  const isStaff =
    hasRole(req.user!.roles, "CS_APPROVER") ||
    hasRole(req.user!.roles, "ADMIN") ||
    hasRole(req.user!.roles, "FIXER");
  if (!isOwner && !isStaff) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const viewerIsReviewer = isReviewer(req.user!);
  const votes = await listReviewVotes({ subjectType: "sheet", subjectId: id });
  const eligibleReviewers = await listEligibleReviewers(s.ownerId);
  const eligibleIds = eligibleReviewers.map((r) => r.id);
  const approveCount = votes.filter((v) => v.vote === "approve").length;
  const rejectCount = votes.filter((v) => v.vote === "reject").length;
  const myVote = votes.find((v) => v.voterId === req.user!.id) ?? null;
  res.json({
    ...s,
    votes,
    // Reviewer-only: the full eligible-reviewer roster (incl. who hasn't voted)
    // is staff info — don't expose it to the sheet owner viewing their own sheet.
    eligibleReviewers: viewerIsReviewer ? eligibleReviewers : undefined,
    eligibleVoterCount: eligibleIds.length,
    threshold: majorityOf(eligibleIds.length),
    approveCount,
    rejectCount,
    myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
    // A reviewer who is not the owner can vote / request changes on a pending sheet.
    canVote: viewerIsReviewer && !isOwner && s.status === "pending",
    canRequestChanges: viewerIsReviewer && !isOwner && s.status === "pending",
    // Admins can override a pending sheet straight to approved.
    canOverride: hasRole(req.user!.roles, "ADMIN") && !isOwner && s.status === "pending",
    // The owner can resubmit a changes_requested (or draft) sheet.
    canResubmit: isOwner && (s.status === "changes_requested" || s.status === "draft"),
  });
});

// Loads the catalog cyberware CWP cost map from the database. The catalog is the
// single source of truth for an install's cost: the client never types CWP, it's
// set from the catalog. The pure map-building (incl. "highest CWP wins" on
// duplicate names) lives in ../lib/cyberware so it can be unit-tested.
async function loadCyberwareCostMap(): Promise<Map<string, number>> {
  const rows = await db
    .select({ name: catalogCyberware.name, cwp: catalogCyberware.cwp })
    .from(catalogCyberware);
  return buildCyberwareCostMap(rows);
}

// Runs full submission validation. Returns null on success, error message on failure.
// `user` is used to gate NPC sheets to fixers/admins only.
async function validateSheetForSubmission(data: unknown, user: User): Promise<string | null> {
  // Non-cyberware rules (required fields, PC/NPC gating, age, skills, gear) live
  // in ../lib/sheet-validation so they can be unit-tested without a database.
  const fieldErr = validateSheetFields(data, user.roles);
  if (fieldErr) return fieldErr;
  const d = data as Record<string, unknown>;
  // NPCs are story chrome (gangs, ripperdoc rigs, set-piece characters) and are
  // not balance-constrained, so the 6-CWP creation cap does not apply to them.
  if (d.sheetType === "NPC") return null;
  // Cyberware is optional. If present, total CWP is capped at 6 at creation.
  // For catalog installs the cost is taken from the catalog (the client-sent
  // value is ignored), so the cap can't be bypassed by a crafted payload.
  // Custom (non-catalog) entries keep their client value; reject negatives so
  // they can't offset over-cap entries.
  const entries = collectCyberware(d);
  const costMap = await loadCyberwareCostMap();
  return validateCyberware(entries, costMap);
}

async function computePoints(data: unknown): Promise<number> {
  const d = (data ?? {}) as Record<string, unknown>;
  const costMap = await loadCyberwareCostMap();
  return collectCyberware(d).reduce((s, c) => s + entryPoints(c, costMap), 0);
}

async function announceSubmission(sheetId: number, name: string, data: any, user: User): Promise<void> {
  if (!CS_CHANNEL_ID) return;
  const sheetType = (data as { sheetType: string }).sheetType;
  const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "");
  const reviewUrl = portalBase ? `https://${portalBase}/sheets/${sheetId}` : `/sheets/${sheetId}`;
  const points = await computePoints(data);
  const msgId = await postToChannel(CS_CHANNEL_ID, `New ${sheetType} sheet pending review: **${name}** by ${user.username}`, [
    {
      title: name,
      description: data.background?.slice(0, 500) ?? "",
      fields: [
        { name: "Type", value: sheetType, inline: true },
        { name: "Player", value: user.username, inline: true },
        { name: "Archetype", value: data.archetype ?? "—", inline: true },
        { name: "Pronouns", value: data.pronouns ?? "—", inline: true },
        { name: "Occupation", value: data.occupation ?? "—", inline: true },
        { name: "Cyberware Pts", value: `${points}/6`, inline: true },
        { name: "Review", value: reviewUrl, inline: false },
      ],
    },
  ]);
  if (msgId) {
    // Turn the summary post into a thread so reviewers can discuss in-channel;
    // the portal mirrors that thread read-only. Thread id == the OP message id.
    // Only persist discordThreadId when a thread genuinely exists — on a hard
    // failure (null) leave it unset so the panel shows "not linked" and a later
    // backfill can thread from the stored message id.
    const threadId = await startThreadFromMessage(CS_CHANNEL_ID, msgId, `Sheet: ${name}`);
    await db
      .update(characterSheets)
      .set({ discordMessageId: msgId, ...(threadId ? { discordThreadId: threadId } : {}) })
      .where(eq(characterSheets.id, sheetId));
  }
  await db.insert(activityEvents).values({
    kind: "sheet_submitted",
    actorId: user.id,
    actorName: user.username,
    actorAvatarUrl: user.avatarUrl,
    message: `${user.username} submitted sheet for ${name}`,
  });
}

router.post("/sheets", requireAuth, async (req, res): Promise<void> => {
  const { name, data, characterId, status } = req.body ?? {};
  if (!name || !data || typeof data !== "object") {
    res.status(400).json({ error: "name and data required" });
    return;
  }
  const wantsDraft = status === "draft";
  if (!wantsDraft) {
    if (!sheetDataIsNpc(data) && (await areCharacterSubmissionsDisabled())) {
      res.status(403).json({ error: SUBMISSIONS_DISABLED_MSG });
      return;
    }
    const err = await validateSheetForSubmission(data, req.user!);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }
  const [s] = await db
    .insert(characterSheets)
    .values({
      ownerId: req.user!.id,
      characterId: characterId ?? null,
      name,
      data,
      status: wantsDraft ? "draft" : "pending",
    })
    .returning();

  if (!wantsDraft) {
    await announceSubmission(s.id, name, data, req.user!);
  }
  await recordAudit({
    req,
    category: "sheet",
    action: wantsDraft ? "draft" : "submit",
    targetType: "sheet",
    targetId: s.id,
    message: `${req.user!.username} ${wantsDraft ? "drafted" : "submitted"} sheet "${name}"`,
    after: { name, characterId: s.characterId },
  });
  res.status(201).json(s);
});

// Owner can edit any sheet that is still editable (draft or changes_requested).
router.patch("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const isOwner = existing.ownerId === req.user!.id;
  const isStaff =
    hasRole(req.user!.roles, "CS_APPROVER") ||
    hasRole(req.user!.roles, "ADMIN") ||
    hasRole(req.user!.roles, "FIXER");
  if (!isOwner && !isStaff) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Owners can edit their own draft / changes-requested / in-review sheets.
  // Staff (reviewers) can edit a sheet while it is in review (pending) so they
  // can adjust any part of the ticket before approving it. Status is left
  // unchanged — editing in review does not require a re-submit.
  const allowed = isOwner ? ["draft", "changes_requested", "pending"] : ["pending"];
  if (!allowed.includes(existing.status)) {
    res.status(409).json({ error: "Sheet is locked (already approved/rejected)" });
    return;
  }
  const { name, data, characterId } = req.body ?? {};
  // NPC is a fixer/admin-gated sheet type and is exempt from the 6-CWP creation
  // cap. The cap-skip must therefore key off the *persisted* sheet type, NOT the
  // incoming payload — otherwise a non-fixer owner could PATCH a pending PC sheet
  // with `sheetType: "NPC"` and slip past both the cap and the NPC role gate
  // (pending edits skip full submission validation). Canonicalize the type
  // (materialization compares case-insensitively, so "npc"/" Npc " must be caught
  // too) and reject any unauthorized attempt to flip a non-NPC sheet to NPC.
  const canonType = (v: unknown): "PC" | "NPC" | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim().toUpperCase();
    return t === "NPC" ? "NPC" : t === "PC" ? "PC" : undefined;
  };
  const persistedType = canonType(((existing.data ?? {}) as Record<string, unknown>).sheetType);
  const incomingType =
    data && typeof data === "object" ? canonType((data as Record<string, unknown>).sheetType) : undefined;
  // CS_APPROVER is a reviewer, not a creator — only fixers/admins may designate
  // a sheet as NPC.
  const canSetNpc = hasRole(req.user!.roles, "FIXER") || hasRole(req.user!.roles, "ADMIN");
  if (incomingType === "NPC" && persistedType !== "NPC" && !canSetNpc) {
    res.status(403).json({ error: "Only fixers can set a sheet to NPC" });
    return;
  }
  // Effective type for the cap decision: a non-fixer can never make it NPC.
  const effectiveType = incomingType === "NPC" ? (canSetNpc ? "NPC" : persistedType) : incomingType ?? persistedType;
  // A sheet in review can be edited in place (no re-submit), so the full
  // submission validation is skipped to allow incremental tweaks. The 6-CWP
  // cap is a hard rule though, so enforce the cyberware cap (and reject
  // negatives) whenever a pending PC sheet's data is updated — otherwise it could
  // be pushed over-cap after submission and approved without re-validation.
  if (
    existing.status === "pending" &&
    data &&
    typeof data === "object" &&
    effectiveType !== "NPC"
  ) {
    const entries = collectCyberware(data as Record<string, unknown>);
    const costMap = await loadCyberwareCostMap();
    const cwErr = validateCyberware(entries, costMap);
    if (cwErr) {
      res.status(400).json({ error: cwErr });
      return;
    }
  }
  const [updated] = await db
    .update(characterSheets)
    .set({
      ...(typeof name === "string" && name.length ? { name } : {}),
      ...(data && typeof data === "object" ? { data } : {}),
      ...(characterId !== undefined ? { characterId } : {}),
    })
    .where(eq(characterSheets.id, id))
    .returning();
  res.json(updated);
});

// Promote a draft (or a changes-requested sheet) to "pending" review.
router.post("/sheets/:id/submit", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (existing.status !== "draft" && existing.status !== "changes_requested") {
    res.status(409).json({ error: "Sheet is not in a submittable state" });
    return;
  }
  if (!sheetDataIsNpc(existing.data) && (await areCharacterSubmissionsDisabled())) {
    res.status(403).json({ error: SUBMISSIONS_DISABLED_MSG });
    return;
  }
  const err = await validateSheetForSubmission(existing.data, req.user!);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const [updated] = await db.transaction(async (tx) => {
    // Atomic: only (re)submit if the sheet is STILL in a submittable state. A
    // concurrent override could have approved+materialized a changes_requested
    // sheet; flipping it back to pending here would let a later vote
    // materialize the character a second time.
    const rows = await tx
      .update(characterSheets)
      .set({ status: "pending", decisionBy: null, decisionNote: null, decidedAt: null, overriddenBy: null })
      .where(and(eq(characterSheets.id, id), inArray(characterSheets.status, ["draft", "changes_requested"])))
      .returning();
    if (rows.length === 0) return rows;
    // Clear any prior-round votes so resubmission starts the tally fresh.
    await clearReviewVotes({ subjectType: "sheet", subjectId: id, conn: tx });
    return rows;
  });
  if (!updated) { res.status(409).json({ error: "Sheet is not in a submittable state" }); return; }
  await announceSubmission(updated.id, updated.name, updated.data, req.user!);
  res.json(updated);
});

// Owner can delete their own drafts.
router.delete("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (existing.status !== "draft") {
    res.status(409).json({ error: "Only drafts can be deleted" });
    return;
  }
  await db.delete(characterSheets).where(eq(characterSheets.id, id));
  res.status(204).end();
});

// Maps a sheet's free-form `data` payload onto the `characters` column shape.
function characterFieldsFromSheet(sheet: SheetRow) {
  const data = (sheet.data ?? {}) as Record<string, unknown>;
  const kind = String(data.sheetType ?? "pc").toLowerCase() === "npc" ? "npc" : "pc";
  const portraitUrls = Array.isArray(data.portraitUrls)
    ? data.portraitUrls.map(String).filter((u) => u.trim().length > 0)
    : [];
  const statsImageUrls = Array.isArray(data.statsImageUrls)
    ? data.statsImageUrls.map(String).filter((u) => u.trim().length > 0)
    : [];
  const profileUrl = typeof data.profileUrl === "string" ? data.profileUrl : null;
  const portraitUrl = portraitUrls[0] ?? profileUrl ?? null;
  const archetype = typeof data.archetype === "string" && data.archetype.trim() ? data.archetype : null;
  const background = typeof data.background === "string" && data.background.trim() ? data.background : null;
  return {
    name: sheet.name,
    kind,
    archetype,
    background,
    portraitUrl,
    portraitUrls,
    statsImageUrls,
    sheetData: data as never,
  };
}

// Materialize (or refresh) the actual `characters` row a sheet represents.
// Approving a sheet only ever flipped its status before, so an approved
// character never appeared anywhere — not in "awaiting approval" (status is no
// longer pending) nor in the owner's character list (no characters row ever
// existed). On approval we create the character from the sheet payload (or, for
// a resubmitted edit that already legitimately links one, refresh + re-approve
// it) and link it back via characterSheets.characterId.
//
// Runs inside the caller's transaction (the sheet row is already locked) so the
// insert + relink are atomic — concurrent approvals can't spawn duplicate
// characters. The linked-character path is only taken when the target row still
// exists AND is owned by the sheet owner; `characterId` originates from
// user-supplied sheet input, so a stale or foreign id is never blindly
// overwritten — we fall through and create a fresh, correctly-owned character
// instead (which also repairs the old "approved but invisible" state when the
// previously-linked row was deleted).
// Seed the new character's inventory from the sheet payload. The sheet stores
// the player's chosen chrome (`data.cyberware`) and equipment (`data.gear`),
// but before this they only lived in the sheet blob — approving never created
// the matching `inventory_items`, so an approved character showed up with an
// empty inventory and no derived cyberware band. Cyberware notes embed a
// "CWP <n>" token (parsed by lib/cyberware.ts) and a trailing "slot: <x>" so
// the band derivation and the per-slot grouping in CharacterDetail both work.
// Only ever called on the fresh-insert path so re-approval of a resubmitted
// edit can't duplicate items or clobber inventory the player has since changed.
async function seedInventoryFromSheet(
  tx: Executor,
  characterId: number,
  ownerId: string | null,
  rawData: unknown,
): Promise<void> {
  const data = (rawData ?? {}) as Record<string, unknown>;
  const rows: Array<{ name: string; category: string; notes: string | null; equipped: boolean }> = [];

  if (Array.isArray(data.cyberware)) {
    for (const raw of data.cyberware) {
      const cw = (raw ?? {}) as Record<string, unknown>;
      const name = String(cw.name ?? "").trim() || String(cw.slot ?? "").trim();
      if (!name) continue;
      const points = Number(cw.points) || 0;
      const slot = String(cw.slot ?? "").trim();
      const userNotes = String(cw.notes ?? "").trim();
      const parts = [`CWP ${points}`];
      if (userNotes) parts.push(userNotes);
      // Keep "slot: <x>" LAST — CharacterDetail's slot regex captures up to the
      // next comma/semicolon/newline, and our separator is " · ", so anything
      // after slot would be swallowed into the slot value.
      if (slot) parts.push(`slot: ${slot}`);
      rows.push({ name, category: "cyberware", notes: parts.join(" · "), equipped: true });
    }
  }

  if (Array.isArray(data.gear)) {
    for (const raw of data.gear) {
      const name = String(raw ?? "").trim();
      if (!name) continue;
      rows.push({ name, category: "gear", notes: null, equipped: false });
    }
  }

  // Firearms picked at creation (catalog name or free-text). Seeded as their own
  // "gun" category so they group separately from generic gear in inventory.
  if (Array.isArray(data.guns)) {
    for (const raw of data.guns) {
      const name = String(raw ?? "").trim();
      if (!name) continue;
      rows.push({ name, category: "gun", notes: null, equipped: false });
    }
  }

  if (rows.length === 0) return;

  const inserted = await tx
    .insert(inventoryItems)
    .values(
      rows.map((r) => ({
        characterId,
        ownerId,
        name: r.name,
        category: r.category,
        quantity: 1,
        notes: r.notes,
        equipped: r.equipped,
      })),
    )
    .returning({ instanceUuid: inventoryItems.instanceUuid, name: inventoryItems.name });

  await tx.insert(inventoryEvents).values(
    inserted.map((it) => ({
      instanceUuid: it.instanceUuid,
      kind: "created" as const,
      toCharacterId: characterId,
      itemName: it.name,
      quantity: 1,
      reason: "Seeded from approved character sheet",
    })),
  );
}

async function materializeCharacterFromSheet(tx: Executor, sheet: SheetRow): Promise<number> {
  const fields = characterFieldsFromSheet(sheet);

  if (sheet.characterId) {
    const [linked] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, sheet.characterId))
      .for("update");
    if (linked && linked.ownerId === sheet.ownerId) {
      await tx
        .update(characters)
        .set({ ...fields, approved: true, lifeStatus: "active" })
        .where(eq(characters.id, sheet.characterId));
      return sheet.characterId;
    }
  }

  const [c] = await tx
    .insert(characters)
    .values({
      ownerId: sheet.ownerId,
      ...fields,
      approved: true,
      claimed: true,
      lifeStatus: "active",
    })
    .returning();
  await tx.insert(characterStatus).values({ characterId: c.id });
  await seedInventoryFromSheet(tx, c.id, sheet.ownerId, sheet.data);
  return c.id;
}

// POST /sheets/:id/vote — a reviewer (not the owner) casts an approve/reject
// vote. When the running tally reaches the majority threshold the sheet is
// decided in the same locked transaction: an approve materializes the
// character, a reject closes the sheet. Mirrors the edit-vote pipeline.
router.post("/sheets/:id/vote", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  if (!isReviewer(u)) {
    res.status(403).json({ error: "Only fixers / approvers / admins can vote" });
    return;
  }
  const { vote, note } = req.body ?? {};
  if (vote !== "approve" && vote !== "reject") {
    res.status(400).json({ error: "vote must be 'approve' or 'reject'" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(characterSheets).where(eq(characterSheets.id, id)).for("update");
    if (!sheet) return { error: { status: 404, body: { error: "Not found" } } };
    if (sheet.status !== "pending") {
      return { error: { status: 409, body: { error: `Sheet already ${sheet.status}` } } };
    }
    if (sheet.ownerId === u.id) {
      return { error: { status: 403, body: { error: "You cannot review a character sheet you submitted." } } };
    }
    await castReviewVote({ subjectType: "sheet", subjectId: id, voterId: u.id, vote, note: note ?? null, conn: tx });
    const tally = await tallyReviewVotes({ subjectType: "sheet", subjectId: id, submitterId: sheet.ownerId, conn: tx });
    if (!tally.decided) {
      return { ok: { decided: null as "approved" | "rejected" | null, sheet, tally } };
    }

    // Effects DEFERRED: a majority approve STAGES the decision only; the
    // character is materialized when a fixer closes the ticket. We do NOT set
    // characterId here — close materializes and links it.
    const summary = `${tally.approveCount} approve / ${tally.rejectCount} reject (threshold ${tally.threshold})`;
    const [updated] = await tx
      .update(characterSheets)
      .set({ status: tally.decided, decisionBy: u.id, decisionNote: summary, decidedAt: new Date() })
      .where(eq(characterSheets.id, id))
      .returning();
    return { ok: { decided: tally.decided, sheet: updated, tally } };
  });
  if (result.error) {
    res.status(result.error.status).json(result.error.body);
    return;
  }
  const { decided, sheet, tally } = result.ok;
  await recordAudit({
    req,
    category: "sheet",
    action: decided ? `vote_decided_${decided}` : "vote",
    targetType: "sheet",
    targetId: id,
    message: `${u.username} voted ${vote} on sheet "${sheet.name}"${decided ? ` → ${decided}` : ""}`,
    after: { vote, decided, approveCount: tally.approveCount, rejectCount: tally.rejectCount },
  });
  res.json({ status: sheet.status, decided, approveCount: tally.approveCount, rejectCount: tally.rejectCount, threshold: tally.threshold });
});

// POST /sheets/:id/override — admin-only immediate approval, bypassing the
// vote. Records who overrode (overriddenBy).
router.post("/sheets/:id/override", requireAuth, async (req, res): Promise<void> => {
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
    const [sheet] = await tx.select().from(characterSheets).where(eq(characterSheets.id, id)).for("update");
    if (!sheet) return { error: { status: 404, body: { error: "Not found" } } };
    if (sheet.status !== "pending" && sheet.status !== "changes_requested") {
      return { error: { status: 409, body: { error: `Sheet already ${sheet.status}` } } };
    }
    if (sheet.ownerId === u.id) {
      return { error: { status: 403, body: { error: "You cannot override your own sheet" } } };
    }
    // Effects deferred: stage the decision; an approved sheet materializes the
    // character on close, a denied one is simply archived on close.
    const [updated] = await tx
      .update(characterSheets)
      .set({
        status: newStatus,
        decisionBy: u.id,
        overriddenBy: u.id,
        decisionNote: `${deny ? "Denied" : "Approved"} via admin override by ${u.username}`,
        decidedAt: new Date(),
      })
      .where(eq(characterSheets.id, id))
      .returning();
    return { ok: { updated } };
  });
  if (result.error) {
    res.status(result.error.status).json(result.error.body);
    return;
  }
  await recordAudit({
    req,
    category: "sheet",
    action: deny ? "override_rejected" : "override_approved",
    targetType: "sheet",
    targetId: id,
    message: `${u.username} ${deny ? "denied" : "approved"} sheet "${result.ok.updated.name}" via admin override (pending close)`,
    after: { overriddenBy: u.id, staged: true, decision: deny ? "deny" : "approve" },
  });
  res.json(result.ok.updated);
});

// Close a RESOLVED character sheet (approved | rejected | cancelled) → archived.
// Closing an APPROVED sheet materializes the character exactly once (an approved
// sheet under the deferred lifecycle has not been materialized yet; closing it
// is terminal so it can't re-run); closing a rejected/cancelled sheet just
// archives it. Idempotent: re-closing an already-closed sheet is a 200 no-op.
// Materialize runs inside the locked txn so apply + status flip are atomic.
// Caller has already verified the actor is a reviewer.
export async function closeSheet(req: Request, id: number): Promise<ReviewActionResult> {
  const u = req.user!;
  const result = await db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(characterSheets).where(eq(characterSheets.id, id)).for("update");
    if (!sheet) return { kind: "error" as const, status: 404, body: { error: "Not found" } };
    if (sheet.status === "closed") return { kind: "noop" as const };
    if (sheet.status !== "approved" && sheet.status !== "rejected" && sheet.status !== "cancelled") {
      return { kind: "error" as const, status: 409, body: { error: `Only a resolved sheet can be closed (this one is ${sheet.status})` } };
    }
    if (sheet.status === "approved") {
      const characterId = await materializeCharacterFromSheet(tx, sheet);
      const [updated] = await tx
        .update(characterSheets)
        .set({ status: "closed", closedAt: new Date(), closedBy: u.id, characterId })
        .where(eq(characterSheets.id, id))
        .returning();
      return { kind: "applied" as const, sheet: updated };
    }
    const [updated] = await tx
      .update(characterSheets)
      .set({ status: "closed", closedAt: new Date(), closedBy: u.id })
      .where(eq(characterSheets.id, id))
      .returning();
    return { kind: "archived" as const, sheet: updated };
  });
  if (result.kind === "error") return { status: result.status, body: result.body };
  if (result.kind === "applied") {
    await db.insert(activityEvents).values({
      kind: "character_approved",
      actorId: u.id,
      actorName: u.username,
      actorAvatarUrl: u.avatarUrl,
      message: `${u.username} approved ${result.sheet.name}`,
    });
    await recordAudit({
      req,
      category: "sheet",
      action: "sheet_closed_applied",
      targetType: "sheet",
      targetId: id,
      message: `Closed & materialized sheet "${result.sheet.name}"`,
    });
    // Grant the "Approved Character" Discord role to the submitter. The portal
    // user id IS the Discord snowflake. Fire-and-forget + gated/idempotent in
    // addGuildMemberRole, so a failure here must not fail the approval.
    if (result.sheet.ownerId) {
      void addGuildMemberRole(
        result.sheet.ownerId,
        APPROVED_CHARACTER_ROLE_ID,
        `Character sheet "${result.sheet.name}" approved`,
      ).then((r) => {
        if (!r.ok) {
          logger.warn(
            { sheetId: id, ownerId: result.sheet.ownerId, error: r.error },
            "Approved-character role grant did not apply",
          );
        }
      });
    }
  } else if (result.kind === "archived") {
    await recordAudit({
      req,
      category: "sheet",
      action: "sheet_closed",
      targetType: "sheet",
      targetId: id,
      message: `Closed sheet "${result.sheet.name}" (${result.sheet.status})`,
    });
  }
  const [row] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  return { status: 200, body: row };
}

// Reopen a RESOLVED-but-not-archived character sheet (approved | rejected) back
// to pending for another review round. Votes are cleared and the decision fields
// are wiped. Because effects are deferred, an approved-not-closed sheet has not
// been materialized yet, so reopening it is safe. We leave characterId untouched
// — it is the submitter's chosen link, not a side effect. cancelled and closed
// sheets cannot be reopened.
export async function reopenSheet(req: Request, id: number): Promise<ReviewActionResult> {
  const u = req.user!;
  const result = await db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(characterSheets).where(eq(characterSheets.id, id)).for("update");
    if (!sheet) return { error: { status: 404, body: { error: "Not found" } } };
    if (sheet.status !== "approved" && sheet.status !== "rejected") {
      return { error: { status: 409, body: { error: `Only an approved or rejected sheet can be reopened (this one is ${sheet.status})` } } };
    }
    const [updated] = await tx
      .update(characterSheets)
      .set({ status: "pending", decisionBy: null, decisionNote: null, decidedAt: null, overriddenBy: null })
      .where(eq(characterSheets.id, id))
      .returning();
    await clearReviewVotes({ subjectType: "sheet", subjectId: id, conn: tx });
    return { ok: { updated } };
  });
  if ("error" in result && result.error) return result.error;
  await recordAudit({
    req,
    category: "sheet",
    action: "sheet_reopened",
    targetType: "sheet",
    targetId: id,
    message: `Reopened sheet "${result.ok.updated.name}"`,
  });
  const [row] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  return { status: 200, body: row };
}

// POST /sheets/:id/request-changes — RETIRED. Reviewers no longer park sheets
// in a blocking `changes_requested` state; the /review comment thread is
// non-blocking communication and never gates approval. Legacy rows already in
// `changes_requested` still resubmit via /sheets/:id/submit. Endpoint kept
// registered so stale clients get a clear 410 rather than a 404.
router.post("/sheets/:id/request-changes", requireAuth, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Request-changes is retired. Use the comment thread; it never blocks approval." });
});

export default router;
