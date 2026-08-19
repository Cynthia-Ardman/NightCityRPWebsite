import type { Request } from "express";
import { and, or, eq, desc, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  botActorAttendance,
  events,
  characters,
  users,
} from "@workspace/db";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import { applyWalletDelta } from "../economy";
import { postToChannel } from "../discord";
import { notifyMissionPayout, notifyFixerPay } from "../notifications";
import { getMissionContext } from "../missionsConfig";
import { resolveOrProvisionUser } from "../userProvision";
import {
  completedAtStamp,
  iso,
  creditActorPayout,
  getNpcSettlement,
  statusAfterPlayersPaid,
  statusAfterSecondPhase,
} from "./internal";

// ===========================================================================
// PAYMENTS
// ===========================================================================

export interface PayPlayersResult {
  paid: number;
  simulated: number;
  failed: number;
  skipped: number;
  live: boolean;
}

/**
 * Pay assigned players their mission pay and credit attendance. Idempotent:
 * assignments already in `paid` are skipped (no double-pay). In Test mode the
 * payment is recorded as `simulated` (no real money, no Discord post) so the
 * flow is fully verifiable. Used by the manual endpoint and the auto-pay cron.
 */
export async function payMissionPlayers(
  missionId: number,
  opts: { source: "manual" | "auto"; req?: Request; actorId?: string | null; actorName?: string | null },
): Promise<PayPlayersResult | null> {
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!mission) return null;
  const ctx = await getMissionContext();
  const result: PayPlayersResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  if (mission.status === "cancelled") {
    return result; // never pay a cancelled mission
  }

  const rows = await db
    .select({
      assignment: missionAssignments,
      discordId: users.discordId,
      username: users.username,
    })
    .from(missionAssignments)
    .leftJoin(users, eq(users.id, missionAssignments.userId))
    .where(eq(missionAssignments.missionId, missionId));

  const amount = mission.playerPay;
  const now = new Date();
  const paidLines: string[] = [];

  for (const { assignment: a, discordId, username } of rows) {
    if (a.paymentStatus === "paid") {
      result.skipped++;
      continue;
    }
    // Atomically claim this row so a concurrent run (manual + cron, overlapping
    // cron ticks, or duplicate requests) cannot pay the same assignment twice.
    // Only one worker can transition it out of a non-final state.
    const claimed = await db
      .update(missionAssignments)
      .set({ paymentStatus: "processing", processingAt: new Date() })
      .where(
        and(
          eq(missionAssignments.id, a.id),
          // STALE "processing" is claimable too: it only persists when a prior
          // run crashed between the wallet credit and the paid-update (nothing
          // else transitions it out). The 5-minute staleness gate keeps a
          // concurrent in-flight payer from being re-claimed; re-paying a
          // genuinely stranded row is money-safe because the credit is
          // idempotency-keyed on the assignment id — the re-run resolves as
          // "duplicate" (ok) and simply heals the row to paid.
          or(
            inArray(missionAssignments.paymentStatus, ["unpaid", "failed", "simulated"]),
            and(
              eq(missionAssignments.paymentStatus, "processing"),
              or(
                isNull(missionAssignments.processingAt),
                sql`${missionAssignments.processingAt} < now() - interval '5 minutes'`,
              ),
            ),
          ),
        ),
      )
      .returning({ id: missionAssignments.id });
    if (claimed.length === 0) {
      // Lost the race (another worker is paying / already paid it).
      result.skipped++;
      continue;
    }
    // Re-check cancellation AFTER claiming and BEFORE the irreversible UB
    // payout: a mission cancelled mid-loop must not keep paying the remaining
    // players. Release the claim back to its prior state and stop.
    const [fresh] = await db
      .select({ status: missions.status })
      .from(missions)
      .where(eq(missions.id, missionId));
    if (fresh?.status === "cancelled") {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: a.paymentStatus })
        .where(eq(missionAssignments.id, a.id));
      break;
    }
    const creditAttendance = a.attendanceCreditedAt ?? now;

    if (amount <= 0) {
      // Nothing to pay — just credit attendance and mark resolved.
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "paid", payAmount: 0, paidAt: now, paymentError: null, attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.paid++;
      continue;
    }

    if (!ctx.live) {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "simulated", payAmount: amount, paidAt: now, paymentError: null, attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.simulated++;
      continue;
    }

    if (!discordId) {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "failed", payAmount: amount, paymentError: "No Discord id for player", attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.failed++;
      continue;
    }

    // Website-first payout: credits the website wallet (source of truth) with
    // a settled 'mission' ledger row and enqueues the UB mirror push. Gated on
    // MISSION live mode by ctx.live above, so it bypasses the economy
    // kill-switch (gate: "none"). Idempotent on the assignment id.
    const credit = await applyWalletDelta({
      userId: a.userId,
      discordId,
      amount,
      source: "mission",
      kind: "mission",
      reason: `Mission pay: ${mission.title}`,
      memo: `Mission payout: ${mission.title}`,
      characterId: a.characterId ?? null,
      relatedEntityType: "mission",
      relatedEntityId: missionId,
      idempotencyKey: `mission_payout:${a.id}`,
      gate: "none",
    });
    if (!credit.ok) {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "failed", payAmount: amount, paymentError: credit.error ?? "Wallet payout failed", attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.failed++;
    } else {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "paid", payAmount: amount, paidAt: now, paymentError: null, attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.paid++;
      paidLines.push(`<@${discordId}>${username ? ` (${username})` : ""}: +${amount.toLocaleString()} eddies`);
      void notifyMissionPayout({
        discordId,
        userId: a.userId,
        amount,
        missionTitle: mission.title,
        missionId,
        newBalance: credit.balance,
      });
    }
  }

  // Post a banking summary only for real payouts.
  if (ctx.live && paidLines.length > 0) {
    await postToChannel(
      ctx.bankingChannelId,
      [`**Mission player payout** — ${mission.title} (#${mission.id})`, ...paidLines].join("\n"),
    ).catch((err) => logger.warn({ err, missionId }, "banking post (players) failed"));
  }

  // Mark processed (auto-pay idempotency). Only advance status when EVERY
  // assignment reached a terminal-success state (paid/simulated). If any are
  // still failed/unpaid/processing (e.g. UB payout failure, or a concurrent
  // worker mid-flight), leave the status untouched so the mission isn't marked
  // "players paid" while a player went unpaid. A later manual/auto retry will
  // resolve the stragglers and then advance.
  const remaining = await db
    .select({ id: missionAssignments.id })
    .from(missionAssignments)
    .where(
      and(
        eq(missionAssignments.missionId, missionId),
        sql`${missionAssignments.paymentStatus} not in ('paid', 'simulated')`,
      ),
    );
  const allResolved = remaining.length === 0;
  // Detect actors-first ordering: if any actor payout already settled, paying
  // players completes the mission outright (completed_paid) rather than leaving
  // it stuck at completed_players_paid.
  const actorsSettled = await db
    .select({ id: missionActorPayments.id })
    .from(missionActorPayments)
    .where(
      and(
        eq(missionActorPayments.missionId, missionId),
        inArray(missionActorPayments.paymentStatus, ["paid", "simulated"]),
      ),
    )
    .limit(1);
  // Second phase is settled if any actor payout exists OR any NPC sign-up has
  // been resolved by a fixer. An outstanding NPC sign-up holds the mission at
  // completed_players_paid until it's actioned.
  const npc = await getNpcSettlement(missionId);
  const secondPhaseSettled = actorsSettled.length > 0 || npc.anyResolved;
  const newStatus = allResolved
    ? statusAfterPlayersPaid(mission.status, secondPhaseSettled, npc.outstanding)
    : mission.status;
  await db
    .update(missions)
    .set({ status: newStatus, autoPayProcessedAt: mission.autoPayProcessedAt ?? now, ...completedAtStamp(newStatus) })
    .where(eq(missions.id, missionId));

  await recordAudit({
    req: opts.req,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    category: "mission",
    action: opts.source === "auto" ? "mission.autopay_players" : "mission.pay_players",
    targetType: "mission",
    targetId: missionId,
    message: `${ctx.live ? "LIVE" : "TEST"} player payout — paid ${result.paid}, simulated ${result.simulated}, failed ${result.failed}, skipped ${result.skipped}`,
    after: result,
  });

  return result;
}

