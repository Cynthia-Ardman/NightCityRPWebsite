import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  db,
  customRequests,
  characters,
  users,
  inventoryItems,
  housing,
  stores,
  ripperdocs,
  storeStock,
  ripperdocStock,
  storeEmployees,
  ripperdocEmployees,
  walletTransactions,
  characterUpdates,
  activityEvents,
  missionAssignments,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage } from "../lib/discord";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  isReviewer,
  listEligibleReviewerIds,
  majorityOf,
  tallyReviewVotes,
  castReviewVote,
  clearReviewVotes,
  loadVotesBySubject,
  type ReviewActionResult,
} from "../lib/review";

// Off-catalog "miscellaneous" requests: off-map property, custom guns, and
// custom cyberware. Staff triage these in the unified Pending Requests page;
// approving one auto-applies it (creates a housing lease or an inventory item).
// See lib/db schema `custom_requests` for the data model and idempotency marker.

const REQUEST_TYPES = ["property", "gun", "cyberware", "store", "ripperdoc"] as const;
type RequestType = (typeof REQUEST_TYPES)[number];

// Custom-request types that NEVER appear in the staff triage queue: `stock_cost`
// is owner-approved, `employee_invite` is decided by the invited player, and
// `mission_participation` is decided by the assigned character's player. They
// live only in "My Requests". Exported so the reviewer unseen-count / unseen-id
// endpoints (review.ts) can exclude the exact same set — otherwise the dashboard
// "Pending Requests" card and the misc-tab badge count a ticket that the queue
// they link to never renders (a phantom "1 pending request, nothing there").
export const STAFF_QUEUE_EXCLUDED_REQUEST_TYPES = ["stock_cost", "employee_invite", "mission_participation"] as const;

// Venue requests (store/ripperdoc) carry name/character plus required
// purpose/location/description and materialize into the stores/ripperdocs
// tables on approval (owned by the requester + chosen character).
function isVenueType(type: string): boolean {
  return type === "store" || type === "ripperdoc";
}

// Player-facing label for a request type, used in Discord DMs and the
// activity feed. Keep in sync with REQUEST_TYPES.
function typeLabelFor(type: string): string {
  switch (type) {
    case "property":
      return "off-map property";
    case "gun":
      return "custom gun";
    case "cyberware":
      return "custom cyberware";
    case "store":
      return "new store";
    case "ripperdoc":
      return "new ripperdoc";
    case "employee_invite":
      return "employment invitation";
    case "venue_stock":
      return "custom stock";
    case "stock_cost":
      return "stock cost";
    case "mission_participation":
      return "mission participation";
    default:
      return "request";
  }
}

// stock_cost (venue owner pays) and employee_invite (invited player accepts)
// are decided outside the staff vote pipeline. Returns a 400 error body when a
// staff vote/override/request-changes action targets one of them.
function ownerDecidedError(type: string): { status: number; body: { error: string } } | null {
  if (type === "stock_cost") return { status: 400, body: { error: "Stock-cost requests are decided by the venue owner" } };
  if (type === "employee_invite") return { status: 400, body: { error: "Employment invitations are decided by the invited player" } };
  if (type === "mission_participation") return { status: 400, body: { error: "Participation requests are decided by the assigned character's player" } };
  return null;
}

// Clamp a commission percentage into [0, 100]. Mirrors stores.ts clampPct.
function clampPct(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Audit category for a request decision — venues are shop, property is
// housing, guns/cyberware are inventory.
function auditCategoryFor(type: string): "housing" | "shop" | "inventory" {
  if (type === "property") return "housing";
  if (type === "gun" || type === "cyberware") return "inventory";
  // store / ripperdoc / stock_cost / venue_stock / employee_invite all live
  // under the shop umbrella.
  return "shop";
}

function isFixerOrAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN") || hasRole(user.roles, "FIXER");
}

function isAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN");
}

// Maps a lifecycle bucket name to the set of statuses it covers. Active =
// awaiting a decision; Resolved = decided but not yet committed/archived;
// Archive = closed. Unknown bucket falls back to pending.
function bucketStatuses(bucket: string): string[] {
  if (bucket === "active") return ["pending", "changes_requested"];
  if (bucket === "resolved") return ["approved", "rejected", "cancelled"];
  if (bucket === "archive") return ["closed"];
  return ["pending"];
}

function bucketPredicate(bucket: string) {
  return inArray(customRequests.status, bucketStatuses(bucket));
}

// First-of-next-month at 00:00 UTC — initial paid_through so a new lease is
// paid up for the current month until the monthly_rent cron rolls it forward.
// Mirrors housing.ts endOfCurrentMonth.
function endOfCurrentMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RequestSelectRow = typeof customRequests.$inferSelect;
type CharacterRow = typeof characters.$inferSelect;

// Mechanical parameters a reviewer supplies when approving a request.
// `property` needs monthly rent (+ optional kind); `cyberware` needs CWP.
// Other types need nothing. These are validated up-front when an approve vote
// (or override) is cast and persisted on `details.approval`, so the deciding
// approve can materialize from the stored values without re-prompting.
type ApprovalParams = { monthlyRent?: unknown; kind?: unknown; businessName?: unknown; cwp?: unknown; unitCost?: unknown; retail?: unknown; qty?: unknown };

// Monetary fields here land in Postgres `integer` (int4) columns, which max out
// at 2,147,483,647. Cap well under that so a fat-fingered value is rejected with
// a clear 400 at approve/apply time instead of overflowing into a cryptic 500.
const MAX_MONEY = 2_000_000_000;

