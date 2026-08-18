import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  events,
  eventTicketTypes,
  eventTickets,
  eventCheckinStaff,
  users,
  walletTransactions,
  type Event,
  type EventTicketType,
} from "@workspace/db";
import { applyWalletDelta } from "./economy";
import { sendDirectMessage } from "./discord";
import { logger } from "./logger";

// ===========================================================================
// Event tickets: fixers define ticket types on an event, players buy them with
// UB money, designated check-in staff mark holders attended at the door.
//
// Money rules (reuses the wallet ledger idempotency contract in economy.ts):
//  - Buyer debit + runner credit are separate applyWalletDelta legs, each keyed
//    on the TICKET row id, so retries/double-clicks can never apply twice.
//  - "sink" payout mode has NO credit leg — the debit burns the eddies out of
//    circulation (counterparty "Night City Bot"), mirroring the wallet sink.
//  - A failed runner credit NEVER strands the buyer's purchase: the ticket is
//    kept (payoutStatus "failed") and a manager can retry the credit with the
//    same idempotency key without re-charging the buyer.
// Tickets are ACCOUNT-level (buyerUserId) by product decision — no characterId.
// ===========================================================================

export const TICKET_PAYOUT_MODES = ["runner", "sink"] as const;
export type TicketPayoutMode = (typeof TICKET_PAYOUT_MODES)[number];
export function isTicketPayoutMode(v: unknown): v is TicketPayoutMode {
  return typeof v === "string" && (TICKET_PAYOUT_MODES as readonly string[]).includes(v);
}

const SINK_NAME = "Night City Bot";

// Ticket states that consume capacity. "pending" rows are in-flight purchases
// (reserved before the buyer debit) so the last ticket can't be double-sold.
const CAPACITY_STATUSES = ["pending", "purchased"] as const;

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function displayName(u: { globalName: string | null; username: string | null } | undefined | null): string | null {
  if (!u) return null;
  return u.globalName || u.username || null;
}

export type TicketResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; httpStatus: number; error: string };

// ---------------------------------------------------------------------------
// Ticket type views (public: everyone sees price/remaining on the event page)
// ---------------------------------------------------------------------------
export interface TicketTypeView {
  id: number;
  name: string;
  description: string | null;
  price: number;
  quantity: number; // 0 = unlimited
  sold: number;
  remaining: number | null; // null = unlimited
  soldOut: boolean;
  archived: boolean;
  sortOrder: number;
}

export async function listTicketTypeViews(eventId: number): Promise<TicketTypeView[]> {
  const types = await db
    .select()
    .from(eventTicketTypes)
    .where(eq(eventTicketTypes.eventId, eventId))
    .orderBy(asc(eventTicketTypes.sortOrder), asc(eventTicketTypes.id));
  if (types.length === 0) return [];
  const counts = await db
    .select({ ticketTypeId: eventTickets.ticketTypeId, n: sql<number>`count(*)::int` })
    .from(eventTickets)
    .where(
      and(
        eq(eventTickets.eventId, eventId),
        inArray(eventTickets.status, [...CAPACITY_STATUSES]),
      ),
    )
    .groupBy(eventTickets.ticketTypeId);
  const soldByType = new Map(counts.map((c) => [c.ticketTypeId, c.n]));
  return types.map((t) => {
    const sold = soldByType.get(t.id) ?? 0;
    const remaining = t.quantity > 0 ? Math.max(0, t.quantity - sold) : null;
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      price: t.price,
      quantity: t.quantity,
      sold,
      remaining,
      soldOut: t.quantity > 0 && sold >= t.quantity,
      archived: t.archived,
      sortOrder: t.sortOrder,
    };
  });
}

// ---------------------------------------------------------------------------
// Ticket type upsert (folded into event create/PATCH; manager-only at route)
// ---------------------------------------------------------------------------
export interface TicketTypeInput {
  id?: number | null; // existing type to update; absent = create
  name: string;
  description: string | null;
  price: number;
  quantity: number; // 0 = unlimited
  sortOrder: number;
}

