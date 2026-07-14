// Shared review-ticket lifecycle bucketing for the player (My Submissions) and
// staff (Pending Requests) pages. The server uses plain-text status columns;
// the three UI sections map onto those statuses as follows:
//   Active   — pending / changes_requested (still needs someone to act)
//   Resolved — approved / rejected / cancelled (decided, not yet archived)
//   Archive  — closed (effects committed and filed away)
export type LifecycleBucket = "active" | "resolved" | "archive";

export function statusBucket(status: string): LifecycleBucket {
  switch (status) {
    case "pending":
    case "changes_requested":
      return "active";
    case "approved":
    case "rejected":
    case "cancelled":
      return "resolved";
    case "closed":
      return "archive";
    default:
      // Drafts and any unknown status fall under Active so they stay visible.
      return "active";
  }
}

export const BUCKET_LABEL: Record<LifecycleBucket, string> = {
  active: "ACTIVE",
  resolved: "RESOLVED",
  archive: "ARCHIVE",
};