export interface PayActorsResult {
  paid: number;
  simulated: number;
  failed: number;
  skipped: number;
  live: boolean;
}

/**
 * Pay a set of actors a flat amount each, recording one history row per actor.
 * The DB enforces no second SUCCESSFUL pay per (mission, actor); we also skip
 * up-front. Test mode records `simulated` rows and posts nothing.
 */
export async function payMissionActors(
  missionId: number,
  userIds: string[],
  amount: number,
  opts: { req?: Request; actorId?: string | null; actorName?: string | null },
): Promise<PayActorsResult | null | { blocked: "cancelled" }> {
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!mission) return null;
  // Task #185 removed the completion lock: fixers may pay actors at any time,
  // including after a mission is marked completed. The ONLY refusal is a
  // cancelled mission — a called-off mission never pays out (mirrors
  // payMissionPlayers). Cancelling sets status='cancelled' (not completedAt).
  if (mission.status === "cancelled") return { blocked: "cancelled" };
  const ctx = await getMissionContext();
  const result: PayActorsResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;

  const userRows = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Actors picked from the Discord-guild search may have no `users` row yet
  // (never signed in to the portal). Mint a stub keyed on their Discord id so
  // the NOT NULL FK on mission_actor_payments.user_id is satisfied and the
  // payout (which credits by Discord id) can proceed; their first login adopts
  // the same row.
  for (const id of uniqueIds) {
    if (userById.has(id)) continue;
    const provisioned = await resolveOrProvisionUser(id);
    if (provisioned) {
      userById.set(id, { id: provisioned.id, discordId: provisioned.discordId, username: provisioned.username });
    }
  }

  // Resolve the fixer/admin who is issuing this payment, so the actor-payment
  // history shows WHO paid each actor (not the mission's owning fixer).
  const payerId = opts.actorId ?? mission.fixerId ?? null;
  let payerName = opts.actorName ?? null;
  if (!payerName && payerId) {
    const [payer] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, payerId));
    payerName = payer?.globalName ?? payer?.username ?? null;
  }

  // Existing SUCCESSFUL actor payments — skip those (double-pay guard).
  const existing = await db
    .select({ userId: missionActorPayments.userId })
    .from(missionActorPayments)
    .where(and(eq(missionActorPayments.missionId, missionId), eq(missionActorPayments.paymentStatus, "paid")));
  const alreadyPaid = new Set(existing.map((e) => e.userId));

  const now = new Date();
  const postedLines: string[] = [];

  for (const userId of uniqueIds) {
    if (alreadyPaid.has(userId)) {
      result.skipped++;
      continue;
    }
    const u = userById.get(userId);
    if (!u) {
      // No `users` row and provisioning failed (Discord unreachable or an
      // unknown id). We can't satisfy the NOT NULL FK on user_id, so skip the
      // insert entirely — counting it failed — rather than throwing a 23503
      // mid-batch after earlier actors were already paid.
      result.failed++;
      continue;
    }
    const base = {
      missionId,
      missionName: mission.title,
      userId,
      userName: u?.username ?? null,
      fixerId: payerId,
      fixerName: payerName,
      missionDate: mission.startAt,
      amount,
      source: "manual" as const,
      attendanceCreditedAt: now,
      paidAt: now,
    };

    if (!ctx.live) {
      await db.insert(missionActorPayments).values({ ...base, paymentStatus: "simulated" });
      result.simulated++;
      continue;
    }
    // Reserve the unique (mission, actor) PAID slot up-front, BEFORE the
    // external payout, so two concurrent runs can't both pay the same actor.
    // The partial unique index covers payment_status='paid' rows; the loser of
    // the race gets nothing back and skips.
    //
    // The reservation is an INSERT ... SELECT gated on the mission still NOT
    // being cancelled. This re-checks the cancellation guard ATOMICALLY with the
    // reservation: if a concurrent cancel committed before this statement runs,
    // the subquery yields no row and nothing is reserved — closing the
    // check-then-act race between the top-of-function read and the payout. (The
    // completion lock was removed in Task #185, so completedAt is NOT checked.)
    // The guard runs inside the DB, so no lock is held across the external
    // UnbelievaBoat call below.
    const reservedRes = await db.execute(sql`
      INSERT INTO mission_actor_payments
        (mission_id, mission_name, user_id, user_name, fixer_id, fixer_name,
         mission_date, amount, source, attendance_credited_at, paid_at, payment_status)
      SELECT ${missionId}, ${mission.title}, ${userId}, ${u?.username ?? null},
             ${payerId}, ${payerName}, ${mission.startAt}, ${amount}, 'manual',
             ${now}, ${now}, 'paid'
      WHERE EXISTS (
        SELECT 1 FROM missions
        WHERE id = ${missionId} AND status <> 'cancelled'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const reserved = (reservedRes.rows ?? []) as Array<{ id: number }>;
    if (reserved.length === 0) {
      // Either the actor is already paid (conflict) or the mission was cancelled
      // mid-flight. Both mean "no payout"; no money has moved.
      result.skipped++;
      continue;
    }
    const reservedId = reserved[0].id;
    if (!u?.discordId) {
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
        .where(eq(missionActorPayments.id, reservedId));
      result.failed++;
      continue;
    }
    const credit = await creditActorPayout({
      userId,
      discordId: u.discordId,
      amount,
      reason: `Actor pay: ${mission.title}`,
      memo: `Actor payout: ${mission.title}`,
      paymentRowId: reservedId,
      relatedEntityType: "mission",
      relatedEntityId: missionId,
    });
    if (!credit.ok) {
      // Release the reservation so the actor can be retried later.
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: credit.error ?? "Wallet payout failed", paidAt: null })
        .where(eq(missionActorPayments.id, reservedId));
      result.failed++;
    } else {
      // Row is already 'paid' from the reservation.
      result.paid++;
      postedLines.push(`<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`);
    }
  }

  // Actor payouts are NPC spending — they post ONLY to #npc-spending, never to
  // #banking (which is reserved for automatic player payouts).
  if (ctx.live && postedLines.length > 0) {
    const body = [`**Actor payout** — ${mission.title} (#${mission.id})`, ...postedLines].join("\n");
    await postToChannel(ctx.npcSpendingChannelId, body).catch((err) =>
      logger.warn({ err, missionId }, "npc spending post failed"),
    );
  }

  if (result.paid > 0 || result.simulated > 0) {
    // Advance completed_players_paid → completed_paid only when no NPC sign-up
    // is still outstanding (Task #185).
    const npc = await getNpcSettlement(missionId);
    const newStatus = statusAfterSecondPhase(mission.status, npc.outstanding);
    if (newStatus !== mission.status) {
      await db
        .update(missions)
        .set({ status: newStatus, ...completedAtStamp(newStatus) })
        .where(eq(missions.id, missionId));
    }
  }

  await recordAudit({
    req: opts.req,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    category: "mission",
    action: "mission.pay_actors",
    targetType: "mission",
    targetId: missionId,
    message: `${ctx.live ? "LIVE" : "TEST"} actor payout (${amount} ea) — paid ${result.paid}, simulated ${result.simulated}, failed ${result.failed}, skipped ${result.skipped}`,
    after: result,
  });

  return result;
}

/**
 * Pay a set of actors a flat amount each for a NON-mission event (a regular
 * session, an open social lobby, etc). These have no mission row — the event is
 * identified by a free-form label + date. Rows are stored in
 * `mission_actor_payments` with missionId = null, missionName = the label,
 * missionDate = the event date, and eventType = the preset category. They show
 * up in the reports ACTOR PAYMENTS aggregate alongside mission actor pay.
 *
 * Unlike mission payouts there is no all-time double-pay guard (the same actor
 * legitimately acts at many sessions); we only de-dupe within a single request.
 */
export async function payStandaloneActors(
  input: {
    eventName: string;
    eventType?: string | null;
    eventDate?: Date | null;
    eventId?: number | null;
    // Concrete occurrence (startAt instant) this payout covers, for RECURRING
    // portal events. When omitted and eventId points at a recurring event,
    // defaults to the event's current startAt so each weekly occurrence gets
    // its own pay-once scope. Ignored (forced null) for non-recurring events.
    occurrenceStartAt?: Date | null;
    userIds: string[];
    amount: number;
    // General (non-acting) fixer pay: ties the payout to a specific character
    // of the (single) recipient. Set together with eventType='general'; the
    // route validates ownership before we get here.
    characterId?: number | null;
    characterName?: string | null;
  },
  opts: { req?: Request; actorId?: string | null; actorName?: string | null },
): Promise<PayActorsResult> {
  const ctx = await getMissionContext();
  const result: PayActorsResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  const uniqueIds = [...new Set(input.userIds)];
  if (uniqueIds.length === 0) return result;

  const eventName = input.eventName.trim();
  const eventDate = input.eventDate ?? new Date();
  const amount = input.amount;

  // Resolve the occurrence scope for event-bound payouts: recurring events
  // dedupe per occurrence (default = the event's current startAt), everything
  // else stays occurrence-less (per-event dedupe, matching legacy rows).
  let occurrenceStartAt: Date | null = null;
  if (input.eventId != null) {
    const [ev] = await db
      .select({ recurrenceRule: events.recurrenceRule, startAt: events.startAt })
      .from(events)
      .where(eq(events.id, input.eventId));
    if (ev?.recurrenceRule) {
      occurrenceStartAt = input.occurrenceStartAt ?? ev.startAt;
    }
  }

  const userRows = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Actors picked from the Discord-guild search may have no `users` row yet
  // (never signed in to the portal). Mint a stub keyed on their Discord id so
  // the NOT NULL FK on mission_actor_payments.user_id is satisfied and the
  // payout (which credits by Discord id) can proceed; their first login adopts
  // the same row.
  for (const id of uniqueIds) {
    if (userById.has(id)) continue;
    const provisioned = await resolveOrProvisionUser(id);
    if (provisioned) {
      userById.set(id, { id: provisioned.id, discordId: provisioned.discordId, username: provisioned.username });
    }
  }

  // Resolve the fixer/admin issuing the payment so history shows WHO paid.
  const payerId = opts.actorId ?? null;
  let payerName = opts.actorName ?? null;
  if (!payerName && payerId) {
    const [payer] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, payerId));
    payerName = payer?.globalName ?? payer?.username ?? null;
  }

  const now = new Date();
  const postedLines: string[] = [];

  for (const userId of uniqueIds) {
    const u = userById.get(userId);
    if (!u) {
      // No `users` row and provisioning failed (Discord unreachable or an
      // unknown id). We can't satisfy the NOT NULL FK on user_id, so skip the
      // insert entirely — counting it failed — rather than throwing a 23503
      // mid-batch after earlier actors were already paid.
      result.failed++;
      continue;
    }
    const base = {
      missionId: null,
      eventId: input.eventId ?? null,
      missionName: eventName,
      eventType: input.eventType ?? null,
      userId,
      userName: u?.username ?? null,
      characterId: input.characterId ?? null,
      characterName: input.characterName ?? null,
      fixerId: payerId,
      fixerName: payerName,
      missionDate: eventDate,
      occurrenceStartAt,
      amount,
      source: "manual" as const,
      attendanceCreditedAt: now,
      paidAt: now,
    };

    // General (character-tied) fixer pay has no eventId, so the event-bound
    // dedupe below never applies. Guard against double-click/retry minting:
    // serialize per recipient with an advisory lock and skip when an identical
    // payout (same reason/amount/character) landed within the last 2 minutes.
    // Deliberate repeat payments later remain possible.
    if (input.eventType === "general") {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`general_pay:${userId}`}))`);
        const [dup] = await tx
          .select({ id: missionActorPayments.id })
          .from(missionActorPayments)
          .where(
            and(
              isNull(missionActorPayments.missionId),
              eq(missionActorPayments.eventType, "general"),
              eq(missionActorPayments.userId, userId),
              eq(missionActorPayments.amount, amount),
              eq(missionActorPayments.missionName, eventName),
              inArray(missionActorPayments.paymentStatus, ["paid", "simulated"]),
              sql`${missionActorPayments.createdAt} > now() - interval '2 minutes'`,
            ),
          );
        if (dup) return null;
        const rows = await tx
          .insert(missionActorPayments)
          .values({ ...base, paymentStatus: ctx.live ? "paid" : "simulated" })
          .returning({ id: missionActorPayments.id });
        return rows[0] ?? null;
      });
      if (!row) {
        result.skipped++;
        continue;
      }
      if (!ctx.live) {
        result.simulated++;
        continue;
      }
      // Live: fall through to the shared UB-credit path with this row.
      if (!u?.discordId) {
        await db
          .update(missionActorPayments)
          .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
          .where(eq(missionActorPayments.id, row.id));
        result.failed++;
        continue;
      }
      const payLabel = "Fixer pay";
      const generalCredit = await creditActorPayout({
        userId,
        discordId: u.discordId,
        amount,
        reason: `${payLabel}: ${eventName}`,
        memo: `Fixer pay: ${eventName}`,
        paymentRowId: row.id,
        relatedEntityType: "actor_event",
        relatedEntityId: null,
      });
      if (!generalCredit.ok) {
        await db
          .update(missionActorPayments)
          .set({ paymentStatus: "failed", paymentError: generalCredit.error ?? "Wallet payout failed", paidAt: null })
          .where(eq(missionActorPayments.id, row.id));
        result.failed++;
      } else {
        result.paid++;
        void notifyFixerPay({
          discordId: u.discordId,
          userId,
          amount,
          reason: eventName,
          general: true,
          characterName: input.characterName ?? null,
          newBalance: null,
        });
        postedLines.push(`<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`);
      }
      continue;
    }

    if (!ctx.live) {
      await db.insert(missionActorPayments).values({ ...base, paymentStatus: "simulated" });
      result.simulated++;
      continue;
    }

    // Event-bound payouts are deduped so the same actor isn't paid twice:
    // per (eventId, userId, occurrence) for recurring events, per
    // (eventId, userId) otherwise. onConflictDoNothing skips the insert and we
    // count it as skipped rather than double-paying. Mission/legacy standalone
    // payouts keep their existing no-guard behaviour.
    const insertedRows = input.eventId != null
      ? await db
          .insert(missionActorPayments)
          .values({ ...base, paymentStatus: "paid" })
          .onConflictDoNothing(
            occurrenceStartAt != null
              ? {
                  target: [missionActorPayments.eventId, missionActorPayments.userId, missionActorPayments.occurrenceStartAt],
                  where: sql`payment_status = 'paid' and event_id is not null and occurrence_start_at is not null`,
                }
              : {
                  target: [missionActorPayments.eventId, missionActorPayments.userId],
                  where: sql`payment_status = 'paid' and event_id is not null and occurrence_start_at is null`,
                },
          )
          .returning({ id: missionActorPayments.id })
      : // Standalone (no eventId) payouts have no unique index to lean on, and
        // deliberate repeat payments on later days must stay possible — so
        // dedupe them the same way as "general" pay: serialize per recipient
        // with an advisory lock and skip when an identical payout (same
        // event name/amount/type) landed within the last 2 minutes.
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`standalone_pay:${userId}`}))`);
          const [dup] = await tx
            .select({ id: missionActorPayments.id })
            .from(missionActorPayments)
            .where(
              and(
                isNull(missionActorPayments.missionId),
                isNull(missionActorPayments.eventId),
                input.eventType != null
                  ? eq(missionActorPayments.eventType, input.eventType)
                  : isNull(missionActorPayments.eventType),
                eq(missionActorPayments.userId, userId),
                eq(missionActorPayments.amount, amount),
                eq(missionActorPayments.missionName, eventName),
                inArray(missionActorPayments.paymentStatus, ["paid", "simulated"]),
                sql`${missionActorPayments.createdAt} > now() - interval '2 minutes'`,
              ),
            );
          if (dup) return [];
          return await tx
            .insert(missionActorPayments)
            .values({ ...base, paymentStatus: "paid" })
            .returning({ id: missionActorPayments.id });
        });
    const inserted = insertedRows[0];
    if (!inserted) {
      // Already paid for this event — skip silently.
      result.skipped++;
      continue;
    }

    if (!u?.discordId) {
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
        .where(eq(missionActorPayments.id, inserted.id));
      result.failed++;
      continue;
    }
    // General (non-acting) fixer pay reads differently in UB history / ledger.
    const payLabel = input.eventType === "general" ? "Fixer pay" : "Actor pay";
    const eventCredit = await creditActorPayout({
      userId,
      discordId: u.discordId,
      amount,
      reason: `${payLabel}: ${eventName}`,
      memo: `${payLabel === "Fixer pay" ? "Fixer pay" : "Actor payout"}: ${eventName}`,
      paymentRowId: inserted.id,
      relatedEntityType: input.eventId != null ? "event" : "actor_event",
      relatedEntityId: input.eventId ?? null,
    });
    if (!eventCredit.ok) {
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: eventCredit.error ?? "Wallet payout failed", paidAt: null })
        .where(eq(missionActorPayments.id, inserted.id));
      result.failed++;
    } else {
      result.paid++;
      void notifyFixerPay({
        discordId: u.discordId,
        userId,
        amount,
        reason: eventName,
        general: false,
        newBalance: null,
      });
      postedLines.push(`<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`);
    }
  }

  // Actor payouts are NPC spending — post ONLY to #npc-spending.
  if (ctx.live && postedLines.length > 0) {
    const body = [`**${input.eventType === "general" ? "Fixer pay" : "Actor payout"}** — ${eventName}`, ...postedLines].join("\n");
    await postToChannel(ctx.npcSpendingChannelId, body).catch((err) =>
      logger.warn({ err, eventName }, "npc spending post failed (standalone actors)"),
    );
  }

  await recordAudit({
    req: opts.req,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    category: "mission",
    action: "actor.pay_standalone",
    targetType: "actor_event",
    targetId: null,
    message: `${ctx.live ? "LIVE" : "TEST"} standalone actor payout "${eventName}" (${amount} ea) — paid ${result.paid}, simulated ${result.simulated}, failed ${result.failed}`,
    after: { eventName, eventType: input.eventType ?? null, ...result },
  });

  return result;
}

