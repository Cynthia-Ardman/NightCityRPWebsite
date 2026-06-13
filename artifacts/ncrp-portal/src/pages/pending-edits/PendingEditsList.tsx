import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPendingEdits,
  useVotePendingEdit,
  useOverridePendingEdit,
  useGetReviewUnseenIds,
  getGetReviewUnseenIdsQueryKey,
  getListPendingEditsQueryKey,
  type PendingEditSummary,
} from "@workspace/api-client-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, CheckCircle2, XCircle, Clock, MessageSquareWarning } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useToast } from "@/hooks/use-toast";
import { type LifecycleBucket } from "@/lib/reviewLifecycle";
import { UnseenDot, useReviewTicketActions, LifecycleActions, BucketSection } from "@/components/review/ReviewLifecycleUI";
import { ReviewQueueCard } from "@/components/review/ReviewQueueCard";

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none font-mono text-xs animate-pulse">
          <Clock className="w-3 h-3 mr-1" /> PENDING
        </Badge>
      );
    case "approved":
      return (
        <Badge variant="outline" className="border-nc-green text-nc-green rounded-none font-mono text-xs">
          <CheckCircle2 className="w-3 h-3 mr-1" /> APPROVED
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="outline" className="border-destructive text-destructive rounded-none font-mono text-xs">
          <XCircle className="w-3 h-3 mr-1" /> REJECTED
        </Badge>
      );
    case "changes_requested":
      return (
        <Badge variant="outline" className="border-nc-magenta text-nc-magenta rounded-none font-mono text-xs">
          <MessageSquareWarning className="w-3 h-3 mr-1" /> CHANGES REQ
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-xs">
          CANCELLED
        </Badge>
      );
    default:
      return <Badge variant="outline" className="rounded-none font-mono text-xs">{status}</Badge>;
  }
}