// Validates that the params required to APPROVE a given request type are
// present and well-formed. Returns a normalized object on success or an error
// string. Called before recording an approve vote so the tally can never be
// tipped to "approved" without the values needed to materialize.
function normalizeApprovalParams(
  type: string,
  params: ApprovalParams,
): { ok: Record<string, number | string> } | { error: string } {
  if (type === "property") {
    const raw = parseInt(String(params.monthlyRent), 10);
    if (!Number.isFinite(raw) || raw < 0) {
      return { error: "monthlyRent (>= 0) required to approve a property request" };
    }
    // Clamp a too-large value down to the ceiling instead of rejecting it, so a
    // staff typo of an enormous number is silently corrected rather than erroring.
    const monthlyRent = Math.min(raw, MAX_MONEY);
    const kind = params.kind === "business" ? "business" : "residential";
    const out: Record<string, number | string> = { monthlyRent, kind };
    // Optional: staff may set/replace the leased business/property name at
    // approval time. When omitted the request title is used as-is.
    if (typeof params.businessName === "string" && params.businessName.trim()) {
      out.businessName = params.businessName.trim();
    }
    return { ok: out };
  }
  if (type === "cyberware") {
    const cwp = Number(params.cwp);
    if (!Number.isFinite(cwp) || cwp < 0) {
      return { error: "cwp (>= 0) required to approve a cyberware request" };
    }
    return { ok: { cwp } };
  }
  if (type === "venue_stock") {
    const rawUnitCost = parseInt(String(params.unitCost), 10);
    const rawRetail = parseInt(String(params.retail), 10);
    const qty = parseInt(String(params.qty), 10);
    if (!Number.isFinite(rawUnitCost) || rawUnitCost < 0) {
      return { error: "unitCost (>= 0) required to approve a stock request" };
    }
    if (!Number.isFinite(rawRetail) || rawRetail < 0) {
      return { error: "retail (>= 0) required to approve a stock request" };
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return { error: "qty (>= 1) required to approve a stock request" };
    }
    // Clamp too-large money values down to the ceiling rather than erroring.
    const unitCost = Math.min(rawUnitCost, MAX_MONEY);
    const retail = Math.min(rawRetail, MAX_MONEY);
    return { ok: { unitCost, retail, qty } };
  }
  return { ok: {} };
}

// Auto-applies an approved request by type (housing lease / inventory item /
// venue) and returns the appliedRef + human summary. Runs inside the caller's
// locked transaction so the materialize + status flip are atomic. Shared by
// the vote-decided-approve path and the admin override path. `params` carries
// the mechanical values (rent/kind/cwp) — for the vote path these come from
// `details.approval`, for override straight from the request body.
async function materializeRequest(
  tx: Tx,
  reqRow: RequestSelectRow,
  c: CharacterRow,
  params: ApprovalParams,
): Promise<{ ok: { appliedRef: string; summary: string } } | { error: { status: number; body: { error: string } } }> {
  if (reqRow.type === "property") {
    const monthlyRent = parseInt(String(params.monthlyRent), 10);
    if (!Number.isFinite(monthlyRent) || monthlyRent < 0) {
      return { error: { status: 400, body: { error: "monthlyRent (>= 0) required to approve a property request" } } };
    }
    if (monthlyRent > MAX_MONEY) {
      return { error: { status: 400, body: { error: `monthlyRent must be ${MAX_MONEY.toLocaleString()} or less — re-approve this request with a valid rent` } } };
    }
    const kind = params.kind === "business" ? "business" : "residential";
    if (!c.approved) {
      return { error: { status: 400, body: { error: "Character is not approved; cannot bill rent" } } };
    }
    // Staff may set/replace the business/property name on approval; it becomes
    // the lease's displayed address. Falls back to the request title.
    const businessName =
      typeof params.businessName === "string" && params.businessName.trim()
        ? params.businessName.trim()
        : reqRow.title;
    const [lease] = await tx
      .insert(housing)
      .values({
        characterId: reqRow.characterId,
        listingId: null,
        address: businessName,
        monthlyRent,
        paidThrough: endOfCurrentMonth(),
        notes: reqRow.description ?? null,
        kind,
      })
      .returning();
    return { ok: { appliedRef: `housing:${lease.id}`, summary: `Off-map property approved: ${businessName} (€$${monthlyRent.toLocaleString()}/mo, ${kind})` } };
  }
  if (reqRow.type === "gun") {
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        characterId: reqRow.characterId,
        ownerId: c.ownerId,
        name: reqRow.title,
        category: "gun",
        quantity: 1,
        notes: reqRow.description ?? null,
      })
      .returning();
    return { ok: { appliedRef: `inventory:${item.instanceUuid}`, summary: `Custom gun approved: ${reqRow.title}` } };
  }
  if (reqRow.type === "cyberware") {
    const cwp = Number(params.cwp);
    if (!Number.isFinite(cwp) || cwp < 0) {
      return { error: { status: 400, body: { error: "cwp (>= 0) required to approve a cyberware request" } } };
    }
    const notes = `CWP ${cwp}${reqRow.description ? ` · ${reqRow.description}` : ""}`;
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        characterId: reqRow.characterId,
        ownerId: c.ownerId,
        name: reqRow.title,
        category: "cyberware",
        quantity: 1,
        notes,
      })
      .returning();
    return { ok: { appliedRef: `inventory:${item.instanceUuid}`, summary: `Custom cyberware approved: ${reqRow.title} (CWP ${cwp})` } };
  }
  if (reqRow.type === "store" || reqRow.type === "ripperdoc") {
    if (!c.ownerId) {
      return { error: { status: 400, body: { error: "Character is unclaimed (no owner) — cannot apply" } } };
    }
    const det = (reqRow.details ?? {}) as { purpose?: string; location?: string };
    if (reqRow.type === "store") {
      const [s] = await tx
        .insert(stores)
        .values({
          ownerId: c.ownerId,
          ownerCharacterId: reqRow.characterId,
          name: reqRow.title,
          purpose: det.purpose ?? null,
          location: det.location ?? null,
          description: reqRow.description ?? null,
        })
        .returning();
      return { ok: { appliedRef: `store:${s.id}`, summary: `New store approved: ${reqRow.title}` } };
    }
    const [r] = await tx
      .insert(ripperdocs)
      .values({
        ownerId: c.ownerId,
        ownerCharacterId: reqRow.characterId,
        name: reqRow.title,
        purpose: det.purpose ?? null,
        location: det.location ?? null,
        description: reqRow.description ?? null,
      })
      .returning();
    return { ok: { appliedRef: `ripperdoc:${r.id}`, summary: `New ripperdoc approved: ${reqRow.title}` } };
  }
  if (reqRow.type === "venue_stock") {
    // Fixers have voted to approve and set the cost/qty/retail. We don't add
    // the stock or debit the venue here — instead we hand off to the existing
    // stock_cost flow: insert a pending stock_cost request the venue owner must
    // approve from "My Requests" (which debits + stocks via /stock-decision).
    const det = (reqRow.details ?? {}) as {
      kind?: "store" | "ripperdoc";
      venueId?: number;
      venueName?: string;
      category?: string | null;
    };
    const kind = det.kind === "ripperdoc" ? "ripperdoc" : "store";
    const venueId = Number(det.venueId);
    if (!Number.isFinite(venueId) || venueId <= 0) {
      return { error: { status: 400, body: { error: "Stock request is missing its venue" } } };
    }
    const unitCost = Math.max(0, Math.round(Number(params.unitCost) || 0));
    const retail = Math.max(0, Math.round(Number(params.retail) || 0));
    const qty = Math.max(1, Math.round(Number(params.qty) || 1));
    const totalCost = unitCost * qty;
    const [stockReq] = await tx
      .insert(customRequests)
      .values({
        type: "stock_cost",
        characterId: reqRow.characterId,
        requestedById: reqRow.requestedById,
        title: reqRow.title,
        description: reqRow.description ?? null,
        details: {
          kind,
          venueId,
          venueName: det.venueName,
          name: reqRow.title,
          category: det.category ?? null,
          qty,
          unitCost,
          totalCost,
          retail,
        } as never,
      })
      .returning();
    return {
      ok: {
        appliedRef: `custom_request:${stockReq.id}`,
        summary: `Custom stock approved by fixers: ${reqRow.title} x${qty} @ €$${unitCost.toLocaleString()}/unit — awaiting your payment in My Requests.`,
      },
    };
  }
  return { error: { status: 400, body: { error: `Unknown request type ${reqRow.type}` } } };
}

