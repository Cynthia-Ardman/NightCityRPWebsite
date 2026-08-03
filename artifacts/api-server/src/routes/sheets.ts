import { Router, type IRouter } from "express";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db, characterSheets, characters, characterStatus, inventoryItems, inventoryEvents, users, activityEvents, catalogCyberware, catalogGuns, type User } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, APPROVED_CHARACTER_ROLE_ID, RIPPERDOC_ROLE_ID } from "../lib/discord";
import { grantRoleDurable } from "../lib/roleGrants";
import { announceWithThread } from "../lib/reviewAnnounce";
import { portalLink } from "../lib/portalUrl";
import { normalizeName, looseNameKey } from "../lib/strings";
import { createNotification } from "../lib/notifications";
import { recordAudit } from "../lib/audit";
import { collectCyberware, buildCyberwareCostMap, entryPoints, validateCyberware } from "../lib/cyberware-cap";
import { validateSheetFields, findTechStartingGun } from "../lib/sheet-validation";
import { areCharacterSubmissionsDisabled } from "../lib/characterSubmissions";
import { householdEffectiveCheckupDate } from "../lib/jobs";
import { resolveRegistryTags } from "../lib/characterTags";
import { batchSlotClashError, loadCyberwareSlotByName } from "../lib/cyberwareSlots";
import {
  isReviewer,
  isEligibleReviewer,
  listEligibleReviewers,
  majorityOf,
  countVotes,
  tallyReviewVotes,
  castReviewVote,
  clearReviewVotes,
  listReviewVotes,
  loadVotesBySubject,
  loadLastActivityBySubject,
  latestVoterIdFor,
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

// True when the submitter ticked the "Ripper Doc" box on the sheet. Drives the
// RipperDoc Discord-role grant at approval/close (see closeSheet).
function sheetWantsRipperdoc(data: unknown): boolean {
  return (data as Record<string, unknown> | null | undefined)?.ripperDoc === true;
}

const SUBMISSIONS_DISABLED_MSG =
  "New character submissions are temporarily disabled by staff.";

// Re-evaluate one still-`pending` sheet against the LIVE eligible-reviewer
// majority and, if it now resolves, apply the same staged transition the vote
// handler makes. Self-heals sheets stranded `pending` after the eligible pool
// shrank (a reviewer's role was revoked or they left) below the already-cast
// tally — the decision is otherwise only evaluated at vote-cast time, so the
// sheet never surfaces its Close & Apply action. Locked + status-guarded, so it
// is idempotent and races safely with a real vote or admin override. Effects
// stay DEFERRED to close (no character is materialized here). Returns the
// decided status, or null if it stayed pending. Reviewer-gated by the caller.
async function finalizeDecidedSheet(req: Request, id: number): Promise<"approved" | "rejected" | null> {
  const result = await db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(characterSheets).where(eq(characterSheets.id, id)).for("update");
    if (!sheet || sheet.status !== "pending") return null;
    const tally = await tallyReviewVotes({ subjectType: "sheet", subjectId: id, submitterId: sheet.ownerId, conn: tx });
    if (!tally.decided) return null;
    // Attribute to the most recent matching voter (the closest thing to a
    // deciding reviewer), not to whoever's queue load triggered this.
    const deciderId =
      (await latestVoterIdFor({
        subjectType: "sheet",
        subjectId: id,
        vote: tally.decided === "approved" ? "approve" : "reject",
        conn: tx,
      })) ?? req.user!.id;
    const summary = `${tally.approveCount} approve / ${tally.rejectCount} reject (threshold ${tally.threshold})`;
    const [updated] = await tx
      .update(characterSheets)
      .set({ status: tally.decided, decisionBy: deciderId, decisionNote: summary, decidedAt: new Date() })
      .where(eq(characterSheets.id, id))
      .returning();
    return { decided: tally.decided, sheet: updated, tally };
  });
  if (!result) return null;
  await recordAudit({
    req,
    category: "sheet",
    action: `sheet_auto_finalize_${result.decided}`,
    targetType: "sheet",
    targetId: id,
    message: `Auto-finalized sheet "${result.sheet.name}" → ${result.decided} (majority reached after reviewer-pool change)`,
    after: { decided: result.decided, approveCount: result.tally.approveCount, rejectCount: result.tally.rejectCount, autoFinalized: true },
  });
  return result.decided;
}

