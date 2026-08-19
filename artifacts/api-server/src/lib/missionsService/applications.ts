import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  missionApplications,
  missionNpcSignups,
  characters,
  users,
} from "@workspace/db";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import { postToChannel } from "../discord";
import { getMissionContext } from "../missionsConfig";
import type { MissionViewer } from "./statuses";
import {
  ownsMissionApplications,
  normalizeAvailability,
  normalizeDefaultPattern,
  missionAcceptsNpcSignup,
  creditActorPayout,
  applySecondPhaseStatus,
  notifyApplicantOfReview,
} from "./internal";

// ===========================================================================
// APPLICATIONS (Task #62) — players apply with one of their own characters;
// fixers review and accept (which assigns the player) or reject.
// ===========================================================================

export type ApplyResult =
  // `isEdit` distinguishes a brand-new sign-up (false/undefined) from an
  // in-place edit of an existing one (true) so callers can decide whether to
  // announce it (e.g. mission-thread updates post only on genuinely new ones).
  | { ok: true; isEdit?: boolean }
  | { ok: false; error: string; httpStatus: number };

/** Player applies to a posted mission with one of their own characters. */
export async function applyToMission(opts: {
  missionId: number;
  userId: string;
  characterId: number;
  comment?: string | null;
  // When2Meet availability (Task #244): absolute UTC ISO instants, one per
  // selected 30-minute block. Normalized to [] when omitted, so re-applying
  // always writes the current picker state (the apply form always sends it).
  availability?: string[] | null;
  // When true, persist the supplied weekly pattern + tz as the player's saved
  // default so future apply forms pre-fill from it.
  makeDefault?: boolean;
  defaultPattern?: { weekday: number; minutes: number }[] | null;
  timezone?: string | null;
}): Promise<ApplyResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Character must belong to the applicant.
  const [char] = await db.select().from(characters).where(eq(characters.id, opts.characterId));
  if (!char) return { ok: false, error: "Character not found", httpStatus: 404 };
  if (char.ownerId !== opts.userId) {
    return { ok: false, error: "That character isn't yours", httpStatus: 403 };
  }
  // Is there already an ACTIVE (pending/accepted) application for this character?
  // Editing one — e.g. an already-accepted player tweaking their availability so
  // the fixer can keep scheduling around it — is allowed for any UPCOMING mission,
  // not just while intake is open. A brand-new application (or re-applying after a
  // withdraw/reject) still requires the mission to be Open for applications.
  const [existing] = await db
    .select({ status: missionApplications.status })
    .from(missionApplications)
    .where(
      and(
        eq(missionApplications.missionId, opts.missionId),
        eq(missionApplications.characterId, opts.characterId),
      ),
    );
  const isActiveEdit = existing?.status === "pending" || existing?.status === "accepted";
  const upcoming = m.workflowState === "posted" && m.status !== "cancelled" && m.completedAt == null;
  if (isActiveEdit) {
    if (!upcoming) {
      return { ok: false, error: "This mission is closed", httpStatus: 409 };
    }
  } else if (m.workflowState !== "posted" || m.status !== "open") {
    return { ok: false, error: "This mission is not open for applications", httpStatus: 409 };
  }
  const comment = opts.comment?.trim() || null;
  const availability = normalizeAvailability(opts.availability);
  // New applications (and re-applies after withdraw/reject) must state when the
  // player can actually run — the fixer schedules around these picks. Edits to
  // an existing active application go through the same endpoint and keep the
  // same rule: you can change your slots but not blank them out.
  if (availability.length === 0) {
    return {
      ok: false,
      error: "Select at least one availability slot so the fixer can schedule the run",
      httpStatus: 400,
    };
  }
  // Preserve an accepted application's roster status when the player is just
  // editing availability; otherwise (new / re-apply) (re)open it as pending.
  const preserveAccepted = existing?.status === "accepted";
  await db
    .insert(missionApplications)
    .values({
      missionId: opts.missionId,
      userId: opts.userId,
      characterId: opts.characterId,
      comment,
      availability,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [missionApplications.missionId, missionApplications.characterId],
      set: {
        userId: opts.userId,
        comment,
        availability,
        updatedAt: new Date(),
        // Keep an accepted player on the roster; only (re)set pending otherwise.
        ...(preserveAccepted ? {} : { status: "pending", reviewedBy: null, reviewedAt: null }),
      },
    });
  // Optionally remember this as the player's weekly default for next time.
  if (opts.makeDefault) {
    await db
      .update(users)
      .set({
        defaultAvailability: normalizeDefaultPattern(opts.defaultPattern),
        availabilityTimezone: opts.timezone?.trim() || null,
      })
      .where(eq(users.id, opts.userId));
  }
  return { ok: true, isEdit: isActiveEdit };
}