// Side-effects run AFTER an approve commits (character update note, activity
// feed, inventory ledger, audit, player DM). Shared by vote-decided-approve
// and override so both leave an identical trail. Best-effort beyond the audit.
async function afterApprove(
  req: Parameters<typeof recordAudit>[0]["req"] & { user: NonNullable<unknown> },
  reqRow: RequestSelectRow,
  c: CharacterRow,
  appliedRef: string,
  summary: string,
  via: "vote" | "override",
): Promise<void> {
  const u = (req as { user: { id: string; username: string; avatarUrl: string | null } }).user;
  await db.insert(characterUpdates).values({ characterId: reqRow.characterId, authorId: u.id, note: summary });
  await db.insert(activityEvents).values({
    kind: "request_approved",
    actorId: u.id,
    actorName: u.username,
    actorAvatarUrl: u.avatarUrl,
    message: `${c.name}: ${summary}${via === "override" ? " (admin override)" : ""}`,
  });
  if (reqRow.type === "gun" || reqRow.type === "cyberware") {
    await recordInventoryEvent({
      instanceUuid: appliedRef.replace("inventory:", ""),
      kind: "created",
      actorId: u.id,
      actorName: u.username,
      toCharacterId: c.id,
      toCharacterName: c.name,
      itemName: reqRow.title,
      quantity: 1,
      reason: `Approved ${reqRow.type} request`,
    });
  }
  await recordAudit({
    req,
    category: auditCategoryFor(reqRow.type),
    action: via === "override" ? "request_override_approve" : "request_vote_approve",
    targetType: "custom_request",
    targetId: reqRow.id,
    message: summary,
    after: { type: reqRow.type, characterId: reqRow.characterId, appliedRef, via },
  });
}

const router: IRouter = Router();

type RequestRow = {
  id: number;
  type: string;
  characterId: number;
  characterName: string | null;
  requestedById: string;
  requestedByName: string | null;
  title: string;
  description: string | null;
  imageUrl: string | null;
  details: unknown;
  status: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewerNote: string | null;
  appliedRef: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  createdAt: Date;
};

function shape(row: RequestRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    characterId: row.characterId,
    characterName: row.characterName ?? "(unknown)",
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl ?? null,
    details: row.details ?? null,
    status: row.status,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewerNote: row.reviewerNote,
    appliedRef: row.appliedRef,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedBy: row.closedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectWhere(predicate: ReturnType<typeof and> | ReturnType<typeof eq>) {
  return (await db
    .select({
      id: customRequests.id,
      type: customRequests.type,
      characterId: customRequests.characterId,
      characterName: characters.name,
      requestedById: customRequests.requestedById,
      requestedByName: users.username,
      title: customRequests.title,
      description: customRequests.description,
      imageUrl: customRequests.imageUrl,
      details: customRequests.details,
      status: customRequests.status,
      reviewedById: customRequests.reviewedById,
      reviewedAt: customRequests.reviewedAt,
      reviewerNote: customRequests.reviewerNote,
      appliedRef: customRequests.appliedRef,
      closedAt: customRequests.closedAt,
      closedBy: customRequests.closedBy,
      createdAt: customRequests.createdAt,
    })
    .from(customRequests)
    .innerJoin(characters, eq(characters.id, customRequests.characterId))
    .innerJoin(users, eq(users.id, customRequests.requestedById))
    .where(predicate)
    .orderBy(desc(customRequests.createdAt))) as RequestRow[];
}

// Attach the review tally (approve/reject counts, majority threshold, and the
// viewer's own vote) to a list of request rows in a fixed number of queries —
// one bulk vote load + one reviewer-pool load — instead of N+1. The eligible
// pool excludes each request's own submitter. `stock_cost` rows are
// owner-decided and simply tally to 0/0 here, which the UI ignores.
async function attachTallies(rows: RequestRow[], viewerId: string): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const votesById = await loadVotesBySubject({ subjectType: "request", subjectIds: rows.map((r) => r.id) });
  const reviewerRows = await db.select({ id: users.id, roles: users.roles }).from(users);
  const reviewerIds = reviewerRows
    .filter((r) => isReviewer({ roles: r.roles ?? [] } as never))
    .map((r) => r.id);
  return rows.map((r) => {
    const eligible = reviewerIds.filter((id) => id !== r.requestedById);
    const eligibleSet = new Set(eligible);
    const votes = (votesById.get(r.id) ?? []).filter((v) => eligibleSet.has(v.voterId));
    const approveCount = votes.filter((v) => v.vote === "approve").length;
    const rejectCount = votes.filter((v) => v.vote === "reject").length;
    const mine = (votesById.get(r.id) ?? []).find((v) => v.voterId === viewerId);
    return {
      ...shape(r),
      approveCount,
      rejectCount,
      threshold: majorityOf(eligible.length),
      myVote: mine?.vote ?? null,
    };
  });
}

// Best-effort Discord DM to the player who submitted a request, telling them
// the staff decision (and the reviewer note on rejection). Resolves the
// requester's Discord id from `users`. Never throws — a delivery miss (DMs
// closed, no bot token, network error) must not affect the already-committed
// approve/reject decision.
async function notifyRequesterOfDecision(row: RequestRow, summary: string | null): Promise<void> {
  try {
    const [u] = await db
      .select({ discordId: users.discordId })
      .from(users)
      .where(eq(users.id, row.requestedById));
    if (!u?.discordId) return;
    const typeLabel = typeLabelFor(row.type);
    const who = row.characterName ?? "your character";
    let content: string;
    if (row.status === "approved") {
      content = `Your ${typeLabel} request "${row.title}" for ${who} was approved.`;
      if (summary) content += `\n${summary}`;
    } else {
      content = `Your ${typeLabel} request "${row.title}" for ${who} was rejected.`;
      if (row.reviewerNote) content += `\nReason: ${row.reviewerNote}`;
    }
    await sendDirectMessage(u.discordId, content);
  } catch (err) {
    logger.warn({ err, requestId: row.id }, "request decision DM failed");
  }
}