export function parseTicketTypeInputs(raw: unknown): TicketTypeInput[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "ticketTypes must be an array" };
  if (raw.length > 25) return { error: "At most 25 ticket types per event" };
  const out: TicketTypeInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown>;
    if (!t || typeof t !== "object") return { error: `ticketTypes[${i}] must be an object` };
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) return { error: `ticketTypes[${i}].name is required` };
    const price = Number(t.price);
    if (!Number.isInteger(price) || price < 0) return { error: `ticketTypes[${i}].price must be a non-negative integer` };
    const quantity = Number(t.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity < 0) return { error: `ticketTypes[${i}].quantity must be a non-negative integer (0 = unlimited)` };
    let id: number | null = null;
    if (t.id !== undefined && t.id !== null) {
      id = Number(t.id);
      if (!Number.isInteger(id)) return { error: `ticketTypes[${i}].id must be an integer` };
    }
    out.push({
      id,
      name: name.slice(0, 100),
      description: typeof t.description === "string" && t.description.trim() ? t.description.trim().slice(0, 1000) : null,
      price,
      quantity,
      sortOrder: i,
    });
  }
  return out;
}

// Replace-set semantics: update matching ids, create new entries, and remove
// omitted ones — hard-delete when nothing ever sold, archive (stop selling,
// keep sold tickets labelled) when tickets exist.
export async function upsertTicketTypes(eventId: number, inputs: TicketTypeInput[]): Promise<TicketResult> {
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(eventTicketTypes)
      .where(eq(eventTicketTypes.eventId, eventId));
    const byId = new Map(existing.map((t) => [t.id, t]));
    const keepIds = new Set<number>();

    for (const input of inputs) {
      if (input.id != null) {
        const cur = byId.get(input.id);
        if (!cur) {
          return { ok: false as const, httpStatus: 400, error: `Ticket type ${input.id} does not belong to this event` };
        }
        keepIds.add(input.id);
        // Guard: never let quantity drop below tickets already sold/reserved —
        // that would wedge the type as soldOut with no way for holders to see
        // accurate remaining counts. (0 = unlimited is always allowed.)
        if (input.quantity > 0) {
          const [{ n }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(eventTickets)
            .where(and(eq(eventTickets.ticketTypeId, input.id), inArray(eventTickets.status, [...CAPACITY_STATUSES])));
          if (input.quantity < n) {
            return {
              ok: false as const,
              httpStatus: 400,
              error: `Ticket type "${input.name}" already has ${n} sold — quantity can't be set below that (use 0 for unlimited)`,
            };
          }
        }
        await tx
          .update(eventTicketTypes)
          .set({
            name: input.name,
            description: input.description,
            price: input.price,
            quantity: input.quantity,
            sortOrder: input.sortOrder,
            archived: false,
          })
          .where(eq(eventTicketTypes.id, input.id));
      } else {
        const [created] = await tx
          .insert(eventTicketTypes)
          .values({
            eventId,
            name: input.name,
            description: input.description,
            price: input.price,
            quantity: input.quantity,
            sortOrder: input.sortOrder,
          })
          .returning({ id: eventTicketTypes.id });
        keepIds.add(created.id);
      }
    }

    const removed = existing.filter((t) => !keepIds.has(t.id));
    for (const t of removed) {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(eventTickets)
        .where(eq(eventTickets.ticketTypeId, t.id));
      if (n > 0) {
        await tx.update(eventTicketTypes).set({ archived: true }).where(eq(eventTicketTypes.id, t.id));
      } else {
        await tx.delete(eventTicketTypes).where(eq(eventTicketTypes.id, t.id));
      }
    }
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Ticket views
// ---------------------------------------------------------------------------
export interface TicketView {
  id: number;
  eventId: number;
  ticketTypeId: number;
  ticketTypeName: string;
  buyerUserId: string;
  buyerName: string | null;
  pricePaid: number;
  status: string;
  payoutStatus: string;
  payoutError: string | null;
  attendedAt: string | null;
  attendedByName: string | null;
  refundedAt: string | null;
  createdAt: string | null;
  // Live event details (never snapshotted — edits propagate automatically).
  eventTitle: string;
  eventStartAt: string;
  eventEndAt: string;
  eventLocation: string | null;
  eventStatus: string;
}

interface TicketRowFilters {
  eventId?: number;
  buyerUserId?: string;
  ticketId?: number;
}

async function loadTicketViews(filters: TicketRowFilters): Promise<TicketView[]> {
  const attendedBy = alias(users, "attended_by");
  const conds = [];
  if (filters.eventId !== undefined) conds.push(eq(eventTickets.eventId, filters.eventId));
  if (filters.buyerUserId !== undefined) conds.push(eq(eventTickets.buyerUserId, filters.buyerUserId));
  if (filters.ticketId !== undefined) conds.push(eq(eventTickets.id, filters.ticketId));
  const rows = await db
    .select({
      t: eventTickets,
      typeName: eventTicketTypes.name,
      buyerGlobalName: users.globalName,
      buyerUsername: users.username,
      e: events,
      attendedByGlobalName: attendedBy.globalName,
      attendedByUsername: attendedBy.username,
    })
    .from(eventTickets)
    .innerJoin(eventTicketTypes, eq(eventTicketTypes.id, eventTickets.ticketTypeId))
    .innerJoin(events, eq(events.id, eventTickets.eventId))
    .leftJoin(users, eq(users.id, eventTickets.buyerUserId))
    .leftJoin(attendedBy, eq(attendedBy.id, eventTickets.attendedById))
    .where(and(...conds))
    .orderBy(desc(eventTickets.createdAt));
  return rows.map((r) => ({
    id: r.t.id,
    eventId: r.t.eventId,
    ticketTypeId: r.t.ticketTypeId,
    ticketTypeName: r.typeName,
    buyerUserId: r.t.buyerUserId,
    buyerName: displayName({ globalName: r.buyerGlobalName, username: r.buyerUsername }),
    pricePaid: r.t.pricePaid,
    status: r.t.status,
    payoutStatus: r.t.payoutStatus,
    payoutError: r.t.payoutError,
    attendedAt: iso(r.t.attendedAt),
    attendedByName: displayName({
      globalName: r.attendedByGlobalName ?? null,
      username: r.attendedByUsername ?? null,
    }),
    refundedAt: iso(r.t.refundedAt),
    createdAt: iso(r.t.createdAt),
    eventTitle: r.e.title,
    eventStartAt: iso(r.e.startAt)!,
    eventEndAt: iso(r.e.endAt)!,
    eventLocation: r.e.location,
    eventStatus: r.e.status,
  }));
}

// Purchaser roster for an event (managers + designated check-in staff).
// Pending rows are transient reservation artifacts — hide them.
export async function listEventTickets(eventId: number): Promise<TicketView[]> {
  const rows = await loadTicketViews({ eventId });
  return rows.filter((t) => t.status !== "pending");
}

// "My Tickets" — every non-pending ticket the user ever bought, past and future.
export async function listMyTickets(userId: string): Promise<TicketView[]> {
  const rows = await loadTicketViews({ buyerUserId: userId });
  return rows.filter((t) => t.status !== "pending");
}

// ---------------------------------------------------------------------------
// Check-in staff
// ---------------------------------------------------------------------------
export interface CheckinStaffView {
  userId: string;
  userName: string | null;
}

export async function listCheckinStaff(eventId: number): Promise<CheckinStaffView[]> {
  const rows = await db
    .select({ userId: eventCheckinStaff.userId, globalName: users.globalName, username: users.username })
    .from(eventCheckinStaff)
    .leftJoin(users, eq(users.id, eventCheckinStaff.userId))
    .where(eq(eventCheckinStaff.eventId, eventId));
  return rows.map((r) => ({ userId: r.userId, userName: displayName(r) }));
}

export async function isCheckinStaff(eventId: number, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: eventCheckinStaff.id })
    .from(eventCheckinStaff)
    .where(and(eq(eventCheckinStaff.eventId, eventId), eq(eventCheckinStaff.userId, userId)));
  return !!row;
}