/** Load the player's saved weekly availability default (for picker pre-fill). */
export async function getDefaultAvailability(userId: string): Promise<{
  pattern: { weekday: number; minutes: number }[];
  timezone: string | null;
}> {
  const [u] = await db
    .select({
      defaultAvailability: users.defaultAvailability,
      availabilityTimezone: users.availabilityTimezone,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    pattern: normalizeDefaultPattern(u?.defaultAvailability ?? null),
    timezone: u?.availabilityTimezone ?? null,
  };
}

/** Player withdraws their own application. */
export async function withdrawApplication(opts: {
  missionId: number;
  applicationId: number;
  userId: string;
}): Promise<ApplyResult> {
  const [app] = await db
    .select()
    .from(missionApplications)
    .where(eq(missionApplications.id, opts.applicationId));
  if (!app) return { ok: false, error: "Application not found", httpStatus: 404 };
  // The application must actually belong to the mission named in the URL —
  // otherwise a mismatched mission/app pair could mutate an unrelated record.
  if (app.missionId !== opts.missionId) {
    return { ok: false, error: "Application not found", httpStatus: 404 };
  }
  if (app.userId !== opts.userId) {
    return { ok: false, error: "Not your application", httpStatus: 403 };
  }
  await db
    .update(missionApplications)
    .set({ status: "withdrawn", updatedAt: new Date() })
    .where(eq(missionApplications.id, opts.applicationId));
  return { ok: true };
}

/**
 * Fixer reviews an application. action=accept assigns the player+character to
 * the mission (idempotent on the (mission,user) assignment) and marks the
 * application accepted; action=reject just marks it rejected.
 */
export async function reviewApplication(opts: {
  missionId: number;
  applicationId: number;
  action: "accept" | "reject";
  viewer: MissionViewer;
  req?: Request;
}): Promise<ApplyResult> {
  const reviewerId = opts.viewer.id;
  const [app] = await db
    .select()
    .from(missionApplications)
    .where(eq(missionApplications.id, opts.applicationId));
  if (!app) return { ok: false, error: "Application not found", httpStatus: 404 };
  // The application must belong to the mission named in the URL.
  if (app.missionId !== opts.missionId) {
    return { ok: false, error: "Application not found", httpStatus: 404 };
  }
  // Only the mission's own fixer (or an admin) may review its applications.
  const [mission] = await db
    .select({ fixerId: missions.fixerId, title: missions.title })
    .from(missions)
    .where(eq(missions.id, app.missionId));
  if (!mission) return { ok: false, error: "Application not found", httpStatus: 404 };
  if (!ownsMissionApplications(opts.viewer, mission.fixerId)) {
    return {
      ok: false,
      error: "Only the mission's fixer or an admin can review its applications",
      httpStatus: 403,
    };
  }

  if (opts.action === "reject") {
    await db
      .update(missionApplications)
      .set({
        status: "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(missionApplications.id, opts.applicationId));
    await recordAudit({
      req: opts.req,
      actorId: reviewerId,
      action: "mission_application_rejected",
      category: "mission",
      targetType: "mission",
      targetId: String(app.missionId),
      message: `Rejected application ${app.id} (character ${app.characterId})`,
    });
    await notifyApplicantOfReview({
      userId: app.userId,
      characterId: app.characterId,
      missionId: app.missionId,
      missionTitle: mission.title,
      action: "reject",
    });
    return { ok: true };
  }

  // Accept: create/refresh the assignment for this player & character.
  await db
    .insert(missionAssignments)
    .values({
      missionId: app.missionId,
      userId: app.userId,
      characterId: app.characterId,
    })
    .onConflictDoUpdate({
      target: [missionAssignments.missionId, missionAssignments.userId],
      set: { characterId: app.characterId },
    });
  await db
    .update(missionApplications)
    .set({
      status: "accepted",
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(missionApplications.id, opts.applicationId));
  await recordAudit({
    req: opts.req,
    actorId: reviewerId,
    action: "mission_application_accepted",
    category: "mission",
    targetType: "mission",
    targetId: String(app.missionId),
    message: `Accepted application ${app.id}; assigned character ${app.characterId}`,
  });
  await notifyApplicantOfReview({
    userId: app.userId,
    characterId: app.characterId,
    missionId: app.missionId,
    missionTitle: mission.title,
    action: "accept",
  });
  return { ok: true };
}

/**
 * Fixer removes an accepted player from a mission. Deleting the assignment row
 * also reverts that player's attendance (attendanceCreditedAt lives on the row,
 * so attendance counts drop back automatically) and any accepted application is
 * flipped to 'rejected' — a fixer decision, unlike player-initiated 'withdrawn'
 * — freeing the slot; the player can still re-apply.
 *
 * GUARD: a player who has already been *paid* (or is mid-payout) cannot be
 * removed — deleting a paid assignment would orphan a real eddies payout. The
 * fixer must reverse the payout first. Unpaid/failed/simulated rows are safe to
 * remove. NPC sign-ups / actor payments are a separate participation and are
 * intentionally left untouched.
 */
export async function removeAssignedPlayer(opts: {
  missionId: number;
  userId: string;
  viewer: MissionViewer;
  req?: Request;
}): Promise<ApplyResult> {
  const [mission] = await db
    .select({ fixerId: missions.fixerId, title: missions.title })
    .from(missions)
    .where(eq(missions.id, opts.missionId));
  if (!mission) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Only the mission's own fixer (or an admin) may manage its roster.
  if (!ownsMissionApplications(opts.viewer, mission.fixerId)) {
    return {
      ok: false,
      error: "Only the mission's fixer or an admin can remove its players",
      httpStatus: 403,
    };
  }

  const [assignment] = await db
    .select()
    .from(missionAssignments)
    .where(
      and(
        eq(missionAssignments.missionId, opts.missionId),
        eq(missionAssignments.userId, opts.userId),
      ),
    );
  if (!assignment) {
    return { ok: false, error: "That player isn't assigned to this mission", httpStatus: 404 };
  }
  if (assignment.paymentStatus === "paid" || assignment.paymentStatus === "processing") {
    return {
      ok: false,
      error:
        "This player has already been paid for this mission. Reverse the payout before removing them.",
      httpStatus: 409,
    };
  }

  const txResult = await db.transaction(async (tx): Promise<ApplyResult> => {
    // Re-read the row under a row lock so a concurrent payout cannot flip it to
    // 'processing'/'paid' between our pre-check and the delete. payMissionPlayers
    // claims the row via a conditional UPDATE, which contends on the same lock:
    // if pay commits first we observe its status here; if we commit first the
    // row is gone and pay's claim affects zero rows.
    const [locked] = await tx
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.id, assignment.id))
      .for("update");
    if (!locked) {
      return { ok: false, error: "That player isn't assigned to this mission", httpStatus: 404 };
    }
    if (locked.paymentStatus === "paid" || locked.paymentStatus === "processing") {
      return {
        ok: false,
        error:
          "This player has already been paid for this mission. Reverse the payout before removing them.",
        httpStatus: 409,
      };
    }
    // Deleting the assignment reverts both the mission attachment and the
    // credited attendance (attendanceCreditedAt is a column on this row).
    await tx.delete(missionAssignments).where(eq(missionAssignments.id, assignment.id));
    // Free the application slot so the player can re-apply later. 'rejected'
    // because removal is a fixer decision ('withdrawn' = player pulled out).
    await tx
      .update(missionApplications)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(
        and(
          eq(missionApplications.missionId, opts.missionId),
          eq(missionApplications.userId, opts.userId),
          eq(missionApplications.status, "accepted"),
        ),
      );
    return { ok: true };
  });
  if (!txResult.ok) return txResult;

  await recordAudit({
    req: opts.req,
    actorId: opts.viewer.id,
    action: "mission_player_removed",
    category: "mission",
    targetType: "mission",
    targetId: String(opts.missionId),
    message: `Removed player ${opts.userId} (character ${assignment.characterId ?? "none"}) from mission`,
  });
  return { ok: true };
}

// ===========================================================================
// NPC SIGN-UPS (Task #185) — players sign up to act as an NPC on a
// not-yet-completed mission; the mission's fixer later confirms attendance
// (which pays them) or marks a no-show.
// ===========================================================================

/** Player signs up to act as an NPC on a posted, not-yet-completed mission. */
export async function signUpAsNpc(opts: {
  missionId: number;
  userId: string;
  characterId?: number | null;
}): Promise<ApplyResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  if (!missionAcceptsNpcSignup(m)) {
    return { ok: false, error: "This mission is not accepting NPC sign-ups", httpStatus: 409 };
  }
  let characterId = opts.characterId ?? null;
  if (characterId != null) {
    const [char] = await db.select().from(characters).where(eq(characters.id, characterId));
    if (!char) return { ok: false, error: "Character not found", httpStatus: 404 };
    if (char.ownerId !== opts.userId) {
      return { ok: false, error: "That character isn't yours", httpStatus: 403 };
    }
  }
  // At most one ACTIVE (signed_up) row per (mission, user): the partial unique
  // index + onConflictDoNothing makes a re-signup idempotent under races
  // (pending-row-dedup). If they already have an active sign-up we only refresh
  // its character choice.
  const inserted = await db
    .insert(missionNpcSignups)
    .values({ missionId: opts.missionId, userId: opts.userId, characterId, state: "signed_up" })
    .onConflictDoNothing({
      target: [missionNpcSignups.missionId, missionNpcSignups.userId],
      where: sql`state = 'signed_up'`,
    })
    .returning({ id: missionNpcSignups.id });
  if (inserted.length === 0) {
    await db
      .update(missionNpcSignups)
      .set({ characterId })
      .where(
        and(
          eq(missionNpcSignups.missionId, opts.missionId),
          eq(missionNpcSignups.userId, opts.userId),
          eq(missionNpcSignups.state, "signed_up"),
        ),
      );
  }
  // isEdit=true when no new row was inserted (idempotent re-signup / character
  // swap) so callers don't re-announce an existing sign-up.
  return { ok: true, isEdit: inserted.length === 0 };
}

/** Player withdraws their own active (not-yet-confirmed) NPC sign-up. */
export async function withdrawNpcSignup(opts: {
  missionId: number;
  userId: string;
}): Promise<ApplyResult> {
  const deleted = await db
    .delete(missionNpcSignups)
    .where(
      and(
        eq(missionNpcSignups.missionId, opts.missionId),
        eq(missionNpcSignups.userId, opts.userId),
        eq(missionNpcSignups.state, "signed_up"),
      ),
    )
    .returning({ id: missionNpcSignups.id });
  if (deleted.length === 0) {
    return { ok: false, error: "No active NPC sign-up to withdraw", httpStatus: 404 };
  }
  return { ok: true };
}

/**
 * Fixer confirms an NPC sign-up. action=attended marks the sign-up attended and
 * pays the player the mission's npcPayAmount (recorded as a mission actor
 * payment so it surfaces in reports + the player's Acting tab; idempotent via
 * the (mission, user) PAID partial unique index). action=no_show marks the
 * sign-up resolved with no payout. Cancelled missions refuse confirmation (the
 * completion lock was removed in #185 — completed missions CAN still confirm).
 */
export async function confirmNpcSignup(opts: {
  missionId: number;
  signupId: number;
  action: "attended" | "no_show";
  viewer: MissionViewer;
  req?: Request;
}): Promise<{ ok: true } | { ok: false; error: string; httpStatus: number }> {
  const [signup] = await db
    .select()
    .from(missionNpcSignups)
    .where(eq(missionNpcSignups.id, opts.signupId));
  if (!signup || signup.missionId !== opts.missionId) {
    return { ok: false, error: "Sign-up not found", httpStatus: 404 };
  }
  const [mission] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!mission) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Only the mission's own fixer (or an admin) may confirm its sign-ups.
  if (!ownsMissionApplications(opts.viewer, mission.fixerId)) {
    return {
      ok: false,
      error: "Only the mission's fixer or an admin can confirm NPC sign-ups",
      httpStatus: 403,
    };
  }
  if (mission.status === "cancelled") {
    return { ok: false, error: "This mission is cancelled. Cancelled missions cannot pay actors.", httpStatus: 409 };
  }

  if (opts.action === "no_show") {
    await db
      .update(missionNpcSignups)
      .set({ state: "no_show", paymentStatus: "unpaid", payAmount: null, paymentError: null, paidAt: null })
      .where(eq(missionNpcSignups.id, signup.id));
    await recordAudit({
      req: opts.req,
      actorId: opts.viewer.id,
      category: "mission",
      action: "mission.npc_no_show",
      targetType: "mission",
      targetId: opts.missionId,
      message: `Marked NPC sign-up ${signup.id} (user ${signup.userId}) as no-show`,
    });
    await applySecondPhaseStatus(opts.missionId);
    return { ok: true };
  }

  // action === "attended": idempotent if already paid/simulated.
  if (signup.state === "attended" && (signup.paymentStatus === "paid" || signup.paymentStatus === "simulated")) {
    return { ok: true };
  }

  const ctx = await getMissionContext();
  const amount = mission.npcPayAmount;
  const now = new Date();
  const [u] = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(eq(users.id, signup.userId));

  const payerId = opts.viewer.id;
  let payerName: string | null = null;
  {
    const [payer] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, payerId));
    payerName = payer?.globalName ?? payer?.username ?? null;
  }

  const actorBase = {
    missionId: opts.missionId,
    missionName: mission.title,
    userId: signup.userId,
    userName: u?.username ?? null,
    fixerId: payerId,
    fixerName: payerName,
    missionDate: mission.startAt,
    amount,
    source: "manual" as const,
    attendanceCreditedAt: now,
    paidAt: now,
  };

  const setSignup = (over: Partial<typeof missionNpcSignups.$inferInsert>) =>
    db
      .update(missionNpcSignups)
      .set({ state: "attended", payAmount: amount, ...over })
      .where(eq(missionNpcSignups.id, signup.id));

  if (!ctx.live) {
    await db.insert(missionActorPayments).values({ ...actorBase, paymentStatus: "simulated" });
    await setSignup({ paymentStatus: "simulated", paymentError: null, paidAt: now });
  } else {
    // Reserve the unique (mission, actor) PAID slot up-front, gated on the
    // mission not being cancelled (mirrors payMissionActors). The completion
    // lock is gone, so completedAt is NOT checked.
    const reservedRes = await db.execute(sql`
      INSERT INTO mission_actor_payments
        (mission_id, mission_name, user_id, user_name, fixer_id, fixer_name,
         mission_date, amount, source, attendance_credited_at, paid_at, payment_status)
      SELECT ${opts.missionId}, ${mission.title}, ${signup.userId}, ${u?.username ?? null},
             ${payerId}, ${payerName}, ${mission.startAt}, ${amount}, 'manual',
             ${now}, ${now}, 'paid'
      WHERE EXISTS (
        SELECT 1 FROM missions WHERE id = ${opts.missionId} AND status <> 'cancelled'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const reserved = (reservedRes.rows ?? []) as Array<{ id: number }>;
    if (reserved.length === 0) {
      // The actor is already paid for this mission (a prior actor/NPC payout) —
      // treat the sign-up as settled rather than double-paying.
      await setSignup({ paymentStatus: "paid", paymentError: null, paidAt: now });
    } else {
      const reservedId = reserved[0].id;
      if (!u?.discordId) {
        await db
          .update(missionActorPayments)
          .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
          .where(eq(missionActorPayments.id, reservedId));
        await setSignup({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null });
      } else {
        const credit = await creditActorPayout({
          userId: signup.userId,
          discordId: u.discordId,
          amount,
          reason: `NPC pay: ${mission.title}`,
          memo: `NPC payout: ${mission.title}`,
          paymentRowId: reservedId,
          relatedEntityType: "mission",
          relatedEntityId: opts.missionId,
        });
        if (!credit.ok) {
          const payErr = credit.error ?? "Wallet payout failed";
          await db
            .update(missionActorPayments)
            .set({ paymentStatus: "failed", paymentError: payErr, paidAt: null })
            .where(eq(missionActorPayments.id, reservedId));
          await setSignup({ paymentStatus: "failed", paymentError: payErr, paidAt: null });
        } else {
          await setSignup({ paymentStatus: "paid", paymentError: null, paidAt: now });
          if (u.username || u.discordId) {
            await postToChannel(
              ctx.npcSpendingChannelId,
              `**NPC payout** — ${mission.title} (#${mission.id})\n<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`,
            ).catch((err) => logger.warn({ err, missionId: opts.missionId }, "npc payout post failed"));
          }
        }
      }
    }
  }

  await recordAudit({
    req: opts.req,
    actorId: opts.viewer.id,
    category: "mission",
    action: "mission.npc_confirm",
    targetType: "mission",
    targetId: opts.missionId,
    message: `${ctx.live ? "LIVE" : "TEST"} confirmed NPC sign-up ${signup.id} (user ${signup.userId}) attended — pay ${amount}`,
  });

  await applySecondPhaseStatus(opts.missionId);
  return { ok: true };
}