/**
 * List non-mission actor payouts (missionId IS NULL), grouped by event
 * (label + date). Most recent first. Fixer/admin only. Drives the "recent
 * payouts" log on the standalone Pay Actors page.
 */
export async function getStandaloneActorPayouts() {
  const rows = await db
    .select()
    .from(missionActorPayments)
    .where(isNull(missionActorPayments.missionId))
    .orderBy(desc(missionActorPayments.attendanceCreditedAt), desc(missionActorPayments.createdAt));

  const byEvent = new Map<string, {
    key: string;
    eventName: string | null;
    eventType: string | null;
    eventDate: string | null;
    paidAt: string | null;
    fixerName: string | null;
    totalPaid: number;
    actorCount: number;
    actors: Array<{ id: number; userId: string; userName: string | null; characterName: string | null; amount: number; paymentStatus: string; paymentError: string | null }>;
  }>();
  for (const r of rows) {
    // Group by the per-batch timestamp written once to attendanceCreditedAt for
    // every row in a single payStandaloneActors() call. createdAt is set by a
    // column default per INSERT statement, so it differs row-to-row and would
    // fragment one payout batch into many single-actor "events".
    const batchStamp = iso(r.attendanceCreditedAt) ?? iso(r.createdAt) ?? "";
    const key = `${r.missionName ?? ""}|${iso(r.missionDate) ?? ""}|${r.eventType ?? ""}|${batchStamp}`;
    let agg = byEvent.get(key);
    if (!agg) {
      agg = {
        key,
        eventName: r.missionName,
        eventType: r.eventType,
        eventDate: iso(r.missionDate),
        paidAt: batchStamp || null,
        fixerName: r.fixerName,
        totalPaid: 0,
        actorCount: 0,
        actors: [],
      };
      byEvent.set(key, agg);
    }
    agg.actorCount++;
    // Sum every actor's fee for the batch total — not just rows that finished as
    // "paid". Test-mode payouts land as "simulated" (and any retry can be
    // "failed"), so a paid-only sum showed €$0 in the collapsed header while the
    // expanded per-actor rows listed real amounts. The header total now matches
    // the sum of the amounts shown when expanded.
    agg.totalPaid += r.amount;
    if (!agg.fixerName && r.fixerName) agg.fixerName = r.fixerName;
    agg.actors.push({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      characterName: r.characterName,
      amount: r.amount,
      paymentStatus: r.paymentStatus,
      paymentError: r.paymentError,
    });
  }
  return [...byEvent.values()];
}