// Replace-set the check-in staff list (manager-only at route).
export async function setCheckinStaff(
  eventId: number,
  userIds: string[],
  addedById: string,
): Promise<TicketResult> {
  const unique = [...new Set(userIds)];
  if (unique.length > 50) return { ok: false, httpStatus: 400, error: "At most 50 check-in staff per event" };
  if (unique.length) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, unique));
    if (found.length !== unique.length) {
      return { ok: false, httpStatus: 400, error: "One or more selected users do not exist" };
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(eventCheckinStaff).where(eq(eventCheckinStaff.eventId, eventId));
    if (unique.length) {
      await tx
        .insert(eventCheckinStaff)
        .values(unique.map((userId) => ({ eventId, userId, addedById })))
        .onConflictDoNothing();
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------
export interface PurchaseOutcome {
  ticket: TicketView;
  walletStatus: string; // synced | dry_run | free
}

export async function purchaseTicket(opts: {
  eventId: number;
  ticketTypeId: number;
  buyer: { id: string; discordId: string };
}): Promise<TicketResult<PurchaseOutcome>> {
  const { eventId, ticketTypeId, buyer } = opts;
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) return { ok: false, httpStatus: 404, error: "Event not found" };
  if (event.status !== "scheduled") {
    return { ok: false, httpStatus: 409, error: "Tickets are only sold for scheduled events" };
  }

  // 1) Reserve: lock the ticket type, re-check capacity UNDER the lock, and
  //    insert a pending ticket row. The pending row consumes capacity so a
  //    concurrent buyer of the last ticket loses the re-count, not the money.
  const reserved = await db.transaction(
    async (tx): Promise<{ ok: true; ticketId: number; type: EventTicketType } | { ok: false; httpStatus: number; error: string }> => {
      const [type] = await tx
        .select()
        .from(eventTicketTypes)
        .where(and(eq(eventTicketTypes.id, ticketTypeId), eq(eventTicketTypes.eventId, eventId)))
        .for("update");
      if (!type) return { ok: false, httpStatus: 404, error: "Ticket type not found" };
      if (type.archived) return { ok: false, httpStatus: 409, error: "This ticket type is no longer on sale" };
      if (type.quantity > 0) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(eventTickets)
          .where(and(eq(eventTickets.ticketTypeId, type.id), inArray(eventTickets.status, [...CAPACITY_STATUSES])));
        if (n >= type.quantity) return { ok: false, httpStatus: 409, error: "Sold out" };
      }
      // Reuse an existing pending reservation for this buyer+type instead of
      // minting a new row. A pending row means an earlier attempt crashed or
      // is in flight between debit and finalize; reusing its id reuses the
      // SAME wallet idempotency key, so a retry can never double-charge —
      // the debit resolves as "duplicate" and finalize heals the ticket.
      const [stale] = await tx
        .select({ id: eventTickets.id })
        .from(eventTickets)
        .where(
          and(
            eq(eventTickets.ticketTypeId, type.id),
            eq(eventTickets.buyerUserId, buyer.id),
            eq(eventTickets.status, "pending"),
          ),
        )
        .orderBy(asc(eventTickets.id))
        .limit(1);
      if (stale) {
        // Re-pin price to the row's original pricePaid via the type row we
        // hold — the debit key is ticket-scoped so amount drift can't double-bill.
        return { ok: true, ticketId: stale.id, type };
      }
      const [ticket] = await tx
        .insert(eventTickets)
        .values({
          eventId,
          ticketTypeId: type.id,
          buyerUserId: buyer.id,
          pricePaid: type.price,
          status: "pending",
        })
        .returning({ id: eventTickets.id });
      return { ok: true, ticketId: ticket.id, type };
    },
  );
  if (!reserved.ok) return reserved;

  const { ticketId, type } = reserved;
  const isSink = event.ticketPayoutMode === "sink";
  const runnerUserId = event.ticketRunnerUserId ?? event.createdById;

  // 2) Buyer debit (skipped for free tickets).
  let walletStatus = "free";
  if (type.price > 0) {
    const debit = await applyWalletDelta({
      userId: buyer.id,
      discordId: buyer.discordId,
      amount: -type.price,
      source: "website",
      kind: "event_ticket",
      reason: `Ticket: ${type.name} — ${event.title}`,
      counterpartyName: isSink ? SINK_NAME : null,
      relatedEntityType: "event_ticket",
      relatedEntityId: ticketId,
      idempotencyKey: `event-ticket:${ticketId}:debit`,
    });
    if (!debit.ok && debit.status !== "duplicate") {
      // Free the reserved capacity slot — the buyer was not charged.
      await db.delete(eventTickets).where(and(eq(eventTickets.id, ticketId), eq(eventTickets.status, "pending")));
      const msg =
        debit.status === "insufficient_funds"
          ? "Insufficient funds"
          : debit.status === "disabled"
            ? "The economy system is currently disabled"
            : debit.error ?? "Payment failed";
      const httpStatus = debit.status === "insufficient_funds" ? 400 : debit.status === "failed" ? 502 : 409;
      return { ok: false, httpStatus, error: msg };
    }
    walletStatus = debit.status === "dry_run" ? "dry_run" : "synced";
  }

  // 3) Runner credit — only when real money actually moved (synced/duplicate).
  //    A failure here NEVER unwinds the purchase: the ticket stays valid with
  //    payoutStatus "failed" so a manager can retry without re-charging.
  let payoutStatus = "none";
  let payoutError: string | null = null;
  if (type.price > 0 && walletStatus === "synced" && !isSink) {
    const credited = await creditRunner({ ticketId, amount: type.price, runnerUserId, eventTitle: event.title, typeName: type.name });
    payoutStatus = credited.payoutStatus;
    payoutError = credited.payoutError;
  }

  // 4) Finalize the ticket.
  await db
    .update(eventTickets)
    .set({ status: "purchased", payoutStatus, payoutError })
    .where(eq(eventTickets.id, ticketId));

  const [view] = await loadTicketViews({ ticketId });
  return { ok: true, ticket: view!, walletStatus };
}

