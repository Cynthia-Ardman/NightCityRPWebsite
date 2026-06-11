import { db, botConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// New-character submission kill switch.
//
// When an admin flips this on, players can no longer submit NEW player
// characters (PC sheets) for review. Editing existing characters (pending
// edits / sheet edits in review) and creating NPCs (a fixer/admin-only sheet
// type) remain available. The flag lives in bot_config under
// `character_submissions_disabled` and defaults OFF, so a fresh environment
// accepts new character submissions until an admin explicitly disables them.
// ---------------------------------------------------------------------------
export const CHARACTER_SUBMISSIONS_DISABLED_KEY = "character_submissions_disabled";

// Last value we successfully read. On a transient DB read error we fall back to
// this rather than a hardcoded default so a blip never flips behavior. It seeds
// to false (fail-open) so a cold process that has never read the flag keeps
// accepting submissions — the common steady state — instead of locking all
// players out of character creation on a startup hiccup.
let lastKnownDisabled = false;

/**
 * Whether new player-character submissions are currently disabled. Only the
 * literal JSON `true` counts as ON; a missing row or false means OFF. On a read
 * error we return the last successfully-read value (defaulting OFF at cold
 * start).
 */
export async function areCharacterSubmissionsDisabled(): Promise<boolean> {
  try {
    const [row] = await db
      .select()
      .from(botConfig)
      .where(eq(botConfig.key, CHARACTER_SUBMISSIONS_DISABLED_KEY));
    lastKnownDisabled = row?.value === true;
    return lastKnownDisabled;
  } catch (err) {
    logger.warn(
      { err, lastKnownDisabled },
      "character_submissions_disabled flag read failed; falling back to last-known value",
    );
    return lastKnownDisabled;
  }
}
