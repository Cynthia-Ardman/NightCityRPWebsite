import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, XCircle } from "lucide-react";

// Shared status badge for player request rows (custom requests + leases),
// used by the per-catalog request section and the consolidated My Requests
// history page so the visual language stays identical everywhere.
export function RequestStatusBadge({ status }: { status: string }) {
  switch (status) {
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
    default:
      return (
        <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none font-mono text-[10px]">
          <Clock className="w-3 h-3 mr-1" /> PENDING
        </Badge>
      );
  }
}