// Submit a custom request. Player picks one of their own characters and types
// a free-text title (location / item name) and description.
router.post("/requests", requireAuth, async (req, res): Promise<void> => {
  const { type, characterId, title, description, imageUrl, purpose, location, source } = req.body ?? {};
  const reqType = String(type) as RequestType;
  if (!REQUEST_TYPES.includes(reqType)) {
    res.status(400).json({ error: `type must be one of: ${REQUEST_TYPES.join(", ")}` });
    return;
  }
  const cid = parseInt(String(characterId), 10);
  if (!cid || !title || !String(title).trim()) {
    res.status(400).json({ error: "characterId and title required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  // Scope to the caller's own characters (admins may submit on behalf).
  if (c.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.archived) {
    res.status(400).json({ error: "Cannot submit a request for an archived character" });
    return;
  }

  // Venue requests require purpose, location, and description (all stored so
  // the venue can be created verbatim on approval). purpose/location live in
  // the `details` jsonb; the venue name is the title; description reuses the
  // shared column.
  let details: Record<string, unknown> | null = null;
  let descToStore = typeof description === "string" && description.trim() ? description.trim() : null;
  if (isVenueType(reqType)) {
    const p = typeof purpose === "string" ? purpose.trim() : "";
    const l = typeof location === "string" ? location.trim() : "";
    const d = typeof description === "string" ? description.trim() : "";
    if (!p || !l || !d) {
      res.status(400).json({ error: "purpose, location, and description are required" });
      return;
    }
    details = { purpose: p, location: l };
    descToStore = d;
  } else if ((reqType === "gun" || reqType === "cyberware") && typeof source === "string" && source.trim()) {
    // Optional "where do you want this from" source for gun/cyberware requests
    // (a store/ripperdoc name or a free-text "Custom" value). Carried on
    // details.source for fixers reviewing the request.
    details = { source: source.trim() };
  }

  const [inserted] = await db
    .insert(customRequests)
    .values({
      type: reqType,
      characterId: cid,
      requestedById: req.user!.id,
      title: String(title).trim(),
      description: descToStore,
      imageUrl: typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null,
      details: details as never,
    })
    .returning();
  const [row] = await selectWhere(eq(customRequests.id, inserted.id));
  res.status(201).json(shape(row));
});

// A player's own requests (scoped to caller). Optional ?type filter.
router.get("/requests/mine", requireAuth, async (req, res): Promise<void> => {
  const typeFilter = req.query.type ? String(req.query.type) : null;
  const predicate = typeFilter
    ? and(eq(customRequests.requestedById, req.user!.id), eq(customRequests.type, typeFilter))
    : eq(customRequests.requestedById, req.user!.id);
  const rows = await selectWhere(predicate);
  res.json(await attachTallies(rows, req.user!.id));
});

// Staff: list requests across all players. Defaults to pending. Fixer/admin.
router.get("/requests", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  // Lifecycle buckets for the Active / Resolved / Archive sections. A `bucket`
  // query param maps to a set of statuses; the legacy single `status` param is
  // still honored for back-compat (and defaults to pending).
  const bucket = req.query.bucket ? String(req.query.bucket) : null;
  const statusPredicate = bucket
    ? bucketPredicate(bucket)
    : eq(customRequests.status, String(req.query.status ?? "pending"));
  // Exclude the My-Requests-only types (see STAFF_QUEUE_EXCLUDED_REQUEST_TYPES).
  // `venue_stock` IS fixer-voted, so it stays here.
  const rows = await selectWhere(
    and(
      statusPredicate,
      notInArray(customRequests.type, STAFF_QUEUE_EXCLUDED_REQUEST_TYPES as unknown as string[]),
    ),
  );
  res.json(await attachTallies(rows, req.user!.id));
});


// POST /requests/:id/vote — a reviewer (not the requester) casts an
// approve/reject vote. An approve vote must carry the mechanical params for the
// request type (property: monthlyRent[+kind]; cyberware: cwp); they're stashed
// on details.approval so the deciding approve can materialize from them. When
// the tally reaches majority the request is decided in the same locked txn.
router.post("/requests/:id/vote", requireAuth, async (req, res): Promise<void> => {
  if (!isReviewer(req.user!)) {
    res.status(403).json({ error: "Only fixers / approvers / admins can vote" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const body = req.body ?? {};
  const vote = body.vote === "approve" ? "approve" : body.vote === "reject" ? "reject" : null;
  if (!vote) {
    res.status(400).json({ error: "vote must be 'approve' or 'reject'" });
    return;
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  // Validate approve params BEFORE entering the txn so a malformed approve is
  // rejected without locking the row.
  let approvalToStore: Record<string, number | string> | null = null;
  if (vote === "approve") {
    const [pre] = await db.select({ type: customRequests.type }).from(customRequests).where(eq(customRequests.id, rid));
    if (!pre) { res.status(404).json({ error: "Request not found" }); return; }
    const preBlocked = ownerDecidedError(pre.type);
    if (preBlocked) { res.status(preBlocked.status).json(preBlocked.body); return; }
    const norm = normalizeApprovalParams(pre.type, body);
    if ("error" in norm) { res.status(400).json({ error: norm.error }); return; }
    approvalToStore = norm.ok;
  }

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, rid)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { error: blocked };
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    if (reqRow.requestedById === req.user!.id) {
      return { error: { status: 403, body: { error: "You cannot vote on a request you submitted" } } };
    }

    // Persist this reviewer's approval params onto details.approval so the
    // deciding approve can materialize from them.
    if (vote === "approve" && approvalToStore) {
      const merged = { ...((reqRow.details ?? {}) as Record<string, unknown>), approval: approvalToStore };
      await tx.update(customRequests).set({ details: merged as never }).where(eq(customRequests.id, rid));
    }

    await castReviewVote({ subjectType: "request", subjectId: rid, voterId: req.user!.id, vote, note, conn: tx });
    const tally = await tallyReviewVotes({ subjectType: "request", subjectId: rid, submitterId: reqRow.requestedById, conn: tx });
    if (!tally.decided) return { ok: { decided: null as "approved" | "rejected" | null, reqRow, tally } };

    if (tally.decided === "rejected") {
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date(), reviewerNote: note })
        .where(eq(customRequests.id, rid));
      return { ok: { decided: "rejected" as const, reqRow, tally } };
    }

    // Decided approve — STAGE the decision only. Under the deferred-effects
    // lifecycle the effect (lease / inventory / venue) is NOT applied here; it
    // is committed when a fixer closes the ticket. We persist the reviewer's
    // mechanical params on `decisionParams` so close can materialize from them
    // without re-prompting.
    const storedApproval = approvalToStore ?? ((reqRow.details ?? {}) as { approval?: ApprovalParams }).approval ?? null;
    await tx
      .update(customRequests)
      .set({ status: "approved", reviewedById: req.user!.id, reviewedAt: new Date(), reviewerNote: note, decisionParams: storedApproval as never })
      .where(eq(customRequests.id, rid));
    return { ok: { decided: "approved" as const, reqRow, tally } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const out = txResult.ok;
  if (out.decided === "approved") {
    // Effects are deferred to close — record only the staged-decision audit
    // here. The player DM, character note, inventory ledger and activity feed
    // all fire from afterApprove when the ticket is closed.
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_vote_approve",
      targetType: "custom_request",
      targetId: rid,
      message: `Approved ${out.reqRow.type} request (pending close): ${out.reqRow.title}`,
      after: { type: out.reqRow.type, characterId: out.reqRow.characterId, staged: true },
    });
  } else if (out.decided === "rejected") {
    const [row] = await selectWhere(eq(customRequests.id, rid));
    try {
      await db.insert(activityEvents).values({
        kind: "request_rejected",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorAvatarUrl: req.user!.avatarUrl,
        message: `${row.characterName ?? "(unknown)"}: Rejected ${typeLabelFor(out.reqRow.type)} request: ${out.reqRow.title}`,
      });
    } catch (err) {
      logger.warn({ err, requestId: rid }, "reject activity-feed write failed");
    }
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_vote_reject",
      targetType: "custom_request",
      targetId: rid,
      message: `Rejected ${out.reqRow.type} request: ${out.reqRow.title}`,
    });
    await notifyRequesterOfDecision(row, null);
  }
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json({ ...shape(row), decided: out.decided, approveCount: out.tally.approveCount, rejectCount: out.tally.rejectCount, threshold: out.tally.threshold });
});

