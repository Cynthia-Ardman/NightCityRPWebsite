// The four-status mission model shared across the Missions list, the fixer
// mission log, the character mission history, and the mission detail page.
//
// Stored tokens (DB + API): pending | completed | completed_and_paid | cancelled
// Display labels and colors live here so every surface stays consistent.

export const MISSION_STATUSES = [
  "pending",
  "completed",
  "completed_and_paid",
  "cancelled",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export function missionStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "completed":
      return "Completed";
    case "completed_and_paid":
      return "Completed and Paid";
    case "cancelled":
      return "Canceled";
    default:
      // Fall back to a humanized version of any unexpected legacy token so
      // nothing renders as a raw snake_case string.
      return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

// Tailwind classes for the bold, color-coded status pill:
//   Pending = yellow/orange, Completed = blue/cyan,
//   Completed and Paid = green, Canceled = red/gray.
export function missionStatusClass(status: string): string {
  switch (status) {
    case "pending":
      return "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
    case "completed":
      return "border-nc-cyan text-nc-cyan bg-nc-cyan/10";
    case "completed_and_paid":
      return "border-green-500 text-green-400 bg-green-500/10";
    case "cancelled":
      return "border-destructive text-destructive bg-destructive/10";
    default:
      return "border-muted-foreground text-muted-foreground bg-muted/10";
  }
}
