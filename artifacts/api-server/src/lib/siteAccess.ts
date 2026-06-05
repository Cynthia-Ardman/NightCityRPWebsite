import { db, botConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { hasRole } from "./discord";

// ---------------------------------------------------------------------------
// Staff-only login lockdown.
//
// When an admin flips this switch on, only staff may sign in or use the portal.
// Everyone else is turned away at login (no session created) AND blocked from
// every gated data route if they already had a session. The flag lives in
// bot_config under `login_restricted` and defaults OFF, so a fresh environment
// is open to all members until an admin explicitly restricts it.
// ---------------------------------------------------------------------------
export const LOGIN_RESTRICTED_KEY = "login_restricted";

// Role groups exempt from the lockdown. NOTE: "coordinator" is part of the
// FIXER group in ROLE_NAMES, so coordinators are covered by "FIXER".
const STAFF_GROUPS = ["ADMIN", "FIXER", "ARCHIVIST"] as const;

/** True when the user's Discord roles include any lockdown-exempt staff group. */
export function isLockdownExempt(roles: string[] | null | undefined): boolean {
  const r = roles ?? [];
  return STAFF_GROUPS.some((g) => hasRole(r, g));
}

// Last value we successfully read from bot_config. On a transient DB read error
// we fall back to THIS rather than a hardcoded default, so an in-flight error
// never flips behavior: a live lockdown stays locked, and the normal open state
// stays open. It seeds to false so a cold process that has never managed to read
// the flag stays open to all members (the common steady state) instead of
// locking everyone out on a startup blip.
let lastKnownRestricted = false;

/**
 * Whether staff-only login restriction is currently ON. Only the literal JSON
 * `true` counts as ON; a missing row or false means OFF. On a read error we
 * return the last successfully-read value (defaulting OFF at cold start) so a DB
 * blip can neither silently bypass an active lockdown nor lock every member out
 * while restriction is off.
 */
export async function isLoginRestricted(): Promise<boolean> {
  try {
    const [row] = await db
      .select()
      .from(botConfig)
      .where(eq(botConfig.key, LOGIN_RESTRICTED_KEY));
    lastKnownRestricted = row?.value === true;
    return lastKnownRestricted;
  } catch (err) {
    logger.warn(
      { err, lastKnownRestricted },
      "login_restricted flag read failed; falling back to last-known value",
    );
    return lastKnownRestricted;
  }
}
