// Selection logic for the "Mission today" dashboard banner. Kept as pure
// functions (no hooks) so the calendar-day and character-eligibility rules are
// unit-testable without mocking the dashboard's query hooks.

/** Minimal mission shape the banner needs (subset of MissionSummary). */
export interface MissionTodayInput {
  id: number;
  title: string;
  startAt?: string | null;
  status: string;
  workflowState?: string | null;
  mySignup?: { state?: string | null } | null;
  npcSignupOpen?: boolean | null;
  myApplication?: { status?: string | null } | null;
  myCharacterId?: number | null;
}

export interface MissionTodayItem {
  id: number;
  title: string;
  start: Date;
  npcSignupOpen: boolean;
  signedUpAsNpc: boolean;
  /** Viewer is on this mission as a PLAYER (accepted application or rostered character). */
  playerOnMission: boolean;
}

/** True when the two instants fall on the same calendar day in the viewer's local timezone. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * How long after a mission's start time the banner keeps showing. A mission
 * night is realistically wrapped a couple hours after kickoff, so the
 * reminder (and its "join comms" button) disappears rather than lingering
 * until midnight.
 */
export const MISSION_BANNER_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Missions that run TODAY (viewer-local calendar day), soonest first. Only
 * active (open/pending), player-visible (posted) missions qualify — cancelled,
 * completed, and unposted pipeline states never trigger the banner. Missions
 * whose start already passed still count while they're plausibly running, but
 * drop off once more than MISSION_BANNER_GRACE_MS has elapsed since start —
 * the mission is over, the reminder is stale.
 */
export function selectTodaysMissions(
  missions: readonly MissionTodayInput[] | null | undefined,
  now: Date = new Date(),
): MissionTodayItem[] {
  const out: MissionTodayItem[] = [];
  for (const m of missions ?? []) {
    if (m.status !== "open" && m.status !== "pending") continue;
    // The API already hides unposted missions from players, but managers see
    // the full pipeline — never remind anyone about a draft/proposal.
    if (m.workflowState != null && m.workflowState !== "posted") continue;
    if (!m.startAt) continue;
    const start = new Date(m.startAt);
    if (Number.isNaN(start.getTime())) continue;
    if (!isSameLocalDay(start, now)) continue;
    if (now.getTime() - start.getTime() > MISSION_BANNER_GRACE_MS) continue;
    out.push({
      id: m.id,
      title: m.title,
      start,
      npcSignupOpen: m.npcSignupOpen === true,
      signedUpAsNpc: m.mySignup?.state === "signed_up",
      playerOnMission: m.myApplication?.status === "accepted" || m.myCharacterId != null,
    });
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

/** Minimal character shape the banner needs (subset of Character). */
export interface CharacterEligibilityInput {
  kind: string;
  approved?: boolean;
  archived?: boolean;
  lifeStatus?: string | null;
}

/**
 * True when the viewer owns at least one accepted, playable character: an
 * approved, non-archived PC whose life status is active (or LOA — still
 * their character, still worth the reminder). Dead/retired/missing PCs and
 * NPCs don't count, so those viewers get the NPC-signup variant instead.
 */
export function hasAcceptedCharacter(
  characters: readonly CharacterEligibilityInput[] | null | undefined,
): boolean {
  return (characters ?? []).some(
    (c) =>
      c.kind === "pc" &&
      c.approved === true &&
      c.archived !== true &&
      ["active", "loa", null, undefined].includes(c.lifeStatus as string | null | undefined),
  );
}