// ===========================================================================
// AUTO-PAY CRON
// ===========================================================================

/**
 * Process every mission whose window (startAt + duration + autopay delay) has
 * elapsed and that hasn't been auto-processed yet. Credits attendance and pays
 * players. Skips cancelled/future/already-processed missions. Returns the
 * number of missions processed.
 */
export async function runMissionAutoPay(): Promise<number> {
  const ctx = await getMissionContext();
  const now = Date.now();
  // Candidates: scheduled, not cancelled, not already processed. These must
  // wait for their run window (start + duration + autopay delay) to elapse.
  const candidates = await db
    .select()
    .from(missions)
    .where(
      and(
        isNull(missions.autoPayProcessedAt),
        sql`${missions.status} <> 'cancelled'`,
        sql`${missions.startAt} is not null`,
      ),
    );

  // Live-retry: missions already swept once (autoPayProcessedAt set) but that
  // still have players owed real money. The common case is a mission processed
  // while the system was in Test mode — its assignments are marked "simulated"
  // and, because the primary query filters on autoPayProcessedAt AND the manual
  // "Pay Players" button was removed, flipping Test→Live would otherwise never
  // pay them. payMissionPlayers re-claims simulated/failed/unpaid rows, so
  // re-running it settles the stragglers (and only moves real money when live).
  // Gated on ctx.live so Test mode doesn't churn the same missions every tick.
  let retryCandidates: typeof candidates = [];
  if (ctx.live) {
    const outstanding = await db
      .selectDistinct({ missionId: missionAssignments.missionId })
      .from(missionAssignments)
      .where(
        and(
          // "processing" rows are recoverable stragglers: a crash between the
          // wallet credit and the paid-update strands them, and nothing else
          // re-claims that state. Re-paying is safe — the credit is keyed
          // mission_payout:<assignmentId>, so a retry resolves as "duplicate".
          inArray(missionAssignments.paymentStatus, ["simulated", "failed", "unpaid", "processing"]),
          // Exclude permanently-unpayable rows (no Discord account to credit) so
          // the live-retry doesn't re-select the same mission every tick forever.
          // Transient UB-payout failures stay eligible and settle once UB recovers.
          sql`not (${missionAssignments.paymentStatus} = 'failed' and ${missionAssignments.paymentError} = 'No Discord id for player')`,
        ),
      );
    const ids = outstanding.map((r) => r.missionId);
    if (ids.length > 0) {
      retryCandidates = await db
        .select()
        .from(missions)
        .where(
          and(
            isNotNull(missions.autoPayProcessedAt),
            sql`${missions.status} <> 'cancelled'`,
            inArray(missions.id, ids),
          ),
        );
    }
  }

  let processed = 0;
  const seen = new Set<number>();
  for (const m of candidates) {
    if (!m.startAt) continue;
    const windowEnd = m.startAt.getTime() + Math.max(1, m.durationMinutes) * 60_000 + ctx.autopayDelayMs;
    if (windowEnd > now) continue; // still in the future
    seen.add(m.id);
    try {
      await payMissionPlayers(m.id, { source: "auto", actorName: "auto-pay cron" });
      processed++;
    } catch (err) {
      logger.error({ err, missionId: m.id }, "mission auto-pay failed");
    }
  }
  // Already-processed missions don't need a window check — they were swept once
  // already. Skip any handled above to avoid double work in one tick.
  for (const m of retryCandidates) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    try {
      await payMissionPlayers(m.id, { source: "auto", actorName: "auto-pay cron (live retry)" });
      processed++;
    } catch (err) {
      logger.error({ err, missionId: m.id }, "mission auto-pay live-retry failed");
    }
  }
  return processed;
}