// POST /requests/:id/override — admin-only immediate approval, bypassing the
// vote. Carries the mechanical params directly. Records overriddenBy.
router.post("/requests/:id/override", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Only admins can override" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const body = req.body ?? {};
  const note = typeof body.reviewerNote === "string" && body.reviewerNote.trim() ? body.reviewerNote.trim() : null;

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, rid)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { error: blocked };
    // Allow re-overriding an already-approved (staged) request so an admin can
    // correct the mechanical params before it is closed/applied. Block once the
    // effect has been materialized (appliedRef set) or the ticket is terminal.
    const editable = reqRow.status === "pending" || reqRow.status === "changes_requested" || reqRow.status === "approved";
    if (!editable || reqRow.appliedRef) {
      return { error: { status: 409, body: { error: `Request already ${reqRow.appliedRef ? "applied" : reqRow.status}` } } };
    }
    if (reqRow.requestedById === req.user!.id) {
      return { error: { status: 403, body: { error: "You cannot override your own request" } } };
    }
    // Validate (but do not yet apply) the mechanical params, then STAGE the
    // approval. The effect is committed when the ticket is closed, reading the
    // params back from decisionParams.
    const norm = normalizeApprovalParams(reqRow.type, body);
    if ("error" in norm) return { error: { status: 400, body: { error: norm.error } } };
    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewerNote: note,
        decisionParams: norm.ok as never,
        overriddenBy: req.user!.id,
      })
      .where(eq(customRequests.id, rid));
    return { ok: { reqRow } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  // Effects deferred to close — staged-decision audit only.
  await recordAudit({
    req,
    category: auditCategoryFor(txResult.ok.reqRow.type),
    action: "request_override_approve",
    targetType: "custom_request",
    targetId: rid,
    message: `Approved ${txResult.ok.reqRow.type} request via admin override (pending close): ${txResult.ok.reqRow.title}`,
    after: { type: txResult.ok.reqRow.type, characterId: txResult.ok.reqRow.characterId, staged: true, overriddenBy: req.user!.id },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// Close a RESOLVED custom request (approved | rejected | cancelled) → archived.
// Closing an APPROVED ticket commits its effect exactly once (guarded by
// appliedRef); closing a rejected/cancelled ticket just archives it. Idempotent:
// re-closing an already-closed ticket is a 200 no-op. Materialize runs inside the
// locked txn so apply + status flip are atomic; the player DM / character note /
// inventory ledger / activity feed run after commit. The caller (review.ts) has
// already verified the actor is a reviewer.
export async function closeRequest(req: Request, id: number): Promise<ReviewActionResult> {
  const u = req.user!;
  const result = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, id)).for("update");
    if (!reqRow) return { kind: "error" as const, status: 404, body: { error: "Request not found" } };
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { kind: "error" as const, status: blocked.status, body: blocked.body };
    if (reqRow.status === "closed") return { kind: "noop" as const };
    if (reqRow.status !== "approved" && reqRow.status !== "rejected" && reqRow.status !== "cancelled") {
      return { kind: "error" as const, status: 409, body: { error: `Only a resolved ticket can be closed (this one is ${reqRow.status})` } };
    }
    if (reqRow.status === "approved" && !reqRow.appliedRef) {
      const [c] = await tx.select().from(characters).where(eq(characters.id, reqRow.characterId));
      if (!c || c.archived) return { kind: "error" as const, status: 400, body: { error: "Character is missing or archived" } };
      if (!c.ownerId) return { kind: "error" as const, status: 400, body: { error: "Character is unclaimed (no owner) — cannot apply" } };
      const params = (reqRow.decisionParams ?? ((reqRow.details ?? {}) as { approval?: ApprovalParams }).approval ?? {}) as ApprovalParams;
      const mat = await materializeRequest(tx, reqRow, c, params);
      if ("error" in mat) return { kind: "error" as const, status: mat.error.status, body: mat.error.body };
      await tx
        .update(customRequests)
        .set({ status: "closed", closedAt: new Date(), closedBy: u.id, appliedRef: mat.ok.appliedRef })
        .where(eq(customRequests.id, id));
      return { kind: "applied" as const, reqRow, c, appliedRef: mat.ok.appliedRef, summary: mat.ok.summary };
    }
    // Rejected / cancelled (or an already-applied approved row): archive only.
    await tx
      .update(customRequests)
      .set({ status: "closed", closedAt: new Date(), closedBy: u.id })
      .where(eq(customRequests.id, id));
    return { kind: "archived" as const, reqRow };
  });

  if (result.kind === "error") return { status: result.status, body: result.body };
  if (result.kind === "applied") {
    await afterApprove(req as never, result.reqRow, result.c, result.appliedRef, result.summary, result.reqRow.overriddenBy ? "override" : "vote");
    const [row] = await selectWhere(eq(customRequests.id, id));
    await notifyRequesterOfDecision(row, result.summary);
  } else if (result.kind === "archived") {
    await recordAudit({
      req,
      category: auditCategoryFor(result.reqRow.type),
      action: "request_closed",
      targetType: "custom_request",
      targetId: id,
      message: `Closed ${result.reqRow.type} request (${result.reqRow.status}): ${result.reqRow.title}`,
    });
  }
  const [row] = await selectWhere(eq(customRequests.id, id));
  return { status: 200, body: shape(row) };
}

