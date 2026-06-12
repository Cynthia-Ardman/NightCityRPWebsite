import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Check, X, Clock } from "lucide-react";

export type RosterReviewer = { id: string; name?: string | null; avatarUrl?: string | null };
export type RosterVote = { id: string; vote: "approve" | "reject" };

// Shared "who has voted / who hasn't" panel for the three review pipelines
// (character edits, character sheets, custom requests). Given the full
// eligible-reviewer roster and the votes cast so far, it lists each reviewer
// with their status: approved, rejected, or still awaiting.
export function ReviewerRoster({
  eligibleReviewers,
  voters,
  className,
}: {
  eligibleReviewers: RosterReviewer[];
  voters: RosterVote[];
  className?: string;
}) {
  if (!eligibleReviewers || eligibleReviewers.length === 0) return null;
  const voteById = new Map(voters.map((v) => [v.id, v.vote]));
  const votedCount = eligibleReviewers.filter((r) => voteById.has(r.id)).length;

  return (
    <div className={className} data-testid="reviewer-roster">
      <div className="font-mono text-xs text-muted-foreground mb-2">
        {votedCount} of {eligibleReviewers.length} reviewer{eligibleReviewers.length === 1 ? "" : "s"} voted
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {eligibleReviewers.map((r) => {
          const vote = voteById.get(r.id) ?? null;
          return (
            <div
              key={r.id}
              className="flex items-center gap-2 font-mono text-xs"
              data-testid={`roster-reviewer-${r.id}`}
            >
              <Avatar className="h-6 w-6 rounded-none border border-border">
                <AvatarImage src={r.avatarUrl ?? ""} />
                <AvatarFallback className="bg-background text-nc-cyan rounded-none text-[10px]">
                  {(r.name ?? "?").substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className={vote ? "text-foreground" : "text-muted-foreground"}>{r.name ?? r.id}</span>
              {vote === "approve" ? (
                <span className="ml-auto flex items-center gap-1 text-nc-green">
                  <Check className="w-3 h-3" /> APPROVED
                </span>
              ) : vote === "reject" ? (
                <span className="ml-auto flex items-center gap-1 text-destructive">
                  <X className="w-3 h-3" /> REJECTED
                </span>
              ) : (
                <span className="ml-auto flex items-center gap-1 text-muted-foreground/70">
                  <Clock className="w-3 h-3" /> AWAITING
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