// ===========================================================================
// REPORTING
// ===========================================================================

export async function getActorReport(fixerId: string | null) {
  const where = fixerId ? eq(missionActorPayments.fixerId, fixerId) : undefined;
  const rows = await db
    .select()
    .from(missionActorPayments)
    .where(where ? and(where, inArray(missionActorPayments.paymentStatus, ["paid", "simulated"])) : inArray(missionActorPayments.paymentStatus, ["paid", "simulated"]))
    .orderBy(desc(missionActorPayments.createdAt));

  const byUser = new Map<string, {
    userId: string;
    userName: string | null;
    actCount: number;
    totalPaid: number;
    missions: Array<{ missionId: number | null; missionName: string | null; missionDate: string | null; amount: number }>;
  }>();
  for (const r of rows) {
    let agg = byUser.get(r.userId);
    if (!agg) {
      agg = { userId: r.userId, userName: r.userName, actCount: 0, totalPaid: 0, missions: [] };
      byUser.set(r.userId, agg);
    }
    agg.actCount++;
    if (r.paymentStatus === "paid") agg.totalPaid += r.amount;
    agg.missions.push({ missionId: r.missionId, missionName: r.missionName, missionDate: iso(r.missionDate), amount: r.amount });
    if (!agg.userName && r.userName) agg.userName = r.userName;
  }
  return [...byUser.values()].sort((a, b) => b.actCount - a.actCount);
}

