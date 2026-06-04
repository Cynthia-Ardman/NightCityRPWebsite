import { sendDirectMessage } from "./discord";
import { logger } from "./logger";

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
  amount: number;
  label: string;
  characterName?: string | null;
  newBalance?: number | null;
}): Promise<void> {
  if (!opts.discordId) return;
  try {
    const who = opts.characterName ? ` (${opts.characterName})` : "";
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
  amount: number;
  missionTitle: string;
  newBalance?: number | null;
}): Promise<void> {
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
