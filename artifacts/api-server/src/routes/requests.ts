import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  customRequests,
  characters,
  users,
  inventoryItems,
  housing,
  characterUpdates,
  activityEvents,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage } from "../lib/discord";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";

// Off-catalog "miscellaneous" requests: off-map property, custom guns, and
// custom cyberware. Staff triage these in the unified Pending Requests page;
// approving one auto-applies it (creates a housing lease or an inventory item).
// See lib/db schema `custom_requests` for the data model and idempotency marker.

const REQUEST_TYPES = ["property", "gun", "cyberware"] as const;
type RequestType = (typeof REQUEST_TYPES)[number];

function isFixerOrAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN") || hasRole(user.roles, "FIXER");
}

function isAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN");
}

// First-of-next-month at 00:00 UTC — initial paid_through so a new lease is
// paid up for the current month until the monthly_rent cron rolls it forward.
// Mirrors housing.ts endOfCurrentMonth.
function endOfCurrentMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
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
  details: unknown;
  status: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewerNote: string | null;
  appliedRef: string | null;
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
    details: row.details ?? null,
    status: row.status,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewerNote: row.reviewerNote,
    appliedRef: row.appliedRef,
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
      details: customRequests.details,
      status: customRequests.status,
      reviewedById: customRequests.reviewedById,
      reviewedAt: customRequests.reviewedAt,
      reviewerNote: customRequests.reviewerNote,
      appliedRef: customRequests.appliedRef,
      createdAt: customRequests.createdAt,
    })
    .from(customRequests)
    .innerJoin(characters, eq(characters.id, customRequests.characterId))
    .innerJoin(users, eq(users.id, customRequests.requestedById))
    .where(predicate)
    .orderBy(desc(customRequests.createdAt))) as RequestRow[];
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
    const typeLabel =
      row.type === "property" ? "off-map property" : row.type === "gun" ? "custom gun" : "custom cyberware";
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
  const { type, characterId, title, description } = req.body ?? {};
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
  const [inserted] = await db
    .insert(customRequests)
    .values({
      type: reqType,
      characterId: cid,
      requestedById: req.user!.id,
      title: String(title).trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : null,
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
  res.json(rows.map(shape));
});

// Staff: list requests across all players. Defaults to pending. Fixer/admin.
router.get("/requests", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const status = String(req.query.status ?? "pending");
  const rows = await selectWhere(eq(customRequests.status, status));
  res.json(rows.map(shape));
});

