import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, XCircle, MessageSquareWarning, FileEdit } from "lucide-react";

// Shared status badge for player request rows (custom requests + leases),
// used by the per-catalog request section and the consolidated My Submissions
// history page so the visual language stays identical everywhere.
export function RequestStatusBadge({
  status,
  stagedApproval = false,
  cancelledLabel = "CANCELLED",
  closedOutcome = null,
}: {
  status: string;
  // Custom requests reach "cancelled" when the PLAYER withdraws them, so
  // owner-facing surfaces pass "WITHDRAWN" to read as the player's own action
  // rather than a staff cancellation. Other subjects keep the default.
  cancelledLabel?: string;
  // For closed (archived) rows: the resolved status the ticket had at close
  // time (approved | rejected | cancelled). When present, the badge shows the
  // real outcome instead of a generic "CLOSED". Null on legacy rows where the
  // outcome wasn't recoverable — those keep the CLOSED badge.
  closedOutcome?: string | null;
  // A decision that is "approved" only STAGES the outcome — a staff member must
  // still click "Close and Apply" before the effect (lease / item / character
  // edit / sheet) takes hold and the owner is DM'd. Owner-facing surfaces for
  // those deferred-apply subjects pass this flag so the row reads as still in
  // review instead of prematurely showing "APPROVED". Immediate-apply subjects
  // (lore, guidebook) leave it false and keep showing APPROVED, and the staff
  // review queue also leaves it false so reviewers still see the approved state.
  stagedApproval?: boolean;
}) {
  // Never surface "APPROVED" to the request owner until the ticket is closed.
  if (stagedApproval && status === "approved") {
    return (
      <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none font-mono text-[10px]">
        <Clock className="w-3 h-3 mr-1" /> IN REVIEW
      </Badge>
    );
  }
  switch (status) {
    case "draft":
      return (
        <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-[10px]">
          <FileEdit className="w-3 h-3 mr-1" /> DRAFT
        </Badge>
      );
    case "approved":
      return (
        <Badge variant="outline" className="border-nc-green text-nc-green rounded-none font-mono text-[10px]">
          <CheckCircle2 className="w-3 h-3 mr-1" /> APPROVED
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="outline" className="border-destructive text-destructive rounded-none font-mono text-[10px]">
          <XCircle className="w-3 h-3 mr-1" /> REJECTED
        </Badge>
      );
    case "changes_requested":
      return (
        <Badge variant="outline" className="border-nc-magenta text-nc-magenta rounded-none font-mono text-[10px]">
          <MessageSquareWarning className="w-3 h-3 mr-1" /> CHANGES REQ
        </Badge>
      );
    case "closed":
      // A closed row is the final archived state — surface the preserved
      // outcome so the player can tell whether it was approved or denied.
      if (closedOutcome === "approved") {
        return (
          <Badge variant="outline" className="border-nc-green text-nc-green rounded-none font-mono text-[10px]">
            <CheckCircle2 className="w-3 h-3 mr-1" /> APPROVED
          </Badge>
        );
      }
      if (closedOutcome === "rejected") {
        return (
          <Badge variant="outline" className="border-destructive text-destructive rounded-none font-mono text-[10px]">
            <XCircle className="w-3 h-3 mr-1" /> REJECTED
          </Badge>
        );
      }
      if (closedOutcome === "cancelled") {
        return (
          <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-[10px]">
            <XCircle className="w-3 h-3 mr-1" /> {cancelledLabel}
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-[10px]">
          <CheckCircle2 className="w-3 h-3 mr-1" /> CLOSED
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-[10px]">
          <XCircle className="w-3 h-3 mr-1" /> {cancelledLabel}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none font-mono text-[10px]">
          <Clock className="w-3 h-3 mr-1" /> PENDING
        </Badge>
      );
  }
}
