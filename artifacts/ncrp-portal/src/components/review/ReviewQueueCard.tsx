import { useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, MessageSquare, type LucideIcon } from "lucide-react";
import { UnseenDot } from "@/components/review/ReviewLifecycleUI";
import { ReviewerRoster, type RosterReviewer, type RosterVote } from "@/components/review/ReviewerRoster";
import ReviewCommentThread, { AwaitingVoteBanner } from "@/components/ReviewCommentThread";

export type ReviewSubjectType = "request" | "sheet" | "edit" | "lore";

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
  initiallyExpanded = false,
  tone = "default",
  discussionUnread = 0,
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
  // Whole-card decision tint: a decided (approved/rejected) ticket that is
  // awaiting CLOSE & APPLY / CLOSE & DENY turns green / red in the queue so
  // staff can see its state at a glance. "default" keeps the neutral card.
  tone?: "default" | "approved" | "rejected";
  // Seed the comment-thread section open on mount — used by ?focus= deep links
  // from the Discord CS-approver post so the linked ticket lands expanded.
  initiallyExpanded?: boolean;
  // Count of unread in-app discussion comments (from the other party) to show
  // as a numeric badge on the VIEW & RESPOND button; clears when the thread is
  // opened (which marks the ticket seen). 0 hides the badge.
  discussionUnread?: number;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const hasFooter =
    tally != null ||
    (showRoster && roster && roster.eligibleReviewers.length > 0) ||
    actions != null ||
    showThread;

  const toneClass =
    tone === "approved"
      ? "border-nc-green/70 bg-nc-green/5"
      : tone === "rejected"
        ? "border-destructive/70 bg-destructive/5"
        : "border-border bg-card/50";

  return (
    <Card
      id={`review-${subjectType}-${id}`}
      className={`rounded-none flex flex-col ${toneClass} ${
        unseen ? "border-l-2 border-l-nc-magenta" : ""
      }`}
      data-testid={testId}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UnseenDot show={unseen} testid={`dot-unseen-${subjectType}-${id}`} />
            <Badge variant="outline" className={`rounded-none font-mono text-[10px] ${badgeClassName}`}>
              <Icon className="w-3 h-3 mr-1" /> {badgeLabel}
            </Badge>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {date != null && (
              <span className="text-xs font-mono text-muted-foreground">
                {new Date(date).toLocaleDateString()}
              </span>
            )}
          </div>
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
                  {discussionUnread > 0 && (
                    <span
                      className="ml-2 inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-nc-magenta text-background font-mono text-[10px] font-bold"
                      data-testid={`discussion-unread-${subjectType}-${id}`}
                    >
                      {discussionUnread}
                    </span>
                  )}
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
