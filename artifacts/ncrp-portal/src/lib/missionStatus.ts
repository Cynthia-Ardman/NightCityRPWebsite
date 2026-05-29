// The six-status mission lifecycle shared across the Missions list, the fixer
// mission tools, the character mission history, and the mission detail page.
//
// Stored tokens (DB + API):
//   open | pending | completed | completed_players_paid | completed_paid | cancelled
// Display labels and colors live here so every surface stays consistent.

export const MISSION_STATUSES = [
  "open",
  "pending",
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export function missionStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "pending":
      return "Pending";
    case "completed":
      return "Completed";
    case "completed_players_paid":
      return "Players Paid";
    case "completed_paid":
      return "Fully Paid";
    case "cancelled":
      return "Canceled";
    default:
      // Fall back to a humanized version of any unexpected legacy token so
      // nothing renders as a raw snake_case string.
      return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

// Tailwind classes for the bold, color-coded status pill:
//   Open = magenta (recruiting), Pending = yellow (scheduled/awaiting),
//   Completed = cyan, Players Paid = teal, Fully Paid = green,
//   Canceled = destructive.
export function missionStatusClass(status: string): string {
  switch (status) {
    case "open":
      return "border-nc-magenta text-nc-magenta bg-nc-magenta/10";
    case "pending":
      return "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
    case "completed":
      return "border-nc-cyan text-nc-cyan bg-nc-cyan/10";
    case "completed_players_paid":
      return "border-teal-500 text-teal-400 bg-teal-500/10";
    case "completed_paid":
      return "border-green-500 text-green-400 bg-green-500/10";
    case "cancelled":
      return "border-destructive text-destructive bg-destructive/10";
    default:
      return "border-muted-foreground text-muted-foreground bg-muted/10";
  }
}

// Mission difficulty tiers (1-4). Higher tiers are deadlier jobs with bigger
// payouts. Labels and colors are shared across every surface.
export const MISSION_TIERS = [1, 2, 3, 4] as const;
export type MissionTier = (typeof MISSION_TIERS)[number];

export function missionTierLabel(tier: number): string {
  switch (tier) {
    case 1:
      return "Tier 1";
    case 2:
      return "Tier 2";
    case 3:
      return "Tier 3";
    case 4:
      return "Tier 4";
    default:
      return `Tier ${tier}`;
  }
}

// The Task #62 workflow lifecycle (distinct from runtime status):
//   draft → proposal → approved → posted
// Only `posted` missions are visible to players.
export const WORKFLOW_STATES = ["draft", "proposal", "approved", "posted"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export function missionWorkflowLabel(state: string): string {
  switch (state) {
    case "draft":
      return "Draft";
    case "proposal":
      return "Proposal";
    case "approved":
      return "Approved";
    case "posted":
      return "Posted";
    default:
      return state.replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export function missionWorkflowClass(state: string): string {
  switch (state) {
    case "draft":
      return "border-muted-foreground text-muted-foreground bg-muted/10";
    case "proposal":
      return "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
    case "approved":
      return "border-nc-cyan text-nc-cyan bg-nc-cyan/10";
    case "posted":
      return "border-green-500 text-green-400 bg-green-500/10";
    default:
      return "border-muted-foreground text-muted-foreground bg-muted/10";
  }
}

export const JOB_TYPES = ["combat", "non_combat", "mixed"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export function jobTypeLabel(t: string | null | undefined): string {
  switch (t) {
    case "combat":
      return "Combat";
    case "non_combat":
      return "Non-Combat";
    case "mixed":
      return "Mixed";
    default:
      return "—";
  }
}

export function missionTierClass(tier: number): string {
  switch (tier) {
    case 1:
      return "border-nc-cyan/60 text-nc-cyan bg-nc-cyan/10";
    case 2:
      return "border-nc-yellow/60 text-nc-yellow bg-nc-yellow/10";
    case 3:
      return "border-orange-500/60 text-orange-400 bg-orange-500/10";
    case 4:
      return "border-destructive/60 text-destructive bg-destructive/10";
    default:
      return "border-muted-foreground text-muted-foreground bg-muted/10";
  }
}