// Reopen a RESOLVED (approved | rejected) or ARCHIVED (closed) custom request
// back to pending for another review round. Votes are cleared and the decision /
// override / decisionParams / closed fields are wiped so the normal respond /
// approve / deny tools come back.
//
// Idempotency note: `appliedRef` is PRESERVED. It is only ever set when an
// approved ticket was committed (a lease / inventory / venue was created) on
// close. Keeping it means the live effect is not orphaned, and re-closing the
// reopened ticket is a no-op archive (closeRequest only materializes when
// `approved && !appliedRef`), so reopening can never double-apply.
export async function reopenRequest(req: Request, id: number): Promise<ReviewActionResult> {
  const result = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, id)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.status !== "approved" && reqRow.status !== "rejected" && reqRow.status !== "closed") {
      return { error: { status: 409, body: { error: `Only a resolved or archived ticket can be reopened (this one is ${reqRow.status})` } } };
    }
    const det = { ...((reqRow.details ?? {}) as Record<string, unknown>) };
    delete det.approval;
    await tx
      .update(customRequests)
      .set({
        status: "pending",
        reviewedById: null,
        reviewedAt: null,
        reviewerNote: null,
        overriddenBy: null,
        decisionParams: null,
        closedAt: null,
        closedBy: null,
        details: det as never,
      })
      .where(eq(customRequests.id, id));
    await clearReviewVotes({ subjectType: "request", subjectId: id, conn: tx });
    return { ok: { reqRow } };
  });
  if ("error" in result && result.error) return result.error;
  await recordAudit({
    req,
    category: auditCategoryFor(result.ok.reqRow.type),
    action: "request_reopened",
    targetType: "custom_request",
    targetId: id,
    message: `Reopened ${result.ok.reqRow.type} request: ${result.ok.reqRow.title}`,
  });
  const [row] = await selectWhere(eq(customRequests.id, id));
  return { status: 200, body: shape(row) };
}

// POST /requests/:id/request-changes — RETIRED. Reviewers no longer park
// requests in a blocking `changes_requested` state; the /review comment thread
// is non-blocking communication and never gates approval. Legacy rows already
// in `changes_requested` still resubmit normally. Endpoint kept registered so
// stale clients get a clear 410 rather than a 404.
router.post("/requests/:id/request-changes", requireAuth, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Request-changes is retired. Use the comment thread; it never blocks approval." });
});