// Legacy actor history imported from the old Discord bot (bot_actor_attendance).
// These records predate the structured missions system — they reference
// free-form events by name (e.g. "Open Chaos Lobby") that don't map to a
// portal mission id, so they surface as an aggregate "who acted" view rather
// than on any single mission's ACTORS tab. Fixer/admin only.
export async function getActorHistory() {
  const rows = await db
    .select()
    .from(botActorAttendance)
    .orderBy(desc(botActorAttendance.actedAt));

  const byUser = new Map<string, {
    userId: string;
    userName: string | null;
    actCount: number;
    totalPaid: number;
    events: Array<{ eventName: string | null; fixerName: string | null; amount: number; actedAt: string | null }>;
  }>();
  for (const r of rows) {
    let agg = byUser.get(r.userId);
    if (!agg) {
      agg = { userId: r.userId, userName: r.username, actCount: 0, totalPaid: 0, events: [] };
      byUser.set(r.userId, agg);
    }
    agg.actCount++;
    agg.totalPaid += r.payAmount;
    agg.events.push({ eventName: r.missionName, fixerName: r.fixerUsername, amount: r.payAmount, actedAt: iso(r.actedAt) });
    if (!agg.userName && r.username) agg.userName = r.username;
  }
  return [...byUser.values()].sort((a, b) => b.actCount - a.actCount);
}

