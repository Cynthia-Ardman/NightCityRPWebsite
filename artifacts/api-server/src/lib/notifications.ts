import { db, notifications } from "@workspace/db";
import { sendDirectMessage } from "./discord";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// In-portal notification feed. Writes a row to `notifications` for the bell
// dropdown in the portal. ALWAYS fire-and-forget at the call site (`void
// createNotification(...)`) and never throws — a miss must not affect the
// action that triggered it. Additive to the Discord DM helpers below: the DM
// path is unchanged, the portal row is written alongside it.
// ---------------------------------------------------------------------------
export async function createNotification(opts: {
  userId: string | null | undefined;
  type: string;
  title: string;
  body?: string | null;
  href?: string | null;
}): Promise<void> {
  if (!opts.userId) return;
  try {
    await db.insert(notifications).values({
      userId: opts.userId,
      type: opts.type,
      title: opts.title,
      body: opts.body ?? null,
      href: opts.href ?? null,
    });
  } catch (err) {
    logger.warn({ err, userId: opts.userId, type: opts.type }, "in-portal notification write failed");
  }
}

// ---------------------------------------------------------------------------
// Player wallet DM notifications. Thin, fail-safe wrappers over
// sendDirectMessage used to tell a player when money automatically moves in or
// out of their wallet (mission payouts, autobilled rent/fees/meds). Like every
// other Discord write these inherit sendDirectMessage's gating: no bot token or
// a non-deployment env => the send is skipped. Delivery is best-effort — a miss
// (DMs disabled, user left the server, Discord error) must never throw or block
// the money movement that triggered it, so every call is wrapped here.
// ---------------------------------------------------------------------------

function fmtEddies(n: number): string {
  return `€$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function balanceLine(newBalance?: number | null): string {
  return typeof newBalance === "number" ? ` New balance: ${fmtEddies(newBalance)}.` : "";
}

/**
 * DM a player that an automatic charge was debited from their wallet (rent,
 * trauma team, baseline living cost, Xanadu Gold, cyberpsychosis meds, etc.).
 * `amount` is the cost (sign-agnostic — always shown as a debit). Never throws.
 */
export async function notifyAutoCharge(opts: {
  discordId: string | null | undefined;
  // Portal user id — when present, an in-portal bell notification is written
  // alongside the DM (additive; the DM path is unchanged).
  userId?: string | null;
  amount: number;
  label: string;
  characterName?: string | null;
  newBalance?: number | null;
}): Promise<void> {
  const who = opts.characterName ? ` (${opts.characterName})` : "";
  void createNotification({
    userId: opts.userId,
    type: "auto_charge",
    title: `Automatic charge — ${fmtEddies(opts.amount)}`,
    body: `${opts.label}${who}.${balanceLine(opts.newBalance)}`,
    href: "/ledger",
  });
  if (!opts.discordId) return;
  try {
    const content =
      `**Automatic charge** — ${fmtEddies(opts.amount)} for ${opts.label}${who}.` +
      balanceLine(opts.newBalance);
    await sendDirectMessage(opts.discordId, content);
  } catch (err) {
    logger.warn({ err, discordId: opts.discordId, label: opts.label }, "auto-charge DM failed");
  }
}

/**
 * DM a player that they received a mission payout. Never throws.
 */
export async function notifyMissionPayout(opts: {
  discordId: string | null | undefined;
  // Portal user id — when present, an in-portal bell notification is written
  // alongside the DM (additive; the DM path is unchanged).
  userId?: string | null;
  amount: number;
  missionTitle: string;
  missionId?: number | null;
  newBalance?: number | null;
}): Promise<void> {
  void createNotification({
    userId: opts.userId,
    type: "mission_payout",
    title: `Mission payout — ${fmtEddies(opts.amount)}`,
    body: `You received ${fmtEddies(opts.amount)} for "${opts.missionTitle}".${balanceLine(opts.newBalance)}`,
    href: opts.missionId != null ? `/missions/${opts.missionId}` : "/ledger",
  });
  if (!opts.discordId) return;
  try {
    const content =
      `**Mission payout** — You received ${fmtEddies(opts.amount)} for "${opts.missionTitle}".` +
      balanceLine(opts.newBalance);
    await sendDirectMessage(opts.discordId, content);
  } catch (err) {
    logger.warn({ err, discordId: opts.discordId }, "mission payout DM failed");
  }
}