// PATCH /requests/:id — the requester (or admin) edits the request while it is
// still in their hands (pending or changes_requested). Mechanical/owner fields
// only; status is untouched here (resubmit flips it back to the queue).
router.patch("/requests/:id", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, rid));
  if (!reqRow) { res.status(404).json({ error: "Request not found" }); return; }
  if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
    res.status(403).json({ error: "Only the requester can edit this request" });
    return;
  }
  if (reqRow.status !== "pending" && reqRow.status !== "changes_requested") {
    res.status(409).json({ error: `Request is ${reqRow.status} and can no longer be edited` });
    return;
  }
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.description === "string") patch.description = body.description.trim() || null;
  if (typeof body.imageUrl === "string") patch.imageUrl = body.imageUrl.trim() || null;
  // Venue purpose/location live in details — merge, never clobber approval.
  if (isVenueType(reqRow.type) && (typeof body.purpose === "string" || typeof body.location === "string")) {
    const det = (reqRow.details ?? {}) as Record<string, unknown>;
    patch.details = {
      ...det,
      ...(typeof body.purpose === "string" ? { purpose: body.purpose.trim() } : {}),
      ...(typeof body.location === "string" ? { location: body.location.trim() } : {}),
    } as never;
  }
  if (Object.keys(patch).length === 0) {
    const [row] = await selectWhere(eq(customRequests.id, rid));
    res.json(shape(row));
    return;
  }
  await db.update(customRequests).set(patch).where(eq(customRequests.id, rid));
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// POST /requests/:id/resubmit — the requester sends a changes_requested
// request back to the review queue. Votes are cleared so the next round starts
// fresh; resubmitting with no further edits is allowed.
router.post("/requests/:id/resubmit", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, rid));
  if (!reqRow) { res.status(404).json({ error: "Request not found" }); return; }
  if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
    res.status(403).json({ error: "Only the requester can resubmit" });
    return;
  }
  if (reqRow.status !== "changes_requested") {
    res.status(409).json({ error: `Request is ${reqRow.status}, not awaiting changes` });
    return;
  }
  // Atomic: only flip back to pending (and clear votes) if the row is STILL
  // changes_requested. A concurrent admin override could otherwise have already
  // approved + materialized it; flipping it back to pending here would let a
  // later vote materialize it a SECOND time.
  const ok = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(customRequests)
      .set({ status: "pending", reviewedById: null, reviewedAt: null, reviewerNote: null })
      .where(and(eq(customRequests.id, rid), eq(customRequests.status, "changes_requested")))
      .returning();
    if (!changed) return false;
    await clearReviewVotes({ subjectType: "request", subjectId: rid, conn: tx });
    return true;
  });
  if (!ok) { res.status(409).json({ error: "Request is no longer awaiting changes" }); return; }
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// Venue-owner decision on a fixer/admin-proposed `stock_cost` request. Unlike
// the staff approve/reject above, this is gated to the VENUE OWNER (the
// requestedById) — or an admin acting on their behalf. Approving debits the
// venue balance and adds the stock atomically (FOR UPDATE lock + status guard
// keep it idempotent and crash-safe); rejecting moves nothing.
router.post("/requests/:id/stock-decision", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const decision = String(req.body?.decision ?? "");
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    return;
  }
  const note =
    typeof req.body?.reviewerNote === "string" && req.body.reviewerNote.trim()
      ? req.body.reviewerNote.trim()
      : null;

  type StockDetails = {
    kind: "store" | "ripperdoc";
    venueId: number;
    venueName?: string;
    catalogId?: number;
    name: string;
    category: string | null;
    qty: number;
    unitCost: number;
    totalCost: number;
    retail: number;
    requestedByFixerId?: string;
    requestedByFixerName?: string;
  };

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(customRequests)
      .where(eq(customRequests.id, rid))
      .for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.type !== "stock_cost") {
      return { error: { status: 400, body: { error: "Not a stock-cost request" } } };
    }
    const det = (reqRow.details ?? {}) as StockDetails;
    // Authorize against the venue's CURRENT owner, not the stored requestedById:
    // if the venue was reassigned after the request was created, the old owner
    // must no longer be able to approve spending the new owner's balance.
    const ownerVenueTable = det.kind === "store" ? stores : ripperdocs;
    const [ownerVenue] = await tx
      .select({ ownerId: ownerVenueTable.ownerId })
      .from(ownerVenueTable)
      .where(eq(ownerVenueTable.id, det.venueId));
    if (!ownerVenue) {
      return { error: { status: 404, body: { error: "Venue no longer exists" } } };
    }
    // Only the venue's current owner or an admin may decide.
    if (ownerVenue.ownerId !== req.user!.id && !isAdmin(req.user!)) {
      return { error: { status: 403, body: { error: "Only the venue owner can decide this request" } } };
    }
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }

    if (decision === "reject") {
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date(), reviewerNote: note })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow, det, decision, newBalance: null as number | null } };
    }

    // Approve: guarded venue debit + stock merge/insert + ledger, all atomic.
    const venueTable = det.kind === "store" ? stores : ripperdocs;
    const stockTable = det.kind === "store" ? storeStock : ripperdocStock;
    const stockVenueCol = det.kind === "store" ? storeStock.storeId : ripperdocStock.ripperdocId;
    const totalCost = Math.max(0, Math.round(Number(det.totalCost) || 0));
    const qty = Math.max(1, Math.round(Number(det.qty) || 1));
    const retail = Math.max(0, Math.round(Number(det.retail) || 0));

    const [debited] = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} - ${totalCost}` })
      .where(and(eq(venueTable.id, det.venueId), gte(venueTable.balance, totalCost)))
      .returning();
    if (!debited) {
      return { error: { status: 400, body: { error: "Venue account has insufficient funds" } } };
    }
    const newBalance = debited.balance;
    const previousBalance = newBalance + totalCost;

    const [existing] = await tx
      .select()
      .from(stockTable)
      .where(and(eq(stockVenueCol, det.venueId), eq(stockTable.name, det.name)));
    let stockId: number;
    if (existing) {
      const [u] = await tx
        .update(stockTable)
        .set({ quantity: existing.quantity + qty, price: retail, category: existing.category ?? det.category })
        .where(eq(stockTable.id, existing.id))
        .returning();
      stockId = u.id;
    } else {
      const [ins] = await tx
        .insert(stockTable)
        .values({
          [det.kind === "store" ? "storeId" : "ripperdocId"]: det.venueId,
          name: det.name,
          category: det.category,
          price: retail,
          quantity: qty,
        } as never)
        .returning();
      stockId = ins.id;
    }

    await tx.insert(walletTransactions).values({
      storeId: det.kind === "store" ? det.venueId : null,
      ripperdocId: det.kind === "ripperdoc" ? det.venueId : null,
      amount: -totalCost,
      kind: "stock_purchase",
      source: det.kind,
      counterpartyName: "Catalog (fixer-stocked)",
      memo: `Bought ${det.name} x${qty} @ €$${det.unitCost} (approved fixer stocking)`,
      previousBalance,
      newBalance,
    });

    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewerNote: note,
        appliedRef: `${det.kind}-stock:${stockId}`,
      })
      .where(eq(customRequests.id, rid));

    return { ok: { reqRow, det, decision, newBalance } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { det, decision: dec } = txResult.ok;
  // Activity feed + fixer DM, best-effort (decision already committed).
  try {
    await db.insert(activityEvents).values({
      kind: "shop",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message:
        dec === "approve"
          ? `${det.venueName ?? "Venue"} approved stocking ${det.name} x${det.qty} (€$${det.totalCost})`
          : `${det.venueName ?? "Venue"} rejected stocking ${det.name} x${det.qty}`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "stock-decision activity-feed write failed");
  }
  if (det.requestedByFixerId) {
    try {
      const [fixer] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, det.requestedByFixerId));
      if (fixer?.discordId) {
        await sendDirectMessage(
          fixer.discordId,
          dec === "approve"
            ? `Your proposal to stock "${det.venueName ?? "the venue"}" with ${det.name} x${det.qty} was approved.`
            : `Your proposal to stock "${det.venueName ?? "the venue"}" with ${det.name} x${det.qty} was rejected.${note ? `\nReason: ${note}` : ""}`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: rid }, "stock-decision fixer DM failed");
    }
  }
  await recordAudit({
    req,
    category: "shop",
    action: dec === "approve" ? "stock_cost_approve" : "stock_cost_reject",
    targetType: "custom_request",
    targetId: rid,
    message: `${dec === "approve" ? "Approved" : "Rejected"} stocking ${det.name} x${det.qty} for ${det.venueName ?? "venue"}`,
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// The invited character's player (or an admin) accepts or denies an
// `employee_invite`. Gated to the requestedById (the invited player) or admin.
// Accepting inserts the venue employee row (idempotent against a double-accept)
// and marks the request approved; denying marks it rejected. FOR UPDATE +
// pending guard keep concurrent accept/deny crash-safe.
router.post("/requests/:id/employee-decision", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const decision = String(req.body?.decision ?? "");
  if (decision !== "accept" && decision !== "deny") {
    res.status(400).json({ error: 'decision must be "accept" or "deny"' });
    return;
  }

  type InviteDetails = {
    kind: "store" | "ripperdoc";
    venueId: number;
    venueName?: string;
    role?: string;
    commissionPct?: number;
    invitedById?: string;
    invitedByName?: string;
  };

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(customRequests)
      .where(eq(customRequests.id, rid))
      .for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.type !== "employee_invite") {
      return { error: { status: 400, body: { error: "Not an employee invitation" } } };
    }
    // Only the invited player (requestedById) or an admin may decide.
    if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
      return { error: { status: 403, body: { error: "Only the invited player can decide this invitation" } } };
    }
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Invitation already ${reqRow.status}` } } };
    }
    const det = (reqRow.details ?? {}) as InviteDetails;

    if (decision === "deny") {
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date() })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow, det, decision, employeeId: null as number | null } };
    }

    // Accept: confirm the venue still exists, then insert the employee row
    // (skip if somehow already employed) and approve the invite.
    const venueTable = det.kind === "store" ? stores : ripperdocs;
    const [venue] = await tx
      .select({ id: venueTable.id })
      .from(venueTable)
      .where(eq(venueTable.id, det.venueId));
    if (!venue) {
      return { error: { status: 404, body: { error: "Venue no longer exists" } } };
    }
    const empTable = det.kind === "store" ? storeEmployees : ripperdocEmployees;
    const empVenueCol = det.kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;
    const [existing] = await tx
      .select({ id: empTable.id })
      .from(empTable)
      .where(and(eq(empVenueCol, det.venueId), eq(empTable.characterId, reqRow.characterId)));
    let employeeId: number;
    if (existing) {
      employeeId = existing.id;
    } else {
      const [emp] = await tx
        .insert(empTable)
        .values({
          [det.kind === "store" ? "storeId" : "ripperdocId"]: det.venueId,
          characterId: reqRow.characterId,
          role: det.role || (det.kind === "store" ? "clerk" : "doc"),
          commissionPct: clampPct(det.commissionPct),
        } as never)
        .returning();
      employeeId = emp.id;
    }
    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        appliedRef: `${det.kind}-employee:${employeeId}`,
      })
      .where(eq(customRequests.id, rid));
    return { ok: { reqRow, det, decision, employeeId } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow, det, decision: dec } = txResult.ok;
  const venueName = det.venueName ?? "the venue";
  const [charRow] = await db
    .select({ name: characters.name })
    .from(characters)
    .where(eq(characters.id, reqRow.characterId));
  const charName = charRow?.name ?? "A character";
  // Activity feed + DM the inviting owner, best-effort (decision committed).
  try {
    await db.insert(activityEvents).values({
      kind: dec === "accept" ? "request_approved" : "request_rejected",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message:
        dec === "accept"
          ? `${charName} accepted the invitation to work at ${venueName}`
          : `${charName} declined the invitation to work at ${venueName}`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "employee-decision activity-feed write failed");
  }
  if (det.invitedById) {
    try {
      const [owner] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, det.invitedById));
      if (owner?.discordId) {
        await sendDirectMessage(
          owner.discordId,
          dec === "accept"
            ? `${charName} accepted your invitation to work at ${venueName}.`
            : `${charName} declined your invitation to work at ${venueName}.`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: rid }, "employee-decision owner DM failed");
    }
  }
  await recordAudit({
    req,
    category: "shop",
    action: dec === "accept" ? "employee_invite_accept" : "employee_invite_deny",
    targetType: "custom_request",
    targetId: rid,
    message:
      dec === "accept"
        ? `${charName} accepted employment at ${venueName}`
        : `${charName} declined employment at ${venueName}`,
    after: { kind: det.kind, venueId: det.venueId, employeeId: txResult.ok.employeeId },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// The assigned character's player (or an admin) approves or declines a fixer's
// mission assignment. Approving leaves the mission_assignment row in place;
// declining removes the (unpaid) assignment so the player is no longer on the
// roster. Gated to the requestedById (the owning player) or admin. FOR UPDATE +
// pending guard keep concurrent approve/decline crash-safe.
router.post("/requests/:id/participation-decision", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const decision = String(req.body?.decision ?? "");
  if (decision !== "accept" && decision !== "deny") {
    res.status(400).json({ error: 'decision must be "accept" or "deny"' });
    return;
  }

  type ParticipationDetails = {
    missionId: number;
    missionTitle?: string;
    characterId?: number;
    characterName?: string;
    invitedById?: string;
    invitedByName?: string;
  };

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(customRequests)
      .where(eq(customRequests.id, rid))
      .for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.type !== "mission_participation") {
      return { error: { status: 400, body: { error: "Not a mission-participation request" } } };
    }
    // Authorize against the character's CURRENT owner (not the snapshotted
    // requestedById), so a post-creation ownership transfer can't let a stale
    // owner decide. Admins may always decide.
    const [charOwner] = await tx
      .select({ ownerId: characters.ownerId })
      .from(characters)
      .where(eq(characters.id, reqRow.characterId));
    if (charOwner?.ownerId !== req.user!.id && !isAdmin(req.user!)) {
      return { error: { status: 403, body: { error: "Only the assigned character's player can decide this request" } } };
    }
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    const det = (reqRow.details ?? {}) as ParticipationDetails;

    if (decision === "deny") {
      // Drop the (unpaid) assignment so the player is removed from the roster.
      if (Number.isFinite(Number(det.missionId))) {
        await tx
          .delete(missionAssignments)
          .where(
            and(
              eq(missionAssignments.missionId, Number(det.missionId)),
              eq(missionAssignments.characterId, reqRow.characterId),
              eq(missionAssignments.paymentStatus, "unpaid"),
            ),
          );
      }
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date() })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow, det, decision } };
    }

    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        appliedRef: `mission:${det.missionId}`,
      })
      .where(eq(customRequests.id, rid));
    return { ok: { reqRow, det, decision } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow, det, decision: dec } = txResult.ok;
  const missionTitle = det.missionTitle ?? "a mission";
  const [charRow] = await db
    .select({ name: characters.name })
    .from(characters)
    .where(eq(characters.id, reqRow.characterId));
  const charName = charRow?.name ?? det.characterName ?? "A character";
  // Activity feed + DM the assigning fixer, best-effort (decision committed).
  try {
    await db.insert(activityEvents).values({
      kind: dec === "accept" ? "request_approved" : "request_rejected",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message:
        dec === "accept"
          ? `${charName} accepted the assignment to "${missionTitle}"`
          : `${charName} declined the assignment to "${missionTitle}"`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "participation-decision activity-feed write failed");
  }
  if (det.invitedById) {
    try {
      const [fixer] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, det.invitedById));
      if (fixer?.discordId) {
        await sendDirectMessage(
          fixer.discordId,
          dec === "accept"
            ? `${charName} accepted the assignment to "${missionTitle}".`
            : `${charName} declined the assignment to "${missionTitle}".`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: rid }, "participation-decision fixer DM failed");
    }
  }
  await recordAudit({
    req,
    category: "mission",
    action: dec === "accept" ? "mission_participation_accept" : "mission_participation_deny",
    targetType: "custom_request",
    targetId: rid,
    message:
      dec === "accept"
        ? `${charName} accepted participation in "${missionTitle}"`
        : `${charName} declined participation in "${missionTitle}"`,
    after: { missionId: det.missionId, characterId: reqRow.characterId },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

export default router;