export async function getAttendanceReport() {
  const rows = await db
    .select({
      userId: missionAssignments.userId,
      userName: users.username,
      missionId: missionAssignments.missionId,
      missionName: missions.title,
      missionDate: missions.startAt,
      characterName: characters.name,
    })
    .from(missionAssignments)
    .leftJoin(users, eq(users.id, missionAssignments.userId))
    .leftJoin(missions, eq(missions.id, missionAssignments.missionId))
    .leftJoin(characters, eq(characters.id, missionAssignments.characterId))
    .where(sql`${missionAssignments.attendanceCreditedAt} is not null`)
    .orderBy(desc(missionAssignments.attendanceCreditedAt));

  const byUser = new Map<string, {
    userId: string;
    userName: string | null;
    attendedCount: number;
    missions: Array<{ missionId: number; missionName: string | null; missionDate: string | null; characterName: string | null }>;
  }>();
  for (const r of rows) {
    let agg = byUser.get(r.userId);
    if (!agg) {
      agg = { userId: r.userId, userName: r.userName, attendedCount: 0, missions: [] };
      byUser.set(r.userId, agg);
    }
    agg.attendedCount++;
    agg.missions.push({ missionId: r.missionId, missionName: r.missionName, missionDate: iso(r.missionDate), characterName: r.characterName });
    if (!agg.userName && r.userName) agg.userName = r.userName;
  }
  return [...byUser.values()].sort((a, b) => b.attendedCount - a.attendedCount);
}