async function creditRunner(opts: {
  ticketId: number;
  amount: number;
  runnerUserId: string | null;
  eventTitle: string;
  typeName: string;
}): Promise<{ payoutStatus: string; payoutError: string | null }> {
  if (!opts.runnerUserId) {
    return { payoutStatus: "failed", payoutError: "No runner set and the event has no creator to default to" };
  }
  const [runner] = await db
    .select({ id: users.id, discordId: users.discordId })
    .from(users)
    .where(eq(users.id, opts.runnerUserId));
  if (!runner) return { payoutStatus: "failed", payoutError: "Runner account no longer exists" };
  const credit = await applyWalletDelta({
    userId: runner.id,
    discordId: runner.discordId,
    amount: opts.amount,
    source: "website",
    kind: "event_ticket_revenue",
    reason: `Ticket sale: ${opts.typeName} — ${opts.eventTitle}`,
    relatedEntityType: "event_ticket",
    relatedEntityId: opts.ticketId,
    idempotencyKey: `event-ticket:${opts.ticketId}:credit`,
  });
  if (credit.ok) return { payoutStatus: "paid", payoutError: null };
  return { payoutStatus: "failed", payoutError: credit.error ?? `Runner credit failed (${credit.status})` };
}

// ---------------------------------------------------------------------------
// Stale pending-ticket sweep (cron, every 5 minutes).
//
// A pending row older than the grace window means a purchase crashed between
// reserve and finalize. Two cases, decided by the ledger (source of truth):
//  - A debit ledger row exists for the ticket's idempotency key → the buyer
//    WAS charged: finalize to purchased (and pay the runner, idempotently).
//  - No debit row → the buyer was never charged: delete the row to release
//    the capacity it was holding.
// The grace window keeps the sweep from racing a live purchase that is
// legitimately between reserve and finalize.
// ---------------------------------------------------------------------------
export async function sweepStalePendingTickets(opts?: { olderThanMinutes?: number }): Promise<{ finalized: number; released: number }> {
  const cutoff = new Date(Date.now() - (opts?.olderThanMinutes ?? 15) * 60 * 1000);
  const stale = await db
    .select({ t: eventTickets, e: events })
    .from(eventTickets)
    .innerJoin(events, eq(events.id, eventTickets.eventId))
    .where(and(eq(eventTickets.status, "pending"), lt(eventTickets.createdAt, cutoff)));
  let finalized = 0;
  let released = 0;
  for (const { t, e } of stale) {
    try {
      const [debit] = await db
        .select({ id: walletTransactions.id })
        .from(walletTransactions)
        .where(eq(walletTransactions.idempotencyKey, `event-ticket:${t.id}:debit`))
        .limit(1);
      if (!debit && t.pricePaid > 0) {
        // Never charged — release the reserved capacity. Guarded on status so
        // a concurrent retry that just debited can't lose its row.
        const gone = await db
          .delete(eventTickets)
          .where(and(eq(eventTickets.id, t.id), eq(eventTickets.status, "pending")))
          .returning({ id: eventTickets.id });
        if (gone.length > 0) released++;
        continue;
      }
      // Charged (or free) — finalize. Pay the runner idempotently when due.
      let payoutStatus = "none";
      let payoutError: string | null = null;
      if (debit && t.pricePaid > 0 && e.ticketPayoutMode !== "sink") {
        const [type] = await db.select({ name: eventTicketTypes.name }).from(eventTicketTypes).where(eq(eventTicketTypes.id, t.ticketTypeId));
        const credited = await creditRunner({
          ticketId: t.id,
          amount: t.pricePaid,
          runnerUserId: e.ticketRunnerUserId ?? e.createdById,
          eventTitle: e.title,
          typeName: type?.name ?? "Ticket",
        });
        payoutStatus = credited.payoutStatus;
        payoutError = credited.payoutError;
      }
      const healed = await db
        .update(eventTickets)
        .set({ status: "purchased", payoutStatus, payoutError })
        .where(and(eq(eventTickets.id, t.id), eq(eventTickets.status, "pending")))
        .returning({ id: eventTickets.id });
      if (healed.length > 0) {
        finalized++;
        logger.warn({ ticketId: t.id, eventId: t.eventId, buyerUserId: t.buyerUserId }, "Recovered charged pending ticket");
      }
    } catch (err) {
      logger.error({ err, ticketId: t.id }, "pending-ticket sweep failed for ticket");
    }
  }
  return { finalized, released };
}