// Staff approve with mechanical details; auto-applies by type inside a txn.
// Idempotent: a FOR UPDATE lock plus the status guard prevent double-apply,
// and appliedRef records what was materialized.
router.post("/requests/:id/approve", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const body = req.body ?? {};
  const reviewerNote = typeof body.reviewerNote === "string" && body.reviewerNote.trim() ? body.reviewerNote.trim() : null;

  const txResult = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT * FROM custom_requests WHERE id = ${rid} FOR UPDATE`);
    const reqRow = (locked.rows ?? locked)[0] as typeof customRequests.$inferSelect | undefined;
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    const [c] = await tx.select().from(characters).where(eq(characters.id, reqRow.characterId));
    if (!c || c.archived) {
      return { error: { status: 400, body: { error: "Character is missing or archived" } } };
    }
    if (!c.ownerId) {
      return { error: { status: 400, body: { error: "Character is unclaimed (no owner) — cannot apply" } } };
    }

    let appliedRef: string;
    let summary: string;

    if (reqRow.type === "property") {
      const monthlyRent = parseInt(String(body.monthlyRent), 10);
      if (!Number.isFinite(monthlyRent) || monthlyRent < 0) {
        return { error: { status: 400, body: { error: "monthlyRent (>= 0) required to approve a property request" } } };
      }
      const kind = body.kind === "business" ? "business" : "residential";
      if (!c.approved) {
        return { error: { status: 400, body: { error: "Character is not approved; cannot bill rent" } } };
      }
      const [lease] = await tx
        .insert(housing)
        .values({
          characterId: reqRow.characterId,
          listingId: null,
          address: reqRow.title,
          monthlyRent,
          paidThrough: endOfCurrentMonth(),
          notes: reqRow.description ?? null,
          kind,
        })
        .returning();
      appliedRef = `housing:${lease.id}`;
      summary = `Off-map property approved: ${reqRow.title} (€$${monthlyRent.toLocaleString()}/mo, ${kind})`;
    } else if (reqRow.type === "gun") {
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
      appliedRef = `inventory:${item.instanceUuid}`;
      summary = `Custom gun approved: ${reqRow.title}`;
    } else if (reqRow.type === "cyberware") {
      const cwp = Number(body.cwp);
      if (!Number.isFinite(cwp) || cwp < 0) {
        return { error: { status: 400, body: { error: "cwp (>= 0) required to approve a cyberware request" } } };
      }
      // Cyberware billing derives CWP from a "CWP <n>" token in notes — stamp
      // it so the chrome band counts this piece.
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
      appliedRef = `inventory:${item.instanceUuid}`;
      summary = `Custom cyberware approved: ${reqRow.title} (CWP ${cwp})`;
    } else {
      return { error: { status: 400, body: { error: `Unknown request type ${reqRow.type}` } } };
    }

    await tx.update(customRequests).set({
      status: "approved",
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
      reviewerNote,
      appliedRef,
    }).where(eq(customRequests.id, rid));

    return { ok: { reqRow, c, summary, appliedRef } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow, c, summary } = txResult.ok;
  await db.insert(characterUpdates).values({
    characterId: reqRow.characterId,
    authorId: req.user!.id,
    note: summary,
  });
  await db.insert(activityEvents).values({
    kind: "request_approved",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${c.name}: ${summary}`,
  });
  if (reqRow.type === "gun" || reqRow.type === "cyberware") {
    await recordInventoryEvent({
      instanceUuid: txResult.ok.appliedRef.replace("inventory:", ""),
      kind: "created",
      actorId: req.user!.id,
      actorName: req.user!.username,
      toCharacterId: c.id,
      toCharacterName: c.name,
      itemName: reqRow.title,
      quantity: 1,
      reason: `Approved ${reqRow.type} request`,
    });
  }
  await recordAudit({
    req,
    category: reqRow.type === "property" ? "housing" : "inventory",
    action: "request_approve",
    targetType: "custom_request",
    targetId: rid,
    message: summary,
    after: { type: reqRow.type, characterId: reqRow.characterId, appliedRef: txResult.ok.appliedRef },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  await notifyRequesterOfDecision(row, txResult.ok.summary);
  res.json(shape(row));
});

// Staff reject — records the decision only, applies nothing.
router.post("/requests/:id/reject", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Requires fixer or admin role" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const note = typeof req.body?.reviewerNote === "string" && req.body.reviewerNote.trim() ? req.body.reviewerNote.trim() : null;

  // Lock the row and guard on pending status so a concurrent approve can't be
  // clobbered: if approve commits first, the FOR UPDATE read sees "approved"
  // and we 409 instead of overwriting an already-applied request.
  const txResult = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT * FROM custom_requests WHERE id = ${rid} FOR UPDATE`);
    const reqRow = (locked.rows ?? locked)[0] as typeof customRequests.$inferSelect | undefined;
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    await tx.update(customRequests).set({
      status: "rejected",
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
      reviewerNote: note,
    }).where(eq(customRequests.id, rid));
    return { ok: { reqRow } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow } = txResult.ok;
  await recordAudit({
    req,
    category: reqRow.type === "property" ? "housing" : "inventory",
    action: "request_reject",
    targetType: "custom_request",
    targetId: rid,
    message: `Rejected ${reqRow.type} request: ${reqRow.title}`,
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  // Mirror the approve path: surface rejections in the global activity feed.
  // Best-effort — the decision is already committed, so a feed-write failure
  // must not fail the endpoint.
  const typeLabel =
    reqRow.type === "property" ? "off-map property" : reqRow.type === "gun" ? "custom gun" : "custom cyberware";
  try {
    await db.insert(activityEvents).values({
      kind: "request_rejected",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${row.characterName ?? "(unknown)"}: Rejected ${typeLabel} request: ${reqRow.title}`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "reject activity-feed write failed");
  }
  await notifyRequesterOfDecision(row, null);
  res.json(shape(row));
});

export default router;
