import { portalLink } from "../portalUrl";

// ---------------------------------------------------------------------------
// Workflow state (Task #62) — staff approval pipeline, SEPARATE from runtime
// status. draft → proposal → approved → posted. Only `posted` missions are
// visible to regular players.
// ---------------------------------------------------------------------------
export const WORKFLOW_STATES = ["draft", "proposal", "approved", "posted"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];
export function isWorkflowState(s: unknown): s is WorkflowState {
  return typeof s === "string" && (WORKFLOW_STATES as readonly string[]).includes(s);
}

// Mission visibility. 'public' missions behave as always. 'private' missions
// are visible ONLY to managers (fixers/admins), archivists, the authoring
// fixer, and players a fixer has put on the roster (mission_assignments row) —
// everywhere: board, calendar, search, dashboards. They also never touch
// Discord (no scheduled event, forum thread, sign-up or NPC announcements).
export const MISSION_VISIBILITIES = ["public", "private"] as const;
export type MissionVisibility = (typeof MISSION_VISIBILITIES)[number];
export function isMissionVisibility(s: unknown): s is MissionVisibility {
  return typeof s === "string" && (MISSION_VISIBILITIES as readonly string[]).includes(s);
}

export const JOB_TYPES = ["combat", "non_combat", "mixed"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export function isJobType(s: unknown): s is JobType {
  return typeof s === "string" && (JOB_TYPES as readonly string[]).includes(s);
}

// Recommended spacing between a character's missions. Attendance more recent
// than this triggers a (non-blocking) recency warning during application review.
export const RECENCY_WARNING_DAYS = 21;

// ---------------------------------------------------------------------------
// Mission status lifecycle (Task #57).
//   open → pending → completed → completed_players_paid → completed_paid
//   cancelled (terminal, reachable from anywhere)
// Player/actor payments advance the "completed_*" sub-states; the earlier
// transitions are driven by the fixer (or the auto-pay cron flipping a ran
// mission to completed before paying players).
// ---------------------------------------------------------------------------
export const MISSION_STATUSES = [
  "open",
  "pending",
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

// The completed_* sub-states. Historically some payout paths advanced status
// into these WITHOUT stamping completedAt, so "upcoming" predicates that only
// checked completedAt kept treating finished missions as upcoming. Payout
// advances now stamp completedAt (see completedAtStamp), and upcoming filters
// exclude these statuses as belt-and-braces.
export const MISSION_COMPLETED_STATUSES = [
  "completed",
  "completed_players_paid",
  "completed_paid",
] as const;

export function isMissionStatus(s: unknown): s is MissionStatus {
  return typeof s === "string" && (MISSION_STATUSES as readonly string[]).includes(s);
}

// Public, clickable URL for a mission's detail page. Mirrors the announce/breach
// link pattern: prefer PUBLIC_BASE_URL, fall back to the first Replit domain, and
// degrade to a relative path when neither is set so the post is still readable.
export function buildMissionUrl(missionId: number): string {
  return portalLink(`/missions/${missionId}`);
}

// ===========================================================================
// VIEW BUILDERS
// ===========================================================================

export interface MissionViewer {
  id: string;
  isManager: boolean; // fixer or admin
  isAdmin: boolean;
  isArchivist: boolean; // archivist or admin (can approve proposals)
  // Trial fixer who is NOT a full manager. They may author (create/edit/submit)
  // their OWN missions but get no other fixer tools. Per-mission ownership is
  // enforced at each write path; never grant them blanket manager access.
  isTrialAuthor: boolean;
}