// Manager retry of a bounced runner credit. Same idempotency key, so a credit
// that actually landed earlier resolves as "duplicate" and just heals status.
export async function retryTicketPayout(eventId: number, ticketId: number): Promise<TicketResult<{ ticket: TicketView }>> {
  const [row] = await db
    .select({ t: eventTickets, e: events, typeName: eventTicketTypes.name })
    .from(eventTickets)
    .innerJoin(events, eq(events.id, eventTickets.eventId))
    .innerJoin(eventTicketTypes, eq(eventTicketTypes.id, eventTickets.ticketTypeId))
    .where(and(eq(eventTickets.id, ticketId), eq(eventTickets.eventId, eventId)));
  if (!row) return { ok: false, httpStatus: 404, error: "Ticket not found" };
  if (row.t.status !== "purchased") return { ok: false, httpStatus: 409, error: "Only purchased tickets have a payout" };
  if (row.t.payoutStatus !== "failed") return { ok: false, httpStatus: 409, error: "This ticket's payout is not in a failed state" };
  if (row.e.ticketPayoutMode === "sink") return { ok: false, httpStatus: 409, error: "Sink events have no runner payout" };
  const runnerUserId = row.e.ticketRunnerUserId ?? row.e.createdById;
  const credited = await creditRunner({
    ticketId,
    amount: row.t.pricePaid,
    runnerUserId,
    eventTitle: row.e.title,
    typeName: row.typeName,
  });
  await db
    .update(eventTickets)
    .set({ payoutStatus: credited.payoutStatus, payoutError: credited.payoutError })
    .where(eq(eventTickets.id, ticketId));
  if (credited.payoutStatus !== "paid") {
    return { ok: false, httpStatus: 502, error: credited.payoutError ?? "Runner credit failed" };
  }
  const [view] = await loadTicketViews({ ticketId });
  return { ok: true, ticket: view! };
}