// Discord snowflakes embed their creation time in the high bits. A sheet's
// announce post (discordMessageId) is created at submission time, so for
// historical rows that predate the submittedAt column we can recover the real
// submission moment from it. Returns null for a missing / malformed id.
const DISCORD_EPOCH = 1420070400000;
function snowflakeToDate(id: string | null | undefined): Date | null {
  if (!id || !/^\d+$/.test(id)) return null;
  try {
    const ms = Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
    return Number.isFinite(ms) && ms >= DISCORD_EPOCH ? new Date(ms) : null;
  } catch {
    return null;
  }
}

// The date a sheet was actually submitted for review, with fallbacks for rows
// created before the submittedAt column existed: explicit column -> Discord
// announce snowflake -> createdAt (draft creation, last resort).
function effectiveSubmittedAt(row: { submittedAt: Date | null; discordMessageId: string | null; createdAt: Date }): string {
  return (row.submittedAt ?? snowflakeToDate(row.discordMessageId) ?? row.createdAt).toISOString();
}

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
      submittedAt: characterSheets.submittedAt,
      discordMessageId: characterSheets.discordMessageId,
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
  const activityBySheet = await loadLastActivityBySubject(
    "sheet",
    rows.map((r) => ({ id: r.id, baseAt: r.createdAt })),
  );
  const reviewerPool = await listEligibleReviewers(null);
  const out = rows.map((r) => {
    const eligible = reviewerPool.filter((rv) => rv.id !== r.ownerId);
    const eligibleSet = new Set(eligible.map((rv) => rv.id));
    const allVotes = votesBySheet.get(r.id) ?? [];
    const votes = allVotes.filter((v) => eligibleSet.has(v.voterId));
    const approveCount = votes.filter((v) => v.vote === "approve").length;
    const rejectCount = votes.filter((v) => v.vote === "reject").length;
    const pauseCount = votes.filter((v) => v.vote === "pause").length;
    const myVote = allVotes.find((v) => v.voterId === req.user!.id) ?? null;
    const { discordMessageId: _dm, submittedAt: _rawSubmittedAt, ...rest } = r;
    return {
      ...rest,
      submittedAt: effectiveSubmittedAt(r),
      lastActivityAt: (activityBySheet.get(r.id) ?? r.createdAt).toISOString(),
      approveCount,
      rejectCount,
      pauseCount,
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
  // Self-heal any sheet whose tally already passes the (possibly shrunk)
  // majority but was left pending — see finalizeDecidedSheet.
  for (const entry of out) {
    if (entry.status !== "pending") continue;
    if (entry.approveCount < entry.threshold && entry.rejectCount < entry.threshold) continue;
    const decided = await finalizeDecidedSheet(req, entry.id);
    if (decided) entry.status = decided;
  }
  res.json(out);
});

router.get("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  let [s] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
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
  // Self-heal a sheet whose tally already passes the (possibly shrunk) majority
  // but was left pending, then re-read it so the response reflects the decision.
  if (viewerIsReviewer && s.status === "pending") {
    const decided = await finalizeDecidedSheet(req, id);
    if (decided) [s] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  }
  // Only cs-approvers cast counted votes. Fixers retain staff view access but
  // can't vote; admins review via OVERRIDE, not the vote/request-changes flow.
  const viewerCanVote = isEligibleReviewer(req.user!);
  const votes = await listReviewVotes({ subjectType: "sheet", subjectId: id });
  const eligibleReviewers = await listEligibleReviewers(s.ownerId);
  const eligibleIds = eligibleReviewers.map((r) => r.id);
  const eligibleSet = new Set(eligibleIds);
  // Count only eligible-pool votes so an ineligible (e.g. admin-only) vote can't
  // skew the displayed tally — mirrors the decision math in tallyReviewVotes.
  const effectiveVotes = votes.filter((v) => eligibleSet.has(v.voterId));
  const { approveCount, rejectCount, pauseCount } = countVotes(effectiveVotes);
  const myVote = votes.find((v) => v.voterId === req.user!.id) ?? null;
  res.json({
    ...s,
    submittedAt: effectiveSubmittedAt(s),
    votes,
    // Reviewer-only: the full eligible-reviewer roster (incl. who hasn't voted)
    // is staff info — don't expose it to the sheet owner viewing their own sheet.
    eligibleReviewers: viewerIsReviewer ? eligibleReviewers : undefined,
    eligibleVoterCount: eligibleIds.length,
    threshold: majorityOf(eligibleIds.length),
    approveCount,
    rejectCount,
    pauseCount,
    myVote: myVote ? { vote: myVote.vote, note: myVote.note, votedAt: myVote.votedAt } : null,
    // A fixer / cs-approver who is not the owner can vote / request changes on a
    // pending sheet. Admins are excluded here (they use override).
    canVote: viewerCanVote && !isOwner && s.status === "pending",
    canRequestChanges: viewerCanVote && !isOwner && s.status === "pending",
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

// Mechanical attributes a reviewer supplies at CLOSE & APPLY for CUSTOM
// (non-catalog) sheet items, indexed into the sheet's `cyberware` / `guns`
// arrays. Catalog items are auto-resolved from the catalog and never prompted.
export type SheetCyberwareCloseParam = { index: number; cwp: number; slot: string };
export type SheetGunCloseParam = {
  index: number;
  category: string;
  weaponType: string;
  fireMode: string;
  powerLevel: string;
  manufacturer?: string;
};
export type SheetCloseParams = {
  sheetCyberware?: SheetCyberwareCloseParam[];
  sheetGuns?: SheetGunCloseParam[];
};

type GunAttrs = {
  category: string | null;
  weaponType: string | null;
  fireMode: string | null;
  powerLevel: string | null;
  manufacturer: string | null;
};

// Name-keyed (lower-cased) catalog cyberware map for close-time auto-resolution.
// Mirrors the cap's "highest CWP wins on duplicate name" rule so the seeded CWP
// matches what creation validation enforced against, and carries the catalog's
// authoritative slot.
async function loadCyberwareCatalogMap(): Promise<Map<string, { cwp: number; slot: string }>> {
  const rows = await db
    .select({ name: catalogCyberware.name, cwp: catalogCyberware.cwp, slot: catalogCyberware.slot })
    .from(catalogCyberware);
  const map = new Map<string, { cwp: number; slot: string }>();
  for (const r of rows) {
    const key = normalizeName(String(r.name ?? ""));
    if (!key) continue;
    const cost = Number(r.cwp) || 0;
    const prev = map.get(key);
    if (prev === undefined || cost > prev.cwp) {
      map.set(key, { cwp: cost, slot: String(r.slot ?? "").trim() });
    }
  }
  return map;
}

// Name-keyed (lower-cased) catalog gun map for close-time auto-resolution.
// First entry per name wins (catalog names are effectively unique).
async function loadGunCatalogMap(): Promise<Map<string, GunAttrs>> {
  const rows = await db
    .select({
      name: catalogGuns.name,
      category: catalogGuns.category,
      weaponType: catalogGuns.weaponType,
      fireMode: catalogGuns.fireMode,
      powerLevel: catalogGuns.powerLevel,
      manufacturer: catalogGuns.manufacturer,
    })
    .from(catalogGuns);
  const map = new Map<string, GunAttrs>();
  for (const r of rows) {
    // Loose key: players free-type gun names on sheets, so resolution must
    // tolerate case/whitespace/punctuation variants ("M10AF lexington").
    const key = looseNameKey(String(r.name ?? ""));
    if (!key || map.has(key)) continue;
    map.set(key, {
      category: r.category,
      weaponType: r.weaponType,
      fireMode: r.fireMode,
      powerLevel: r.powerLevel,
      manufacturer: r.manufacturer,
    });
  }
  return map;
}

// Build the " · "-joined gun note in the SAME field order as the standalone
// custom-gun request close flow (requests.ts), so a sheet-seeded gun reads
// identically to one created via the request pipeline. Null/blank parts are
// dropped; returns null when nothing is known.
function buildGunNotes(a: {
  manufacturer?: string | null;
  category?: string | null;
  weaponType?: string | null;
  fireMode?: string | null;
  powerLevel?: string | null;
}): string | null {
  const parts = [
    a.manufacturer ? `Manufacturer: ${a.manufacturer}` : null,
    a.category ? `Category: ${a.category}` : null,
    a.weaponType ? `Type: ${a.weaponType}` : null,
    a.fireMode ? `Fire: ${a.fireMode}` : null,
    a.powerLevel ? `Power: ${a.powerLevel}` : null,
  ].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : null;
}

// Runs full submission validation. Returns null on success, error message on failure.
// `user` is used to gate NPC sheets to fixers/admins only.
async function validateSheetForSubmission(data: unknown, user: User): Promise<string | null> {
  // Non-cyberware rules (required fields, PC/NPC gating, age, skills, gear) live
  // in ../lib/sheet-validation so they can be unit-tested without a database.
  const fieldErr = validateSheetFields(data, user.roles);
  if (fieldErr) return fieldErr;
  const d = data as Record<string, unknown>;
  // Tags are optional, but when present they must come from the shared
  // tag-option registry (the same vocabulary the character archive uses).
  if (d.tags !== undefined) {
    if (!Array.isArray(d.tags) || !d.tags.every((t) => typeof t === "string")) {
      return "tags must be a list of tag names";
    }
    if (d.tags.length > 30) return "Too many tags (max 30)";
    const resolved = await resolveRegistryTags(d.tags);
    if (resolved.unknown.length > 0) {
      return `Unknown tag(s): ${resolved.unknown.join(", ")}. Tags must come from the shared tag list.`;
    }
  }
  // NPCs are story chrome (gangs, ripperdoc rigs, set-piece characters) and are
  // not balance-constrained, so the 6-CWP creation cap does not apply to them.
  if (d.sheetType === "NPC") return null;
  // New characters may not start with Tech weapons. Compare each entered gun
  // name against the catalog's Tech-type entries (normalized match; the entered
  // field is free text, so unrecognized names still pass to staff review).
  if (Array.isArray(d.guns) && d.guns.length > 0) {
    const gunMap = await loadGunCatalogMap();
    const techNames = Array.from(gunMap.entries())
      .filter(([, a]) => normalizeName(String(a.category ?? "")) === "tech")
      .map(([name]) => name);
    const offender = findTechStartingGun(d.guns, techNames);
    if (offender) {
      return `Tech weapons aren't available as starting weapons: ${offender}`;
    }
  }
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
  const reviewUrl = portalLink(`/sheets/${sheetId}`);
  const points = await computePoints(data);
  // Turn the summary post into a thread so reviewers can discuss in-channel;
  // the portal mirrors that thread read-only. Thread id == the OP message id.
  // Only persist discordThreadId when a thread genuinely exists — on a hard
  // failure (null) leave it unset so the panel shows "not linked" and a later
  // backfill can thread from the stored message id.
  await announceWithThread({
    channelId: CS_CHANNEL_ID,
    content: `New ${sheetType} sheet pending review: **${name}** by ${user.username}`,
    embeds: [
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
    ],
    threadTitle: `Sheet: ${name}`,
    persist: async ({ msgId, threadId }) => {
      await db
        .update(characterSheets)
        .set({ discordMessageId: msgId, ...(threadId ? { discordThreadId: threadId } : {}) })
        .where(eq(characterSheets.id, sheetId));
    },
  });
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
  const { name, data, characterId, baseUpdatedAt } = req.body ?? {};
  // Optimistic-concurrency guard: clients send the updatedAt they loaded the
  // draft with. If the row has been saved since (e.g. a newer draft written
  // from the phone while an old PC tab was asleep), reject instead of letting
  // the stale tab silently overwrite the newer content.
  if (baseUpdatedAt !== undefined) {
    const base = new Date(String(baseUpdatedAt));
    if (isNaN(base.getTime())) {
      res.status(400).json({ error: "Invalid baseUpdatedAt" });
      return;
    }
    if (existing.updatedAt && existing.updatedAt.getTime() !== base.getTime()) {
      res.status(409).json({
        error: "stale_draft",
        message: "This draft was changed elsewhere since you loaded it. Reload to get the latest version.",
        updatedAt: existing.updatedAt.toISOString(),
      });
      return;
    }
  }
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
  // Guard the UPDATE on the same editable-status set we checked above, so a
  // concurrent vote/override that flips the sheet to approved/rejected between
  // the read and the write can't be clobbered by a late edit.
  const [updated] = await db
    .update(characterSheets)
    .set({
      ...(typeof name === "string" && name.length ? { name } : {}),
      ...(data && typeof data === "object" ? { data } : {}),
      ...(characterId !== undefined ? { characterId } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(characterSheets.id, id),
        inArray(characterSheets.status, allowed),
        // Re-assert the revision inside the UPDATE so a concurrent save that
        // lands between our read and this write also gets rejected. Compare at
        // millisecond precision: the column's defaultNow() carries microseconds
        // which the client's ISO string (ms precision) can never round-trip.
        ...(baseUpdatedAt !== undefined
          ? [
              sql`date_trunc('milliseconds', ${characterSheets.updatedAt}) = date_trunc('milliseconds', ${new Date(String(baseUpdatedAt)).toISOString()}::timestamptz)`,
            ]
          : []),
      ),
    )
    .returning();
  if (!updated) {
    if (baseUpdatedAt !== undefined) {
      const [current] = await db
        .select({ status: characterSheets.status, updatedAt: characterSheets.updatedAt })
        .from(characterSheets)
        .where(eq(characterSheets.id, id));
      if (current && allowed.includes(current.status)) {
        res.status(409).json({
          error: "stale_draft",
          message: "This draft was changed elsewhere since you loaded it. Reload to get the latest version.",
          updatedAt: current.updatedAt?.toISOString(),
        });
        return;
      }
    }
    res.status(409).json({ error: "Sheet is locked (already approved/rejected) — refresh to see the latest." });
    return;
  }
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
      .set({ status: "pending", submittedAt: new Date(), decisionBy: null, decisionNote: null, decidedAt: null, overriddenBy: null })
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
type SeededRow = { name: string; category: string; notes: string | null; equipped: boolean };

// PURE: resolve the sheet's cyberware / gear / guns into inventory rows to seed.
//
// Catalog items (name matches a catalog entry) AUTO-RESOLVE their mechanical
// attributes from the catalog and never need reviewer input. CUSTOM (non-catalog)
// cyberware and guns HARD-REQUIRE the closer to supply attributes at CLOSE & APPLY
// (cyberware: CWP + slot; gun: category/weaponType/fireMode/powerLevel, optional
// manufacturer) — reaching parity with the standalone custom-request close flow.
// Missing/invalid params return an `{ error }` string so the close 400s before
// any character is created.
export function buildSheetInventoryRows(
  rawData: unknown,
  cyberCatalog: Map<string, { cwp: number; slot: string }>,
  gunCatalog: Map<string, GunAttrs>,
  params: SheetCloseParams,
): { error: string } | { rows: SeededRow[] } {
  const data = (rawData ?? {}) as Record<string, unknown>;
  const rows: SeededRow[] = [];

  const cwParams = new Map<number, SheetCyberwareCloseParam>();
  for (const p of params.sheetCyberware ?? []) cwParams.set(p.index, p);
  const gunParams = new Map<number, SheetGunCloseParam>();
  for (const p of params.sheetGuns ?? []) gunParams.set(p.index, p);

  if (Array.isArray(data.cyberware)) {
    for (let i = 0; i < data.cyberware.length; i++) {
      const cw = (data.cyberware[i] ?? {}) as Record<string, unknown>;
      const name = String(cw.name ?? "").trim() || String(cw.slot ?? "").trim();
      if (!name) continue;
      const userNotes = String(cw.notes ?? "").trim();
      const catalog = cyberCatalog.get(name.toLowerCase());
      let points: number;
      let slot: string;
      if (catalog) {
        // Catalog install: authoritative CWP + slot, no prompt.
        points = catalog.cwp;
        slot = catalog.slot || String(cw.slot ?? "").trim();
      } else {
        const p = cwParams.get(i);
        if (!p) return { error: `Enter CWP and slot for custom cyberware "${name}" before closing.` };
        if (!Number.isFinite(p.cwp) || p.cwp < 0) {
          return { error: `A CWP value of 0 or more is required for custom cyberware "${name}".` };
        }
        const s = String(p.slot ?? "").trim();
        if (!s) return { error: `A slot is required for custom cyberware "${name}".` };
        points = p.cwp;
        slot = s;
      }
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
    for (let i = 0; i < data.guns.length; i++) {
      const name = String(data.guns[i] ?? "").trim();
      if (!name) continue;
      const catalog = gunCatalog.get(looseNameKey(name));
      let notes: string | null;
      if (catalog) {
        // Catalog gun: auto-resolve mechanical attributes, no prompt.
        notes = buildGunNotes(catalog);
      } else {
        const p = gunParams.get(i);
        if (!p) return { error: `Enter the mechanical attributes for custom gun "${name}" before closing.` };
        const category = String(p.category ?? "").trim();
        const weaponType = String(p.weaponType ?? "").trim();
        const fireMode = String(p.fireMode ?? "").trim();
        const powerLevel = String(p.powerLevel ?? "").trim();
        if (!category) return { error: `A firing category is required for custom gun "${name}".` };
        if (!weaponType) return { error: `A weapon type is required for custom gun "${name}".` };
        if (!fireMode) return { error: `A fire mode is required for custom gun "${name}".` };
        if (!powerLevel) return { error: `A power level is required for custom gun "${name}".` };
        notes = buildGunNotes({
          manufacturer: String(p.manufacturer ?? "").trim() || null,
          category,
          weaponType,
          fireMode,
          powerLevel,
        });
      }
      rows.push({ name, category: "gun", notes, equipped: false });
    }
  }

  return { rows };
}

// Inserts the pre-resolved inventory rows + their creation events. Only ever
// called on the fresh-insert path so re-approval of a resubmitted edit can't
// duplicate items or clobber inventory the player has since changed.
async function insertSeededInventory(
  tx: Executor,
  characterId: number,
  ownerId: string | null,
  rows: SeededRow[],
): Promise<void> {
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

async function materializeCharacterFromSheet(
  tx: Executor,
  sheet: SheetRow,
  cyberCatalog: Map<string, { cwp: number; slot: string }>,
  gunCatalog: Map<string, GunAttrs>,
  params: SheetCloseParams,
): Promise<number | { error: string }> {
  const fields = characterFieldsFromSheet(sheet);

  if (sheet.characterId) {
    const [linked] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, sheet.characterId))
      .for("update");
    if (linked && linked.ownerId === sheet.ownerId) {
      // Linked-character path only updates fields — it never seeds inventory,
      // so it needs no item params and skips the custom-attribute requirement.
      // If the character has never had a checkup, inherit the household's
      // current effective checkup date so this approval doesn't reset the
      // owner's meds streak (see householdEffectiveCheckupDate).
      const inherited = linked.lastCheckupAt
        ? null
        : await householdEffectiveCheckupDate(tx, sheet.ownerId, linked.id);
      await tx
        .update(characters)
        .set({
          ...fields,
          approved: true,
          lifeStatus: "active",
          ...(inherited ? { lastCheckupAt: inherited } : {}),
        })
        .where(eq(characters.id, sheet.characterId));
      return sheet.characterId;
    }
  }

  // Fresh-insert path → seed inventory. Validate/resolve the rows BEFORE any
  // write so a missing custom attribute 400s without creating a character.
  const built = buildSheetInventoryRows(sheet.data, cyberCatalog, gunCatalog, params);
  if ("error" in built) return { error: built.error };

  // One-per-capped-slot guard across the seeded set. Every cyberware row here
  // is INSTALLED (carries "CWP n"), and the per-item install guard never sees
  // sibling rows of the same batch — this is exactly how NeoFiber + Dense
  // Marrow both landed in Skeleton & Torso Musculature on one approval.
  // NPC sheets are exempt (staff manage NPC chrome freely).
  if (!sheetDataIsNpc(sheet.data)) {
    const cyberSeed = built.rows.filter((r) => r.category === "cyberware");
    if (cyberSeed.length > 1) {
      const clash = batchSlotClashError(cyberSeed, await loadCyberwareSlotByName());
      if (clash) return { error: clash };
    }
  }

  // Inherit the owner's current household checkup date so a freshly approved
  // character doesn't reset the meds streak to week 1 (the household week is
  // max(lastCheckupAt ?? createdAt) across billable PCs, and this new row's
  // createdAt would otherwise become that max). Null (first PC) = fresh start.
  const inheritedCheckupAt = await householdEffectiveCheckupDate(tx, sheet.ownerId);

  // Seed archive tags picked on the sheet form into manualTags (the column the
  // Discord importer never touches). Submission already validated them against
  // the registry; if a tag was renamed/deleted between submit and close we keep
  // the known ones rather than blocking the close over a stale label.
  const rawTags = Array.isArray((sheet.data as Record<string, unknown> | null)?.tags)
    ? ((sheet.data as Record<string, unknown>).tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  let manualTags: string[] = [];
  if (rawTags.length > 0) {
    // Lenient: keep the still-known tags, drop any that left the registry.
    manualTags = (await resolveRegistryTags(rawTags)).tags;
  }

  const [c] = await tx
    .insert(characters)
    .values({
      ownerId: sheet.ownerId,
      ...fields,
      approved: true,
      claimed: true,
      lifeStatus: "active",
      ...(manualTags.length > 0 ? { manualTags } : {}),
      ...(inheritedCheckupAt ? { lastCheckupAt: inheritedCheckupAt } : {}),
    })
    .returning();
  await tx.insert(characterStatus).values({ characterId: c.id });
  await insertSeededInventory(tx, c.id, sheet.ownerId, built.rows);
  return c.id;
}

// POST /sheets/:id/vote — a reviewer (not the owner) casts an approve/reject
// vote. When the running tally reaches the majority threshold the sheet is
// decided in the same locked transaction: an approve materializes the
// character, a reject closes the sheet. Mirrors the edit-vote pipeline.
router.post("/sheets/:id/vote", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const u = req.user!;
  if (!isEligibleReviewer(u)) {
    res.status(403).json({ error: "Only Cs Approvers can vote. Admins use override." });
    return;
  }
  const { vote, note } = req.body ?? {};
  // "pause" is a visible marker only — it never counts toward the decision
  // thresholds (see tallyReviewVotes) and never blocks auto-finalize.
  if (vote !== "approve" && vote !== "reject" && vote !== "pause") {
    res.status(400).json({ error: "vote must be 'approve', 'reject' or 'pause'" });
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
    const finalVote = await castReviewVote({ subjectType: "sheet", subjectId: id, voterId: u.id, vote, note: note ?? null, conn: tx });
    const tally = await tallyReviewVotes({ subjectType: "sheet", subjectId: id, submitterId: sheet.ownerId, conn: tx });
    if (!tally.decided) {
      return { ok: { decided: null as "approved" | "rejected" | null, sheet, tally, finalVote } };
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
    return { ok: { decided: tally.decided, sheet: updated, tally, finalVote } };
  });
  if (result.error) {
    res.status(result.error.status).json(result.error.body);
    return;
  }
  const { decided, sheet, tally, finalVote } = result.ok;
  const cleared = finalVote === null;
  await recordAudit({
    req,
    category: "sheet",
    action: decided ? `vote_decided_${decided}` : cleared ? "vote_cleared" : "vote",
    targetType: "sheet",
    targetId: id,
    message: cleared
      ? `${u.username} cleared their ${vote} vote on sheet "${sheet.name}"`
      : `${u.username} voted ${vote} on sheet "${sheet.name}"${decided ? ` → ${decided}` : ""}`,
    after: { vote, cleared, decided, approveCount: tally.approveCount, rejectCount: tally.rejectCount },
  });
  res.json({ status: sheet.status, decided, approveCount: tally.approveCount, rejectCount: tally.rejectCount, pauseCount: tally.pauseCount, threshold: tally.threshold });
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
export async function closeSheet(
  req: Request,
  id: number,
  note?: string,
  sheetParams: SheetCloseParams = {},
): Promise<ReviewActionResult> {
  const u = req.user!;
  // Catalog reference data for auto-resolving known cyberware/guns at close.
  // Loaded outside the txn (read-only, no lock needed).
  const [cyberCatalog, gunCatalog] = await Promise.all([
    loadCyberwareCatalogMap(),
    loadGunCatalogMap(),
  ]);
  const result = await db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(characterSheets).where(eq(characterSheets.id, id)).for("update");
    if (!sheet) return { kind: "error" as const, status: 404, body: { error: "Not found" } };
    if (sheet.status === "closed") return { kind: "noop" as const };
    if (sheet.status !== "approved" && sheet.status !== "rejected" && sheet.status !== "cancelled") {
      return { kind: "error" as const, status: 409, body: { error: `Only a resolved sheet can be closed (this one is ${sheet.status})` } };
    }
    if (sheet.status === "approved") {
      const mat = await materializeCharacterFromSheet(tx, sheet, cyberCatalog, gunCatalog, sheetParams);
      if (typeof mat !== "number") {
        return { kind: "error" as const, status: 400, body: { error: mat.error } };
      }
      const characterId = mat;
      const [updated] = await tx
        .update(characterSheets)
        .set({ status: "closed", closedAt: new Date(), closedBy: u.id, characterId, closedOutcome: sheet.status })
        .where(eq(characterSheets.id, id))
        .returning();
      return { kind: "applied" as const, sheet: updated };
    }
    const [updated] = await tx
      .update(characterSheets)
      .set({ status: "closed", closedAt: new Date(), closedBy: u.id, closedOutcome: sheet.status })
      .where(eq(characterSheets.id, id))
      .returning();
    return { kind: "archived" as const, sheet: updated, prevStatus: sheet.status };
  });
  if (result.kind === "error") return { status: result.status, body: result.body };
  // In-portal bell notification to the sheet submitter (character sheets have
  // no decision DM — the bell is the player's only push channel here). A
  // player-cancelled sheet is their own action, so it never notifies.
  if (result.kind === "applied" || result.kind === "archived") {
    const approved = result.kind === "applied";
    const wasRejected = result.kind === "archived" && result.prevStatus === "rejected";
    if (approved || wasRejected) {
      void createNotification({
        userId: result.sheet.ownerId,
        type: "sheet_decision",
        title: approved
          ? `Character sheet "${result.sheet.name}" approved`
          : `Character sheet "${result.sheet.name}" rejected`,
        body: note ?? null,
        href: approved && result.sheet.characterId ? `/characters/${result.sheet.characterId}` : `/sheets/${id}`,
      });
    }
  }
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
      message: `Closed & materialized sheet "${result.sheet.name}"${note ? ` — note: ${note}` : ""}`,
    });
    // Grant the "Approved Character" Discord role to the submitter. The portal
    // user id IS the Discord snowflake. Durable at-least-once: a pending row is
    // persisted first and the hourly role_sync retries (with a staff alert on
    // repeated failure), so a Discord hiccup can never silently drop the role.
    if (result.sheet.ownerId) {
      void grantRoleDurable(
        result.sheet.ownerId,
        APPROVED_CHARACTER_ROLE_ID,
        `Character sheet "${result.sheet.name}" approved`,
      );
    }
    // Grant the "RipperDoc" Discord role when the submitter flagged this
    // character as a ripper doc on the sheet. Same durable at-least-once
    // pattern — the role_sync cron re-injects the website "ripperdoc" flag
    // from the role id once it lands.
    if (result.sheet.ownerId && sheetWantsRipperdoc(result.sheet.data)) {
      void grantRoleDurable(
        result.sheet.ownerId,
        RIPPERDOC_ROLE_ID,
        `RipperDoc — character "${result.sheet.name}" approved`,
      );
    }
  } else if (result.kind === "archived") {
    await recordAudit({
      req,
      category: "sheet",
      action: "sheet_closed",
      targetType: "sheet",
      targetId: id,
      message: `Closed sheet "${result.sheet.name}" (${result.prevStatus})${note ? ` — note: ${note}` : ""}`,
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
    // Clear the prior round's votes so reopen is a genuinely fresh review round.
    // If we preserved them, finalize-on-read would re-tally the carried-over
    // approvals on the very next reviewer read and snap the sheet straight back
    // to approved — making reopen look like it did nothing.
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
