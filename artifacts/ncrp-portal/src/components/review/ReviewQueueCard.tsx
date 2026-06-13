import { useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, MessageSquare, type LucideIcon } from "lucide-react";
import { UnseenDot } from "@/components/review/ReviewLifecycleUI";
import { ReviewerRoster, type RosterReviewer, type RosterVote } from "@/components/review/ReviewerRoster";
import ReviewCommentThread, { AwaitingVoteBanner } from "@/components/ReviewCommentThread";

export type ReviewSubjectType = "request" | "sheet" | "edit";

// Shared review-queue card used across the three reviewer pipelines (Misc
// Requests, New Characters, Character Edits). It standardizes the layout —
// badge / title / subtitle / date header, a free-form body slot, the
// vote tally, the reviewer roster, an inline actions slot (vote / reject /
// override), and a self-managed "View & Respond" comment thread — so all
// three queues look and behave the same. Subject-specific concerns (which
// vote hook to call, what approve params are needed) stay in each tab and are
// passed in via `tally` and `actions`.
export function ReviewQueueCard({
  subjectType,
  id,
  testId,
  unseen = false,
  badgeLabel,
  badgeIcon: Icon,
  badgeClassName = "border-nc-cyan text-nc-cyan",
  title,
  subtitle,
  date,
  children,
  tally,
  roster,
  showRoster = false,
  actions,
  showThread = true,
  awaitingVote = false,
  markSeenOnMount = false,
}: {
  subjectType: ReviewSubjectType;
  id: number;
  testId: string;
  unseen?: boolean;
  badgeLabel: string;
  badgeIcon: LucideIcon;
  badgeClassName?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  date?: string | number | Date | null;
  children?: ReactNode;
  tally?: ReactNode;
  roster?: { eligibleReviewers: RosterReviewer[]; voters: RosterVote[] };
  showRoster?: boolean;
  actions?: ReactNode;
  showThread?: boolean;
  awaitingVote?: boolean;
  markSeenOnMount?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasFooter =
    tally != null ||
    (showRoster && roster && roster.eligibleReviewers.length > 0) ||
    actions != null ||
    showThread;

  return (
    <Card className="rounded-none border-border bg-card/50 flex flex-col" data-testid={testId}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UnseenDot show={unseen} testid={`dot-unseen-${subjectType}-${id}`} />
            <Badge variant="outline" className={`rounded-none font-mono text-[10px] ${badgeClassName}`}>
              <Icon className="w-3 h-3 mr-1" /> {badgeLabel}
            </Badge>
          </div>
          {date != null && (
            <span className="text-xs font-mono text-muted-foreground">
              {new Date(date).toLocaleDateString()}
            </span>
          )}
        </div>
        <CardTitle className="text-lg font-display truncate mt-2">{title}</CardTitle>
        {subtitle != null && (
          <CardDescription className="font-mono text-xs">{subtitle}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col flex-1 gap-4">
        {children}
        {hasFooter && (
          <div className="mt-auto pt-3 border-t border-border/40 space-y-3">
            {tally}
            {showRoster && roster && roster.eligibleReviewers.length > 0 && (
              <ReviewerRoster
                eligibleReviewers={roster.eligibleReviewers}
                voters={roster.voters}
              />
            )}
            {actions}
            {showThread && (
              <>
                <Button
                  variant="outline"
                  className="w-full rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
                  onClick={() => setExpanded((v) => !v)}
                  data-testid={`button-view-respond-${subjectType}-${id}`}
                >
                  <MessageSquare className="w-3 h-3 mr-1" />
                  VIEW &amp; RESPOND
                  {expanded ? (
                    <ChevronUp className="w-3 h-3 ml-1" />
                  ) : (
                    <ChevronDown className="w-3 h-3 ml-1" />
                  )}
                </Button>
                {expanded && (
                  <div className="space-y-3">
                    <AwaitingVoteBanner show={awaitingVote} />
                    <ReviewCommentThread
                      subjectType={subjectType}
                      subjectId={id}
                      markSeenOnMount={markSeenOnMount}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