// ---------------------------------------------------------------------------
// Attendance (idempotent + undoable; managers or designated check-in staff)
// ---------------------------------------------------------------------------
export async function setTicketAttendance(opts: {
  eventId: number;
  ticketId: number;
  attended: boolean;
  byUserId: string;
}): Promise<TicketResult<{ ticket: TicketView }>> {
  const [t] = await db
    .select()
    .from(eventTickets)
    .where(and(eq(eventTickets.id, opts.ticketId), eq(eventTickets.eventId, opts.eventId)));
  if (!t) return { ok: false, httpStatus: 404, error: "Ticket not found" };
  if (t.status !== "purchased") {
    return { ok: false, httpStatus: 409, error: "Only purchased tickets can be checked in" };
  }
  // Idempotent: re-marking an already-attended ticket (or re-clearing) no-ops.
  // The status guard is REPEATED in the UPDATE's WHERE so a refund that lands
  // between the read above and this write can't get attendance stamped onto a
  // refunded ticket (TOCTOU).
  const updated = await db
    .update(eventTickets)
    .set(
      opts.attended
        ? { attendedAt: t.attendedAt ?? new Date(), attendedById: t.attendedAt ? t.attendedById : opts.byUserId }
        : { attendedAt: null, attendedById: null },
    )
    .where(and(eq(eventTickets.id, opts.ticketId), eq(eventTickets.status, "purchased")))
    .returning({ id: eventTickets.id });
  if (!updated.length) {
    return { ok: false, httpStatus: 409, error: "Only purchased tickets can be checked in" };
  }
  const [view] = await loadTicketViews({ ticketId: opts.ticketId });
  return { ok: true, ticket: view! };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
// Refund one ticket: money back to the buyer, pulled back from the runner (or
// simply re-minted when it was burned to the sink). Blocked once attended.
//
// Order of operations: flip the row to "refunded" FIRST with a status-guarded
// conditional UPDATE (the concurrency gate — two racing refunds can't both
// pass), then run the money legs, and revert the flip if the buyer credit
// fails. All legs are idempotency-keyed on the ticket id, so a retry after a
// partial failure resumes instead of double-paying.
export async function refundTicket(opts: {
  eventId: number;
  ticketId: number;
  byUserId: string;
}): Promise<TicketResult<{ ticket: TicketView }>> {
  const [row] = await db
    .select({ t: eventTickets, e: events, typeName: eventTicketTypes.name })
    .from(eventTickets)
    .innerJoin(events, eq(events.id, eventTickets.eventId))
    .innerJoin(eventTicketTypes, eq(eventTicketTypes.id, eventTickets.ticketTypeId))
    .where(and(eq(eventTickets.id, opts.ticketId), eq(eventTickets.eventId, opts.eventId)));
  if (!row) return { ok: false, httpStatus: 404, error: "Ticket not found" };
  if (row.t.attendedAt) return { ok: false, httpStatus: 409, error: "Attended tickets cannot be refunded" };
  if (row.t.status === "refunded") return { ok: false, httpStatus: 409, error: "Already refunded" };
  if (row.t.status !== "purchased") return { ok: false, httpStatus: 409, error: "Only purchased tickets can be refunded" };

  // Concurrency gate: only one refund attempt can win this flip.
  const flipped = await db
    .update(eventTickets)
    .set({ status: "refunded", refundedAt: new Date(), refundedById: opts.byUserId })
    .where(
      and(
        eq(eventTickets.id, opts.ticketId),
        eq(eventTickets.status, "purchased"),
        isNull(eventTickets.attendedAt),
      ),
    )
    .returning({ id: eventTickets.id });
  if (!flipped.length) return { ok: false, httpStatus: 409, error: "Ticket is no longer refundable" };

  if (row.t.pricePaid > 0) {
    // Buyer credit. The purchase debit may have been a dry-run (test mode); the
    // matching refund credit dry-runs the same way, which is correct.
    const [buyer] = await db
      .select({ id: users.id, discordId: users.discordId })
      .from(users)
      .where(eq(users.id, row.t.buyerUserId));
    if (!buyer) {
      // Buyer account is gone — keep the refund flip (frees capacity) but there
      // is no wallet to credit; log for the audit trail.
      logger.warn({ ticketId: opts.ticketId }, "refundTicket: buyer account missing; no credit issued");
    } else {
      const credit = await applyWalletDelta({
        userId: buyer.id,
        discordId: buyer.discordId,
        amount: row.t.pricePaid,
        source: "website",
        kind: "event_ticket_refund",
        reason: `Ticket refund: ${row.typeName} — ${row.e.title}`,
        counterpartyName: row.e.ticketPayoutMode === "sink" ? SINK_NAME : null,
        relatedEntityType: "event_ticket",
        relatedEntityId: opts.ticketId,
        idempotencyKey: `event-ticket:${opts.ticketId}:refund-credit`,
      });
      if (!credit.ok && credit.status !== "duplicate") {
        // Money did not move — undo the flip so the ticket stays purchased.
        await db
          .update(eventTickets)
          .set({ status: "purchased", refundedAt: null, refundedById: null })
          .where(and(eq(eventTickets.id, opts.ticketId), eq(eventTickets.status, "refunded")));
        const msg =
          credit.status === "disabled"
            ? "The economy system is currently disabled"
            : credit.error ?? `Refund failed (${credit.status})`;
        return { ok: false, httpStatus: credit.status === "failed" ? 502 : 409, error: msg };
      }
    }

    // Pull the revenue back from the runner — only if it was actually paid out.
    // allowNegative: the runner may have spent it; the clawback still applies.
    // A clawback failure does NOT undo the buyer's refund; it is surfaced on
    // the ticket for a manager to resolve.
    if (row.t.payoutStatus === "paid" && row.e.ticketPayoutMode !== "sink") {
      const runnerUserId = row.e.ticketRunnerUserId ?? row.e.createdById;
      const [runner] = runnerUserId
        ? await db.select({ id: users.id, discordId: users.discordId }).from(users).where(eq(users.id, runnerUserId))
        : [];
      if (runner) {
        const clawback = await applyWalletDelta({
          userId: runner.id,
          discordId: runner.discordId,
          amount: -row.t.pricePaid,
          source: "website",
          kind: "event_ticket_refund",
          reason: `Ticket refund clawback: ${row.typeName} — ${row.e.title}`,
          relatedEntityType: "event_ticket",
          relatedEntityId: opts.ticketId,
          idempotencyKey: `event-ticket:${opts.ticketId}:refund-debit`,
          allowNegative: true,
        });
        if (clawback.ok || clawback.status === "duplicate") {
          await db
            .update(eventTickets)
            .set({ payoutStatus: "none", payoutError: null })
            .where(eq(eventTickets.id, opts.ticketId));
        } else {
          await db
            .update(eventTickets)
            .set({ payoutError: `Refund clawback failed: ${clawback.error ?? clawback.status}` })
            .where(eq(eventTickets.id, opts.ticketId));
        }
      }
    }
  }

  const [view] = await loadTicketViews({ ticketId: opts.ticketId });
  return { ok: true, ticket: view! };
}

// Bulk refund on event cancellation: every purchased, un-attended ticket.
// Attended tickets are deliberately skipped (the holder got the goods).
// Per-ticket failures are recorded and reported so a manager can retry.
export interface BulkRefundSummary {
  refunded: number;
  skipped: number;
  failures: { ticketId: number; buyerName: string | null; error: string }[];
}

export async function refundAllForCancelledEvent(eventId: number, byUserId: string): Promise<BulkRefundSummary> {
  const tickets = await db
    .select({ id: eventTickets.id, attendedAt: eventTickets.attendedAt })
    .from(eventTickets)
    .where(and(eq(eventTickets.eventId, eventId), eq(eventTickets.status, "purchased")));
  const summary: BulkRefundSummary = { refunded: 0, skipped: 0, failures: [] };
  for (const t of tickets) {
    if (t.attendedAt) {
      summary.skipped++;
      continue;
    }
    try {
      const res = await refundTicket({ eventId, ticketId: t.id, byUserId });
      if (res.ok) summary.refunded++;
      else {
        const [view] = await loadTicketViews({ ticketId: t.id });
        summary.failures.push({ ticketId: t.id, buyerName: view?.buyerName ?? null, error: res.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.failures.push({ ticketId: t.id, buyerName: null, error: msg });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Event-change notification: DM every current ticket holder when the event's
// time or location changes. Fire-and-forget (deployment-gated inside
// sendDirectMessage) — never blocks or fails the edit.
// ---------------------------------------------------------------------------
export async function notifyTicketHoldersOfChange(before: Event, after: Event): Promise<void> {
  const timeChanged = before.startAt.getTime() !== after.startAt.getTime();
  const locationChanged = (before.location ?? "") !== (after.location ?? "");
  if (!timeChanged && !locationChanged) return;

  const holders = await db
    .select({ discordId: users.discordId })
    .from(eventTickets)
    .innerJoin(users, eq(users.id, eventTickets.buyerUserId))
    .where(and(eq(eventTickets.eventId, after.id), eq(eventTickets.status, "purchased")));
  const discordIds = [...new Set(holders.map((h) => h.discordId).filter((x): x is string => !!x))];
  if (!discordIds.length) return;

  const when = `<t:${Math.floor(after.startAt.getTime() / 1000)}:F>`;
  const changes: string[] = [];
  if (timeChanged) changes.push(`new time: ${when}`);
  if (locationChanged) changes.push(`new location: ${after.location ?? "TBA"}`);
  const msg = `Heads up, choom — the event **${after.title}** you hold a ticket for has changed (${changes.join(", ")}). Check the portal for details.`;

  for (const discordId of discordIds) {
    // Fire-and-forget per holder; a failed DM never affects the edit.
    void sendDirectMessage(discordId, msg).catch((err) => {
      logger.warn({ err, discordId, eventId: after.id }, "ticket-holder DM failed");
    });
  }
}