function EditRow({
  e,
  unseen,
  showLifecycle,
  actions,
}: {
  e: PendingEditSummary;
  unseen: boolean;
  showLifecycle: boolean;
  actions: ReturnType<typeof useReviewTicketActions>;
}) {
  const changed = e.proposedDiff ? Object.keys(e.proposedDiff) : [];
  return (
    <div className="border border-border bg-card/30">
      <Link href={`/pending-edits/${e.id}`}>
        <a
          className="block hover:border-nc-cyan hover:bg-card/60 p-4 transition-colors"
          data-testid={`pending-edit-row-${e.id}`}
        >
          <div className="flex items-center gap-4">
            <UnseenDot show={unseen} testid={`dot-unseen-edit-${e.id}`} />
            <Avatar className="h-10 w-10 rounded-none border border-border">
              <AvatarImage src={e.submitterAvatarUrl ?? ""} />
              <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
                {(e.submitterName ?? "?").substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="font-display text-lg text-foreground truncate">{e.characterName}</div>
              <div className="font-mono text-xs text-muted-foreground">
                by {e.submitterName ?? "(unknown)"} · {new Date(e.submittedAt).toLocaleString()}
              </div>
              {changed.length > 0 && (
                <div className="font-mono text-xs text-nc-cyan/70 mt-1">
                  {changed.length} field{changed.length === 1 ? "" : "s"}: {changed.join(", ")}
                </div>
              )}
              {e.updateNote && (
                <div className="font-mono text-xs text-foreground/80 italic mt-1 line-clamp-1">"{e.updateNote}"</div>
              )}
              {e.status === "pending" && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5" data-testid={`pending-edit-tally-${e.id}`}>
                  <span className="font-mono text-xs text-nc-green">
                    {e.approveCount}/{e.threshold} approve
                  </span>
                  {e.rejectCount > 0 && (
                    <span className="font-mono text-xs text-destructive">{e.rejectCount} reject</span>
                  )}
                  {e.voters.length === 0 ? (
                    <span className="font-mono text-xs text-muted-foreground italic">no votes yet</span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1">
                      {e.voters.map((v, i) => (
                        <Badge
                          key={`${e.id}-${v.name}-${i}`}
                          variant="outline"
                          className={`rounded-none font-mono text-[10px] ${
                            v.vote === "approve"
                              ? "border-nc-green/60 text-nc-green"
                              : "border-destructive/60 text-destructive"
                          }`}
                        >
                          {v.vote === "approve" ? (
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                          ) : (
                            <XCircle className="w-3 h-3 mr-1" />
                          )}
                          {v.name}
                        </Badge>
                      ))}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="shrink-0">{statusBadge(e.status)}</div>
          </div>
        </a>
      </Link>
      {showLifecycle && (
        <div className="px-4 pb-4 pt-0">
          <LifecycleActions subjectType="edit" id={e.id} status={e.status} actions={actions} />
        </div>
      )}
    </div>
  );
}

// Active-bucket reviewer card: mirrors the Misc Requests / New Characters
// queue cards (shared ReviewQueueCard) with inline vote / reject / override.
function EditReviewCard({
  e,
  unseen,
  isReviewer,
  isAdmin,
  vote,
  override,
  busy,
}: {
  e: PendingEditSummary;
  unseen: boolean;
  isReviewer: boolean;
  isAdmin: boolean;
  vote: ReturnType<typeof useVotePendingEdit>;
  override: ReturnType<typeof useOverridePendingEdit>;
  busy: boolean;
}) {
  const changed = e.proposedDiff ? Object.keys(e.proposedDiff) : [];
  const my = e.myVote;
  return (
    <ReviewQueueCard
      subjectType="edit"
      id={e.id}
      testId={`card-pending-edit-${e.id}`}
      unseen={unseen}
      badgeLabel="CHARACTER EDIT"
      badgeIcon={ShieldAlert}
      badgeClassName="border-nc-magenta text-nc-magenta"
      title={e.characterName}
      subtitle={`by ${e.submitterName ?? "(unknown)"}`}
      date={e.submittedAt}
      showRoster={isReviewer}
      roster={{
        eligibleReviewers: e.eligibleReviewers ?? [],
        voters: e.voters.map((v) => ({ id: v.id, vote: v.vote })),
      }}
      markSeenOnMount={isReviewer}
      awaitingVote={isReviewer && e.status === "pending" && !my}
      tally={
        <div className="font-mono text-xs text-muted-foreground" data-testid={`tally-edit-${e.id}`}>
          <span className="text-nc-green">{e.approveCount}</span>/{e.threshold} approve ·{" "}
          <span className="text-destructive">{e.rejectCount}</span> reject
          {my ? (
            <span className="ml-2">
              · you voted{" "}
              <span className={my.vote === "approve" ? "text-nc-green" : "text-destructive"}>
                {my.vote.toUpperCase()}
              </span>
            </span>
          ) : null}
        </div>
      }
      actions={
        <div className="space-y-2">
          {isReviewer && e.status === "pending" && (
            <div className="flex flex-wrap gap-2">
              <Button
                className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                disabled={busy}
                onClick={() => vote.mutate({ id: e.id, data: { vote: "approve" } })}
                data-testid={`button-approve-edit-${e.id}`}
              >
                {my?.vote === "approve" ? "VOTED APPROVE" : "VOTE APPROVE"}
              </Button>
              <Button
                variant="outline"
                className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                disabled={busy}
                onClick={() => vote.mutate({ id: e.id, data: { vote: "reject" } })}
                data-testid={`button-reject-edit-${e.id}`}
              >
                {my?.vote === "reject" ? "VOTED REJECT" : "VOTE REJECT"}
              </Button>
              {isAdmin && (
                <Button
                  variant="outline"
                  className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                  disabled={busy}
                  onClick={() => override.mutate({ id: e.id, data: { decision: "approve" } })}
                  data-testid={`button-override-edit-${e.id}`}
                >
                  OVERRIDE
                </Button>
              )}
            </div>
          )}
          <Link href={`/pending-edits/${e.id}`}>
            <Button
              variant="outline"
              className="w-full rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
              data-testid={`button-open-edit-${e.id}`}
            >
              OPEN EDIT
            </Button>
          </Link>
        </div>
      }
    >
      {changed.length > 0 ? (
        <div className="font-mono text-xs text-nc-cyan/80" data-testid={`edit-fields-${e.id}`}>
          {changed.length} field{changed.length === 1 ? "" : "s"}: {changed.join(", ")}
        </div>
      ) : (
        <div className="font-mono text-xs text-muted-foreground italic">No field changes.</div>
      )}
      {e.updateNote ? (
        <div className="font-mono text-xs text-foreground/80 italic">"{e.updateNote}"</div>
      ) : null}
    </ReviewQueueCard>
  );
}

export default function PendingEditsList({
  embedded = false,
  activeOnly = false,
}: { embedded?: boolean; activeOnly?: boolean } = {}) {
  const { data: me } = useEffectiveMe();
  const isReviewer = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  return isReviewer ? (
    <ReviewerEditsList embedded={embedded} activeOnly={activeOnly} />
  ) : (
    <PlayerEditsList embedded={embedded} />
  );
}

// Reviewer view: bucketed Active / Resolved / Archive with unseen dots and
// close/reopen on resolved tickets. When `activeOnly` is set, only the active
// bucket is shown — terminal (resolved/archived) edits live in the cross-cutting
// Completed / Denied tabs of the Pending Requests page.
function ReviewerEditsList({ embedded, activeOnly = false }: { embedded: boolean; activeOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: active, isLoading: la } = useListPendingEdits({ bucket: "active" });
  const { data: resolved, isLoading: lr } = useListPendingEdits(
    { bucket: "resolved" },
    { query: { enabled: !activeOnly, queryKey: getListPendingEditsQueryKey({ bucket: "resolved" }) } },
  );
  const { data: archive, isLoading: lar } = useListPendingEdits(
    { bucket: "archive" },
    { query: { enabled: !activeOnly, queryKey: getListPendingEditsQueryKey({ bucket: "archive" }) } },
  );
  const { data: unseenIds } = useGetReviewUnseenIds();
  const { data: me } = useEffectiveMe();
  const { toast } = useToast();
  const isAdmin = !!me?.isAdmin;
  const isLoading = la || (!activeOnly && (lr || lar));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
  };
  const actions = useReviewTicketActions(invalidate);
  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
  const vote = useVotePendingEdit({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        const decided = (res as { decided?: string })?.decided;
        toast({
          title:
            decided === "approved"
              ? "Edit approved — majority reached"
              : decided === "rejected"
                ? "Edit rejected"
                : "Vote recorded",
        });
      },
      onError: (err) =>
        toast({ title: "Vote failed", description: errMsg(err, "Vote failed"), variant: "destructive" }),
    },
  });
  const override = useOverridePendingEdit({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Edit approved via override" });
      },
      onError: (err) =>
        toast({ title: "Override failed", description: errMsg(err, "Override failed"), variant: "destructive" }),
    },
  });
  const voteBusy = vote.isPending || override.isPending;
  const unseen = new Set(unseenIds?.edit ?? []);

  const buckets: Record<LifecycleBucket, PendingEditSummary[]> = {
    active: (active ?? []) as PendingEditSummary[],
    resolved: (resolved ?? []) as PendingEditSummary[],
    archive: (archive ?? []) as PendingEditSummary[],
  };
  const shownBuckets: LifecycleBucket[] = activeOnly ? ["active"] : ["active", "resolved", "archive"];

  return (
    <div className={embedded ? "space-y-6" : "max-w-7xl mx-auto p-6 space-y-6"}>
      {!embedded && <EditQueueHeader />}
      {isLoading ? (
        <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>
      ) : (
        <div className="space-y-8" data-testid="pending-edits-list">
          {shownBuckets.map((b) => (
            <BucketSection key={b} bucket={b} count={buckets[b].length}>
              {b === "active" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {buckets[b].map((e) => (
                    <EditReviewCard
                      key={e.id}
                      e={e}
                      unseen={unseen.has(e.id)}
                      isReviewer
                      isAdmin={isAdmin}
                      vote={vote}
                      override={override}
                      busy={voteBusy}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {buckets[b].map((e) => (
                    <EditRow
                      key={e.id}
                      e={e}
                      unseen={unseen.has(e.id)}
                      showLifecycle={b === "resolved"}
                      actions={actions}
                    />
                  ))}
                </div>
              )}
            </BucketSection>
          ))}
        </div>
      )}
    </div>
  );
}

// Player view: flat list of their own submissions (unchanged behavior).
function PlayerEditsList({ embedded }: { embedded: boolean }) {
  const qc = useQueryClient();
  const { data: edits, isLoading } = useListPendingEdits();
  const invalidate = () => qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
  const actions = useReviewTicketActions(invalidate);
  return (
    <div className={embedded ? "space-y-6" : "max-w-7xl mx-auto p-6 space-y-6"}>
      {!embedded && <EditQueueHeader />}
      {isLoading ? (
        <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>
      ) : !edits || edits.length === 0 ? (
        <div className="font-mono text-sm text-muted-foreground italic border border-border p-6 bg-card/30">
          No pending edits.
        </div>
      ) : (
        <div className="space-y-2" data-testid="pending-edits-list">
          {edits.map((e) => (
            <EditRow key={e.id} e={e} unseen={false} showLifecycle={false} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}

function EditQueueHeader() {
  return (
    <div className="border-b border-border pb-4">
      <h1 className="font-display text-3xl tracking-widest text-nc-cyan flex items-center gap-2">
        <ShieldAlert className="w-7 h-7" /> CHARACTER EDIT QUEUE
      </h1>
      <p className="font-mono text-xs text-muted-foreground mt-2 leading-relaxed">
        Edits to characters require a majority of fixers / approvers / admins to sign off before they apply.
        Submitters cannot vote on their own edits.
        <br />
        <span className="text-muted-foreground/80">
          Reviewers see every pending edit. Players see only their own submissions and can withdraw them from the detail view.
        </span>
      </p>
    </div>
  );
}
