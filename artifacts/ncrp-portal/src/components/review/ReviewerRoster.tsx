export type RosterReviewer = {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  // Display-only: true when this reviewer is a trial fixer (still on probation).
  isTrialFixer?: boolean;
};
export type RosterVote = { id: string; vote: "approve" | "reject" | "pause" };

// Shared "who has voted / who hasn't" panel for the three review pipelines
// (character edits, character sheets, custom requests). Given the full
// eligible-reviewer roster and the votes cast so far, it lists each reviewer as
// a compact colour-coded name chip: green outline = approved, red = rejected,
// grey = still awaiting. Chips wrap, so long display names never break the card
// layout the way the old inline status badges did.
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
      <div className="flex flex-wrap gap-1.5">
        {eligibleReviewers.map((r) => {
          const vote = voteById.get(r.id) ?? null;
          const styles =
            vote === "approve"
              ? "border-nc-green/70 text-nc-green"
              : vote === "reject"
                ? "border-destructive/70 text-destructive"
                : vote === "pause"
                  ? "border-nc-yellow/70 text-nc-yellow"
                  : "border-border text-muted-foreground";
          const status =
            vote === "approve" ? "Approved" : vote === "reject" ? "Rejected" : vote === "pause" ? "Paused" : "Awaiting";
          return (
            <span
              key={r.id}
              data-testid={`roster-reviewer-${r.id}`}
              title={status}
              className={`inline-flex items-center gap-1 rounded-none border px-1.5 py-0.5 font-mono text-[11px] leading-tight ${styles}`}
            >
              {r.name ?? r.id}
              {r.isTrialFixer && (
                <span className="text-orange-400" title="Trial fixer">
                  · trial
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
