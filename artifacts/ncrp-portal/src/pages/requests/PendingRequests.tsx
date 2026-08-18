import { useEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearch, useLocation } from "wouter";
import {
  useListCustomRequests,
  useVoteCustomRequest,
  useOverrideCustomRequest,
  useUpdateCustomRequest,
  useListPendingSheets,
  useVoteSheet,
  useOverrideSheet,
  useListPendingEdits,
  useListLoreEdits,
  useVoteLoreEdit,
  useOverrideLoreEdit,
  useListGuidebookEdits,
  useApproveGuidebookEdit,
  useRejectGuidebookEdit,
  useCloseReviewTicket,
  useReopenReviewTicket,
  useListDistricts,
  useListCyberware,
  getListCyberwareQueryKey,
  useGetReviewUnseenCounts,
  useGetReviewUnseenIds,
  useGetReviewUnreadDetail,
  getGetReviewUnseenIdsQueryKey,
  getGetReviewUnseenCountsQueryKey,
  getGetReviewUnreadDetailQueryKey,
  getListCustomRequestsQueryKey,
  getListPendingSheetsQueryKey,
  getListPendingEditsQueryKey,
  getListLoreEditsQueryKey,
  getListGuidebookEditsQueryKey,
  useListOwnedMissions,
  useApproveMission,
  getListOwnedMissionsQueryKey,
  getListMissionsQueryKey,
  type CustomRequest,
  type LorePendingEdit,
  type LoreEntryUpdate,
  type GuidebookPendingEdit,
  type GuidebookPageUpdate,
  type PendingEditSummary,
  type PendingSheetSummary,
  type MissionSummary,
} from "@workspace/api-client-react";
import { formatEddies, formatDate } from "@/lib/format";
import SelectOrCustom from "@/components/SelectOrCustom";
import MultiImageUpload from "@/components/MultiImageUpload";
import {
  GUN_CATEGORIES,
  GUN_WEAPON_TYPES,
  GUN_POWER_LEVELS,
  FIRE_MODES,
  GUN_WEAPON_TYPE_ALIASES,
  GUN_POWER_LEVEL_ALIASES,
} from "@/components/catalog/gunTypes";
import { CYBERWARE_SLOTS } from "@/lib/cyberwareOptions";
import { ReviewSortDropdown, sortReviewItems, decidedFirst, type ReviewSortMode } from "./reviewSort";
import { useReviewTicketActions, LifecycleActions } from "@/components/review/ReviewLifecycleUI";
import { ReviewQueueCard } from "@/components/review/ReviewQueueCard";
import { OverrideButton } from "@/components/review/OverrideButton";
import DiscordThreadDrawer from "@/components/DiscordThreadDrawer";
import DiffValue from "@/components/DiffValue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Clock, FileText, Inbox, Home, Crosshair, Cpu, Store, Syringe, BookOpen, BookMarked, PackagePlus, Package, Pencil, Tag } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useMarkReviewSeenInstant } from "@/hooks/useReviewSeen";
import PendingEditsList from "@/pages/pending-edits/PendingEditsList";
import ErrorBoundary from "@/components/ErrorBoundary";

const TYPE_META: Record<
  CustomRequest["type"],
  { label: string; Icon: typeof Home }
> = {
  property: { label: "OFF-MAP HOUSING", Icon: Home },
  gun: { label: "GUN", Icon: Crosshair },
  cyberware: { label: "CYBERWARE", Icon: Cpu },
  // Freeform off-catalog item (anything that is not a gun or cyberware).
  item: { label: "ITEM", Icon: Package },
  store: { label: "STORE", Icon: Store },
  ripperdoc: { label: "RIPPERDOC", Icon: Syringe },
  // Owner-requested custom venue stock — fixer-voted to set its cost, then
  // owner-decided to pay; stays in the staff queue for the vote.
  venue_stock: { label: "VENUE STOCK", Icon: PackagePlus },
  // Stock-cost requests are owner-decided (excluded from the staff queue);
  // included here only to keep the type map exhaustive. Employee invites are
  // decided by the invited player (also excluded), kept for exhaustiveness.
  stock_cost: { label: "STOCK COST", Icon: Store },
  employee_invite: { label: "EMPLOYEE INVITE", Icon: Store },
  // Mission participation is decided by the assigned character's player
  // (excluded from the staff queue); kept here only for exhaustiveness.
  mission_participation: { label: "MISSION PARTICIPATION", Icon: FileText },
  // Player asked for an approval-gated character tag (created internally by
  // PATCH /characters/:id/tags — no direct submit form).
  character_tag: { label: "CHARACTER TAG", Icon: Tag },
};

// Venue requests stash purpose/location in the details payload — surface them
// in the review card so staff can act without opening anything else.
function venueDetails(r: CustomRequest): { purpose?: string; location?: string } | null {
  if (r.type !== "store" && r.type !== "ripperdoc") return null;
  const d = r.details;
  if (!d || typeof d !== "object") return null;
  return d as { purpose?: string; location?: string };
}

function MiscRequestsTab({ focusId }: { focusId?: number | null }) {
  // The queue now holds both undecided (pending / changes_requested) AND decided
  // -but-not-closed (approved / rejected) tickets. Decided tickets render as
  // green / red "action" cards with CLOSE & APPLY / CLOSE & DENY so the closer
  // enters mechanical params at close. We fetch the active bucket (pending +
  // changes_requested) and the resolved bucket (approved + rejected + cancelled)
  // and merge them; closed tickets live in the cross-cutting Completed/Denied
  // tabs, cancelled ones are dropped from the queue.
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: active, isLoading } = useListCustomRequests({ bucket: "active" });
  const { data: resolved, isLoading: resolvedLoading } = useListCustomRequests(
    { bucket: "resolved" },
    { query: { queryKey: getListCustomRequestsQueryKey({ bucket: "resolved" }) } },
  );
  const { data: unseenIds } = useGetReviewUnseenIds();
  const { data: unreadDetail } = useGetReviewUnreadDetail();
  const markSeen = useMarkReviewSeenInstant();
  const { data: me } = useEffectiveMe();
  const [closeTarget, setCloseTarget] = useState<{ request: CustomRequest; mode: "apply" | "deny" } | null>(null);
  const [sortMode, setSortMode] = useState<ReviewSortMode>("updated");
  // Admin in-place edit of a request's content. Keeps existing votes (the
  // backend skips vote-clearing for a non-owner admin edit).
  const [editing, setEditing] = useState<
    { id: number; title: string; description: string; isVenue: boolean; purpose: string; location: string; imageUrls: string[] } | null
  >(null);

  const isReviewer = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  // Approver pool: only Cs Approvers cast counted votes. Fixers and admins are
  // staff (see the queue + roster + override) but are NOT approvers — admins use
  // OVERRIDE, not the vote buttons.
  const canVote = !!me?.isCsApprover;
  const isAdmin = !!me?.isAdmin;
  const isArchivist = !!me?.isArchivist;
  const isFixer = !!me?.isFixer;

  // Submitted mission proposals are approved from this queue. /missions/owned
  // 403s for a pure cs_approver, so only fetch for fixer/admin/archivist.
  const canSeeOwnedMissions = isFixer || isAdmin || isArchivist;
  const ownedMissions = useListOwnedMissions({
    query: { enabled: canSeeOwnedMissions, queryKey: getListOwnedMissionsQueryKey() },
  });
  const missionProposals = ((ownedMissions.data ?? []) as MissionSummary[]).filter(
    (m) => m.workflowState === "proposal",
  );
  const canApproveMissions = isArchivist || isAdmin;

  const unseen = new Set(unseenIds?.request ?? []);

  // Decided-but-not-closed tickets (approved / rejected) live in the resolved
  // bucket alongside cancelled — keep only the two that still need a closer to
  // CLOSE & APPLY / CLOSE & DENY.
  const decided = ((resolved ?? []) as CustomRequest[]).filter(
    (r) => r.status === "approved" || r.status === "rejected",
  );
  const queueItems = sortReviewItems(
    [...((active ?? []) as CustomRequest[]), ...decided],
    sortMode,
    (r) => r.createdAt,
    (r) => r.lastActivityAt,
  );

  const invalidateQueue = () => {
    // Base key (no params) so every bucket variant — active / resolved / archive
    // — refetches; a status-scoped key would not prefix-match the { bucket }
    // fetches and would leave votes/decisions stale until a manual refresh.
    qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnreadDetailQueryKey() });
  };
  const onMutationError = (title: string) => (err: unknown) => {
    toast({ title, description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
  };

  const voteMut = useVoteCustomRequest({
    mutation: {
      onSuccess: (res, vars) => {
        // Voting is an interaction, so it clears the ticket's "new/pending"
        // unread state the same way opening it does.
        markSeen("request", (vars as { id: number }).id);
        invalidateQueue();
        const decidedAs = (res as { decided?: string })?.decided;
        toast({
          title:
            decidedAs === "approved"
              ? "Approved — majority reached"
              : decidedAs === "rejected"
                ? "Rejected — majority reached"
                : "Vote recorded",
        });
      },
      onError: onMutationError("Could not vote"),
    },
  });
  const overrideMut = useOverrideCustomRequest({
    mutation: {
      onSuccess: (_res, vars) => {
        markSeen("request", (vars as { id: number }).id);
        invalidateQueue();
        toast({
          title:
            (vars as { data?: { decision?: string } })?.data?.decision === "deny"
              ? "Denied via override"
              : "Approved via override",
        });
      },
      onError: onMutationError("Could not override"),
    },
  });
  const reopenMut = useReopenReviewTicket({
    mutation: {
      onSuccess: () => {
        invalidateQueue();
        toast({ title: "Reopened — back to pending" });
      },
      onError: onMutationError("Could not reopen"),
    },
  });
  const updateMut = useUpdateCustomRequest({
    mutation: {
      onSuccess: () => {
        invalidateQueue();
        toast({ title: "Request updated", description: "Existing votes were kept." });
        setEditing(null);
      },
      onError: onMutationError("Could not save"),
    },
  });
  const saveEdit = () => {
    if (!editing) return;
    const data: Record<string, unknown> = { title: editing.title, description: editing.description, imageUrls: editing.imageUrls };
    if (editing.isVenue) {
      data.purpose = editing.purpose;
      data.location = editing.location;
    }
    updateMut.mutate({ id: editing.id, data });
  };

  // A ?focus=<id> deep link (from the Discord CS-approver post) scrolls the
  // matching card into view once the queue has rendered.
  useEffect(() => {
    if (focusId == null) return;
    const el = document.getElementById(`review-request-${focusId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, queueItems.length]);

  const renderCard = (r: CustomRequest) => {
    const meta = TYPE_META[r.type] ?? { label: "REQUEST", Icon: Inbox };
    const det = venueDetails(r);
    // pending / changes_requested are still "in vote"; approved / rejected are
    // decided and awaiting a closer (green / red action cards).
    const isVoting = r.status === "pending" || r.status === "changes_requested";
    const isApproved = r.status === "approved";
    const isRejected = r.status === "rejected";
    // A still-staged decision (approved / rejected, not yet closed/applied) is
    // re-openable to voting: reviewers can add / remove / flip votes and admins
    // can override-flip directly on the decided card. changes_requested is NOT
    // voteable (mirrors the backend guard).
    const canStillVote = r.status === "pending" || isApproved || isRejected;
    const tone: "default" | "approved" | "rejected" = isApproved
      ? "approved"
      : isRejected
        ? "rejected"
        : "default";
    return (
      <ReviewQueueCard
        key={r.id}
        subjectType="request"
        id={r.id}
        testId={`card-misc-request-${r.id}`}
        unseen={unseen.has(r.id)}
        badgeLabel={meta.label}
        badgeIcon={meta.Icon}
        title={r.title}
        subtitle={`${r.characterName} · by ${r.requestedByName || r.requestedById}`}
        date={r.createdAt}
        tone={tone}
        showRoster={isReviewer && (isVoting || isApproved || isRejected)}
        roster={{
          eligibleReviewers: r.eligibleReviewers ?? [],
          voters: (r.voters ?? []).map((v) => ({ id: v.id, vote: v.vote })),
        }}
        markSeenOnMount={isReviewer}
        initiallyExpanded={r.id === focusId}
        discussionUnread={unreadDetail?.request?.[r.id] ?? 0}
        awaitingVote={canVote && r.status === "pending" && !r.myVote}
        tally={
          isVoting || isApproved || isRejected ? (
            <div className="space-y-1">
              <div className="font-mono text-xs text-muted-foreground" data-testid={`tally-misc-${r.id}`}>
                <span className="text-nc-green">{r.approveCount ?? 0}</span>/{r.threshold ?? "?"} approve ·{" "}
                <span className="text-destructive">{r.rejectCount ?? 0}</span> reject
                {(r.pauseCount ?? 0) > 0 ? (
                  <>
                    {" "}· <span className="text-nc-yellow">{r.pauseCount}</span> paused
                  </>
                ) : null}
                {r.myVote ? (
                  <span className="ml-2">
                    · you voted{" "}
                    <span
                      className={
                        r.myVote === "approve" ? "text-nc-green" : r.myVote === "pause" ? "text-nc-yellow" : "text-destructive"
                      }
                    >
                      {r.myVote.toUpperCase()}
                    </span>
                  </span>
                ) : null}
              </div>
              {isApproved || isRejected ? (
                <div className="font-mono text-xs" data-testid={`status-misc-${r.id}`}>
                  <span className={isApproved ? "text-nc-green font-display tracking-widest" : "text-destructive font-display tracking-widest"}>
                    {isApproved ? "APPROVED — AWAITING CLOSE & APPLY" : "REJECTED — AWAITING CLOSE & DENY"}
                  </span>
                  {r.reviewerNote ? <span className="block italic mt-0.5 text-muted-foreground">"{r.reviewerNote}"</span> : null}
                </div>
              ) : null}
            </div>
          ) : null
        }
        actions={
          isReviewer ? (
            <div className="flex flex-wrap gap-2">
              {canStillVote && (
                <>
                  {canVote && (
                    <>
                      <Button
                        className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                        disabled={voteMut.isPending}
                        onClick={() => voteMut.mutate({ id: r.id, data: { vote: "approve" } })}
                        data-testid={`button-approve-misc-${r.id}`}
                      >
                        {r.myVote === "approve" ? "VOTED APPROVE" : "VOTE APPROVE"}
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                        disabled={voteMut.isPending}
                        onClick={() => voteMut.mutate({ id: r.id, data: { vote: "reject" } })}
                        data-testid={`button-reject-misc-${r.id}`}
                      >
                        {r.myVote === "reject" ? "VOTED REJECT" : "VOTE REJECT"}
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                        disabled={voteMut.isPending}
                        onClick={() => voteMut.mutate({ id: r.id, data: { vote: "pause" } })}
                        data-testid={`button-pause-misc-${r.id}`}
                        title="Pause marker — doesn't count toward the decision"
                      >
                        {r.myVote === "pause" ? "VOTED PAUSE" : "VOTE PAUSE"}
                      </Button>
                    </>
                  )}
                  {isAdmin && (
                    <OverrideButton
                      disabled={overrideMut.isPending}
                      onDecide={(decision) => overrideMut.mutate({ id: r.id, data: { decision } })}
                      testIdSuffix={`misc-${r.id}`}
                      subjectLabel="this request"
                    />
                  )}
                </>
              )}
              {isApproved && (
                <>
                  <Button
                    className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                    onClick={() => setCloseTarget({ request: r, mode: "apply" })}
                    data-testid={`button-close-apply-misc-${r.id}`}
                  >
                    CLOSE & APPLY
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                    disabled={reopenMut.isPending}
                    onClick={() => reopenMut.mutate({ subjectType: "request", id: r.id })}
                    data-testid={`button-reopen-misc-${r.id}`}
                  >
                    REOPEN
                  </Button>
                </>
              )}
              {isRejected && (
                <>
                  <Button
                    variant="outline"
                    className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                    onClick={() => setCloseTarget({ request: r, mode: "deny" })}
                    data-testid={`button-close-deny-misc-${r.id}`}
                  >
                    CLOSE & DENY
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                    disabled={reopenMut.isPending}
                    onClick={() => reopenMut.mutate({ subjectType: "request", id: r.id })}
                    data-testid={`button-reopen-misc-${r.id}`}
                  >
                    REOPEN
                  </Button>
                </>
              )}
              {isAdmin && isVoting && r.requestedById !== me?.id && (
                <Button
                  variant="outline"
                  className="rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
                  onClick={() =>
                    setEditing({
                      id: r.id,
                      title: r.title,
                      description: r.description ?? "",
                      isVenue: r.type === "store" || r.type === "ripperdoc",
                      purpose: det?.purpose ?? "",
                      location: det?.location ?? "",
                      imageUrls: r.imageUrls ?? (r.imageUrl ? [r.imageUrl] : []),
                    })
                  }
                  data-testid={`button-edit-misc-${r.id}`}
                >
                  <Pencil className="w-3.5 h-3.5 mr-1" /> EDIT
                </Button>
              )}
              <DiscordThreadDrawer
                subjectType="request"
                subjectId={r.id}
                buttonLabel="FIXER COMMUNICATION"
                watchUnread
                buttonClassName="rounded-none border-nc-magenta/60 text-nc-magenta hover:bg-nc-magenta/10 font-display text-xs tracking-widest h-9 shrink-0"
              />
            </div>
          ) : null
        }
      >
        {(r.imageUrls?.length ? r.imageUrls : r.imageUrl ? [r.imageUrl] : []).map((url, i) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block border border-border bg-background"
            data-testid={`link-misc-image-${r.id}-${i}`}
          >
            <img
              src={url}
              alt={`${r.title} (${i + 1})`}
              className="w-full h-40 object-contain"
              loading="lazy"
              data-testid={`img-misc-request-${r.id}-${i}`}
            />
          </a>
        ))}
        {det ? (
          <div className="space-y-1 font-mono text-xs" data-testid={`venue-details-${r.id}`}>
            {det.purpose ? (
              <div>
                <span className="text-nc-cyan uppercase tracking-widest">Purpose: </span>
                <span className="text-muted-foreground">{det.purpose}</span>
              </div>
            ) : null}
            {det.location ? (
              <div>
                <span className="text-nc-cyan uppercase tracking-widest">Location: </span>
                <span className="text-muted-foreground">{det.location}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        {r.description ? (
          <p className="font-mono text-sm text-muted-foreground whitespace-pre-wrap">{r.description}</p>
        ) : (
          <p className="font-mono text-sm text-muted-foreground italic">No description provided.</p>
        )}
      </ReviewQueueCard>
    );
  };

  if (isLoading || resolvedLoading || (canSeeOwnedMissions && ownedMissions.isLoading)) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }

  if (queueItems.length === 0 && missionProposals.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <Inbox className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No miscellaneous requests require attention.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {missionProposals.length > 0 && (
        <MissionApprovalSection rows={missionProposals} canApprove={canApproveMissions} />
      )}

      {queueItems.length > 0 && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <ReviewSortDropdown value={sortMode} onChange={setSortMode} testId="select-sort-misc" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {queueItems.map((r) => renderCard(r))}
          </div>
        </div>
      )}

      <RequestCloseDialog
        target={closeTarget}
        onClose={() => setCloseTarget(null)}
        onDone={invalidateQueue}
      />

      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="rounded-none border-nc-cyan bg-card">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">EDIT REQUEST</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Editing as an admin keeps the existing votes — this does not send the request back for re-review.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Title</label>
                <Input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className="rounded-none mt-1"
                  data-testid="input-admin-edit-title"
                />
              </div>
              <div>
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Description</label>
                <Textarea
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={4}
                  className="rounded-none mt-1"
                  data-testid="input-admin-edit-description"
                />
              </div>
              <div>
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Reference Images (optional)</label>
                <div className="mt-1">
                  <MultiImageUpload
                    value={editing.imageUrls}
                    onChange={(urls) => setEditing({ ...editing, imageUrls: urls })}
                    testIdPrefix="admin-edit-request-image"
                    alt="request reference"
                  />
                </div>
              </div>
              {editing.isVenue && (
                <>
                  <div>
                    <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Purpose</label>
                    <Input
                      value={editing.purpose}
                      onChange={(e) => setEditing({ ...editing, purpose: e.target.value })}
                      className="rounded-none mt-1"
                      data-testid="input-admin-edit-purpose"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Location</label>
                    <Input
                      value={editing.location}
                      onChange={(e) => setEditing({ ...editing, location: e.target.value })}
                      className="rounded-none mt-1"
                      data-testid="input-admin-edit-location"
                    />
                  </div>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-none font-display"
              onClick={() => setEditing(null)}
              data-testid="button-admin-edit-cancel"
            >
              CANCEL
            </Button>
            <Button
              type="button"
              disabled={updateMut.isPending || !editing?.title.trim()}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              onClick={saveEdit}
              data-testid="button-admin-edit-save"
            >
              SAVE CHANGES
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// CLOSE & APPLY / CLOSE & DENY for a decided custom request. Mechanical params
// (rent / cwp / venue cost+retail+qty) are entered HERE by the closer — fixers
// agree on the numbers in discussion first — and applied at close. In "deny"
// mode only the optional note is shown (DM'd to the player at close).
function RequestCloseDialog({
  target,
  onClose,
  onDone,
}: {
  target: { request: CustomRequest; mode: "apply" | "deny" } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [district, setDistrict] = useState("");
  const [tier, setTier] = useState("");
  const [cwp, setCwp] = useState("");
  const [slot, setSlot] = useState("");
  const [gunCategory, setGunCategory] = useState("");
  const [weaponType, setWeaponType] = useState("");
  const [fireMode, setFireMode] = useState("");
  const [powerLevel, setPowerLevel] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [retail, setRetail] = useState("");
  const [qty, setQty] = useState("1");
  // Tracks which opened request has already had its catalog prefill applied so
  // we never clobber the closer's typing after the initial fill.
  const [prefilledFor, setPrefilledFor] = useState("");

  // Districts mirror the properties page; offered as presets with a custom escape.
  const { data: districts } = useListDistricts();
  const districtNames = (districts ?? []).map((d) => d.name);

  // Re-seed local form state whenever a different request is opened.
  const seedKey = target ? `${target.request.id}:${target.mode}` : "";
  const [seededFor, setSeededFor] = useState("");
  if (target && seededFor !== seedKey) {
    setNote("");
    setMonthlyRent("");
    setBusinessName("");
    setDistrict("");
    setTier("");
    setCwp("");
    setSlot("");
    setGunCategory("");
    setWeaponType("");
    setFireMode("");
    setPowerLevel("");
    setManufacturer("");
    setUnitCost("");
    setRetail("");
    setQty("1");
    setPrefilledFor("");
    setSeededFor(seedKey);
  }

  const close = useCloseReviewTicket({
    mutation: {
      onSuccess: () => {
        onDone();
        toast({ title: target?.mode === "deny" ? "Closed & denied" : "Closed & applied" });
        onClose();
      },
      onError: (err) => {
        toast({ title: "Could not close", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
      },
    },
  });

  // Prefill CWP + slot from the cyberware catalog when the requested item's
  // name matches a catalog entry (e.g. "GhostTag"), so the closer doesn't have
  // to retype known values. Highest-CWP wins on duplicate names, mirroring the
  // server's loadCyberwareCatalogMap. Values stay editable.
  const catalogEnabled =
    !!target && target.mode === "apply" && target.request.type === "cyberware";
  const { data: cyberCatalog } = useListCyberware({
    query: { enabled: catalogEnabled, queryKey: getListCyberwareQueryKey() },
  });
  const cyberMatch = useMemo(() => {
    if (!catalogEnabled) return null;
    const name = String(target!.request.title ?? "").trim().toLowerCase();
    if (!name) return null;
    let best: { cwp: number; slot: string } | null = null;
    for (const c of cyberCatalog ?? []) {
      if (String(c.name ?? "").trim().toLowerCase() !== name) continue;
      const cwpVal = Number((c as { cwp?: number }).cwp ?? 0) || 0;
      const slotVal = String((c as { slot?: string | null }).slot ?? "").trim();
      if (!best || cwpVal > best.cwp) best = { cwp: cwpVal, slot: slotVal };
    }
    return best;
  }, [catalogEnabled, cyberCatalog, target]);
  useEffect(() => {
    if (!cyberMatch || !seedKey || prefilledFor === seedKey) return;
    // Only prefill untouched fields so we never clobber the closer's typing.
    if (cwp === "" && slot === "") {
      setCwp(String(cyberMatch.cwp));
      if (cyberMatch.slot) setSlot(cyberMatch.slot);
    }
    setPrefilledFor(seedKey);
  }, [cyberMatch, seedKey, prefilledFor, cwp, slot]);

  if (!target) return null;
  const { request, mode } = target;
  const isApply = mode === "apply";
  const isProperty = request.type === "property";
  const isCyberware = request.type === "cyberware";
  const isVenueStock = request.type === "venue_stock";
  const isGun = request.type === "gun";
  // Off-Map Business venues only collect lease params when the player opted to
  // attach an off-map property. On-map venues lease the reserved building and
  // need no rent/district/tier here.
  const venueDet =
    request.type === "store" || request.type === "ripperdoc"
      ? (request.details as { attachProperty?: boolean; locationKind?: string } | null)
      : null;
  const isVenueProperty =
    !!venueDet && venueDet.attachProperty === true && venueDet.locationKind !== "on_map";
  // Both off-map housing and an attached-business lease collect the same lease
  // numbers (rent / district / tier).
  const needsLeaseParams = isProperty || isVenueProperty;

  const rentNum = parseInt(monthlyRent, 10);
  const cwpNum = parseInt(cwp, 10);
  const unitCostNum = parseInt(unitCost, 10);
  const retailNum = parseInt(retail, 10);
  const qtyNum = parseInt(qty, 10);
  // Tier presets mirror the properties page; custom is allowed. Residential
  // off-map housing starts at T1; business leases can be Tier-0.
  const tierOptions = isVenueProperty ? ["T0", "T1", "T2", "T3"] : ["T1", "T2", "T3"];
  const paramsValid =
    !isApply ||
    ((!needsLeaseParams ||
      (Number.isFinite(rentNum) && rentNum >= 0 && district.trim() !== "" && tier.trim() !== "")) &&
      (!isCyberware || (Number.isFinite(cwpNum) && cwpNum >= 0 && slot.trim() !== "")) &&
      (!isGun ||
        (gunCategory.trim() !== "" &&
          weaponType.trim() !== "" &&
          fireMode.trim() !== "" &&
          powerLevel.trim() !== "")) &&
      (!isVenueStock ||
        (Number.isFinite(unitCostNum) &&
          unitCostNum >= 0 &&
          Number.isFinite(retailNum) &&
          retailNum >= 0 &&
          Number.isFinite(qtyNum) &&
          qtyNum >= 1)));

  const submit = () => {
    const params = isApply
      ? {
          ...(needsLeaseParams
            ? {
                monthlyRent: rentNum,
                district: district.trim(),
                tier: tier.trim(),
                ...(businessName.trim() ? { businessName: businessName.trim() } : {}),
              }
            : {}),
          ...(isCyberware ? { cwp: cwpNum, slot: slot.trim() } : {}),
          ...(isGun
            ? {
                category: gunCategory.trim(),
                weaponType: weaponType.trim(),
                fireMode: fireMode.trim(),
                powerLevel: powerLevel.trim(),
                ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
              }
            : {}),
          ...(isVenueStock ? { unitCost: unitCostNum, retail: retailNum, qty: qtyNum } : {}),
        }
      : {};
    close.mutate({
      subjectType: "request",
      id: request.id,
      data: { ...(note.trim() ? { note: note.trim() } : {}), ...params },
    });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={`rounded-none bg-card sm:max-w-lg ${isApply ? "border-nc-green/40" : "border-destructive/40"}`}>
        <DialogHeader>
          <DialogTitle className={`font-display tracking-widest break-words ${isApply ? "text-nc-green" : "text-destructive"}`}>
            {isApply ? "CLOSE & APPLY" : "CLOSE & DENY"} — {request.title.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {isApply
              ? `Enter the agreed mechanical numbers — they are applied to ${request.characterName} and the ticket is archived as completed.`
              : `Denies and archives this request. Your note (if any) is DM'd to ${request.characterName}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {isApply && needsLeaseParams && (
            <>
              {isVenueProperty && (
                <p className="font-mono text-[11px] text-nc-cyan/80 border border-nc-cyan/30 bg-nc-cyan/5 px-3 py-2">
                  This Off-Map Business asked to attach a property — set the off-map business lease's
                  rent, district, and tier below.
                </p>
              )}
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Monthly Rent (€$)</Label>
                <Input
                  type="number"
                  min={0}
                  value={monthlyRent}
                  onChange={(e) => setMonthlyRent(e.target.value)}
                  placeholder="e.g. 2500"
                  className="rounded-none font-mono"
                  data-testid="input-close-rent"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Property Name</Label>
                <Input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Leave blank to keep the requested name"
                  className="rounded-none font-mono"
                  data-testid="input-close-business-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">District</Label>
                <SelectOrCustom
                  value={district}
                  onChange={setDistrict}
                  options={districtNames}
                  allowEmpty={false}
                  placeholder="Select a district…"
                  customPlaceholder="Off-map / custom district"
                  testId="select-close-district"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Tier</Label>
                <SelectOrCustom
                  value={tier}
                  onChange={setTier}
                  options={tierOptions}
                  allowEmpty={false}
                  placeholder="Select a tier…"
                  customPlaceholder="Custom tier"
                  testId="select-close-tier"
                />
              </div>
            </>
          )}
          {isApply && isCyberware && (
            <>
              {cyberMatch ? (
                <p
                  className="font-mono text-[11px] text-nc-green border border-nc-green/40 bg-nc-green/5 px-3 py-2"
                  data-testid="close-cyber-catalog-hint"
                >
                  "{request.title}" matched the cyberware catalog — CWP and slot were auto-filled. Adjust if needed.
                </p>
              ) : null}
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">CWP (chrome point cost)</Label>
                <Input
                  type="number"
                  min={0}
                  value={cwp}
                  onChange={(e) => setCwp(e.target.value)}
                  placeholder="e.g. 2"
                  className="rounded-none font-mono"
                  data-testid="input-close-cwp"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Slot (body system)</Label>
                <SelectOrCustom
                  value={slot}
                  onChange={setSlot}
                  options={CYBERWARE_SLOTS}
                  allowEmpty={false}
                  placeholder="Select a slot…"
                  customPlaceholder="Custom slot"
                  testId="select-close-slot"
                />
              </div>
            </>
          )}
          {isApply && isGun && (
            <>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Category</Label>
                <SelectOrCustom
                  value={gunCategory}
                  onChange={setGunCategory}
                  options={GUN_CATEGORIES}
                  allowEmpty={false}
                  placeholder="Power / Tech / Smart…"
                  customPlaceholder="Custom category"
                  testId="select-close-gun-category"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Weapon Type</Label>
                <SelectOrCustom
                  value={weaponType}
                  onChange={setWeaponType}
                  options={GUN_WEAPON_TYPES}
                  aliases={GUN_WEAPON_TYPE_ALIASES}
                  allowEmpty={false}
                  placeholder="Pistol / SMG / …"
                  customPlaceholder="Custom weapon type"
                  testId="select-close-gun-type"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Fire Mode</Label>
                <SelectOrCustom
                  value={fireMode}
                  onChange={setFireMode}
                  options={FIRE_MODES}
                  allowEmpty={false}
                  placeholder="Semi-Auto / Burst / Full-Auto…"
                  customPlaceholder="Custom fire mode"
                  testId="select-close-gun-fire"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Power Level (L/M/H)</Label>
                <SelectOrCustom
                  value={powerLevel}
                  onChange={setPowerLevel}
                  options={GUN_POWER_LEVELS}
                  aliases={GUN_POWER_LEVEL_ALIASES}
                  allowEmpty={false}
                  placeholder="L / M / H…"
                  customPlaceholder="Custom power level"
                  testId="select-close-gun-power"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Manufacturer (optional)</Label>
                <Input
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  placeholder="e.g. Militech"
                  className="rounded-none font-mono"
                  data-testid="input-close-gun-manufacturer"
                />
              </div>
            </>
          )}
          {isApply && isVenueStock && (
            <>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Unit Cost (€$, owner pays)</Label>
                <Input
                  type="number"
                  min={0}
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                  placeholder="e.g. 5000"
                  className="rounded-none font-mono"
                  data-testid="input-close-unit-cost"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Retail Price (€$, customer pays)</Label>
                <Input
                  type="number"
                  min={0}
                  value={retail}
                  onChange={(e) => setRetail(e.target.value)}
                  placeholder="e.g. 8000"
                  className="rounded-none font-mono"
                  data-testid="input-close-retail"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Quantity</Label>
                <Input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="e.g. 1"
                  className="rounded-none font-mono"
                  data-testid="input-close-qty"
                />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
              {isApply ? "Closing Note (optional)" : "Denial Note (optional)"}
            </Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={isApply ? "Visible to the player" : "Reason — DM'd to the player"}
              className="rounded-none font-mono"
              data-testid="input-close-note"
            />
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:space-x-0">
          <Button variant="ghost" className="w-full rounded-none font-display sm:w-auto" onClick={onClose}>
            CANCEL
          </Button>
          <Button
            className={`w-full rounded-none font-display tracking-widest sm:w-auto ${
              isApply
                ? "bg-nc-green text-background hover:bg-nc-green/80"
                : "border border-destructive bg-transparent text-destructive hover:bg-destructive/10"
            }`}
            disabled={!paramsValid || close.isPending}
            onClick={submit}
            data-testid="button-confirm-close"
          >
            {close.isPending ? "WORKING..." : isApply ? "CLOSE & APPLY" : "CLOSE & DENY"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MissionApprovalSection({
  rows,
  canApprove,
}: {
  rows: MissionSummary[];
  canApprove: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const approve = useApproveMission({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListOwnedMissionsQueryKey() });
        qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
        toast({ title: "Mission approved", description: "It's now live and open on the Missions board." });
      },
      onError: (e) =>
        toast({
          title: "Approval failed",
          description: apiErrorMessage(e, "Please try again."),
          variant: "destructive",
        }),
    },
  });

  return (
    <div className="space-y-3" data-testid="section-mission-approvals">
      <div className="flex items-center gap-2">
        <Crosshair className="w-4 h-4 text-nc-magenta" />
        <h3 className="font-display tracking-widest text-nc-magenta text-sm">
          MISSIONS AWAITING APPROVAL
          <span className="ml-1.5 opacity-70">({rows.length})</span>
        </h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {rows.map((m) => {
          const when = m.startAt ? new Date(m.startAt) : null;
          return (
            <Card
              key={m.id}
              className="rounded-none border-border bg-card/50 flex flex-col"
              data-testid={`card-mission-proposal-${m.id}`}
            >
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className="rounded-none border-nc-magenta text-nc-magenta font-mono text-[10px]">
                    <Crosshair className="w-3 h-3 mr-1" /> MISSION
                  </Badge>
                  <span className="text-xs font-mono text-muted-foreground">
                    {when ? formatDate(when) : "No date"}
                  </span>
                </div>
                <CardTitle className="text-lg font-display truncate mt-2">{m.title}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {m.fixerName ? `by ${m.fixerName}` : "Unassigned fixer"}
                  {typeof m.tier === "number" ? ` · Tier ${m.tier}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col flex-1 gap-4">
                <div className="space-y-1 font-mono text-xs text-muted-foreground">
                  {m.location ? (
                    <div>
                      <span className="text-nc-cyan uppercase tracking-widest">Location: </span>
                      {m.location}
                    </div>
                  ) : null}
                  {typeof m.playerPay === "number" ? (
                    <div>
                      <span className="text-nc-cyan uppercase tracking-widest">Player pay: </span>
                      {formatEddies(m.playerPay)}
                    </div>
                  ) : null}
                </div>
                <div className="mt-auto pt-3 border-t border-border/40 flex flex-wrap gap-2">
                  {canApprove && (
                    <Button
                      className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate({ id: m.id })}
                      data-testid={`button-approve-mission-${m.id}`}
                    >
                      {approve.isPending ? "APPROVING..." : "APPROVE"}
                    </Button>
                  )}
                  <Link href={`/missions/${m.id}`}>
                    <Button
                      variant="outline"
                      className="rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
                      data-testid={`button-view-mission-${m.id}`}
                    >
                      VIEW DETAILS
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function NewCharactersTab() {
  // The queue holds both undecided (pending / changes_requested) AND decided-
  // but-not-closed (approved / rejected) sheets. Decided sheets render as green /
  // red glow cards with CLOSE & APPLY / CLOSE TICKET + REOPEN so the closer
  // materializes the character (and enters custom cyberware/gun attrs) in place.
  // We fetch the active bucket and the resolved bucket and merge them; closed
  // sheets live in the cross-cutting Completed/Denied tabs, cancelled ones are
  // dropped from the queue.
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: active, isLoading } = useListPendingSheets({ bucket: "active" });
  const { data: resolved, isLoading: resolvedLoading } = useListPendingSheets(
    { bucket: "resolved" },
    { query: { queryKey: getListPendingSheetsQueryKey({ bucket: "resolved" }) } },
  );
  const { data: unseenIds } = useGetReviewUnseenIds();
  const { data: unreadDetail } = useGetReviewUnreadDetail();
  const markSeen = useMarkReviewSeenInstant();
  const { data: me } = useEffectiveMe();
  const unseen = new Set(unseenIds?.sheet ?? []);
  const isReviewer = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  // Only Cs Approvers cast counted votes; fixers/admins are staff (admins use OVERRIDE).
  const canVote = !!me?.isCsApprover;
  const isAdmin = !!me?.isAdmin;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnreadDetailQueryKey() });
  };
  const errMsg = (err: unknown, fallback: string) => apiErrorMessage(err, fallback);

  const vote = useVoteSheet({
    mutation: {
      onSuccess: (res, vars) => {
        markSeen("sheet", (vars as { id: number }).id);
        invalidate();
        const decided = (res as { decided?: string })?.decided;
        toast({
          title:
            decided === "approved"
              ? "Sheet approved — majority reached"
              : decided === "rejected"
                ? "Sheet rejected"
                : "Vote recorded",
        });
      },
      onError: (err) =>
        toast({ title: "Vote failed", description: errMsg(err, "Vote failed"), variant: "destructive" }),
    },
  });
  const override = useOverrideSheet({
    mutation: {
      onSuccess: (_res, vars) => {
        markSeen("sheet", (vars as { id: number }).id);
        invalidate();
        toast({ title: "Sheet approved via override" });
      },
      onError: (err) =>
        toast({ title: "Override failed", description: errMsg(err, "Override failed"), variant: "destructive" }),
    },
  });
  const busy = vote.isPending || override.isPending;
  const actions = useReviewTicketActions(invalidate);
  const [sortMode, setSortMode] = useState<ReviewSortMode>("updated");

  // Decided-but-not-closed sheets (approved / rejected) live in the resolved
  // bucket alongside cancelled — keep only the two that still need a closer to
  // CLOSE & APPLY / CLOSE TICKET. Pin them above the undecided queue.
  const decided = ((resolved ?? []) as PendingSheetSummary[]).filter(
    (s) => s.status === "approved" || s.status === "rejected",
  );
  const sheets = decidedFirst(
    sortReviewItems(
      [...((active ?? []) as PendingSheetSummary[]), ...decided],
      sortMode,
      (s) => s.submittedAt,
      (s) => s.lastActivityAt,
    ),
    (s) => String(s.status),
  );

  if (isLoading || resolvedLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }

  if (sheets.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No pending sheets require attention.</p>
      </div>
    );
  }

  const renderCard = (sheet: PendingSheetSummary) => {
    const my = sheet.myVote;
    const isDecided = sheet.status === "approved" || sheet.status === "rejected";
    const tone = sheet.status === "approved" ? "approved" : sheet.status === "rejected" ? "rejected" : "default";
    return (
      <ReviewQueueCard
        key={sheet.id}
        subjectType="sheet"
        id={sheet.id}
        testId={`card-pending-sheet-${sheet.id}`}
        unseen={unseen.has(sheet.id)}
        badgeLabel="NEW CHARACTER"
        badgeIcon={FileText}
        badgeClassName="border-nc-yellow text-nc-yellow"
        title={sheet.name}
        subtitle={`By ${sheet.ownerName || sheet.ownerId}`}
        date={sheet.submittedAt}
        tone={tone}
        showRoster={isReviewer}
        roster={{
          eligibleReviewers: sheet.eligibleReviewers ?? [],
          voters: (sheet.voters ?? []).map((v) => ({ id: v.id, vote: v.vote })),
        }}
        markSeenOnMount={isReviewer}
        discussionUnread={unreadDetail?.sheet?.[sheet.id] ?? 0}
        awaitingVote={canVote && sheet.status === "pending" && !my}
        tally={
          isDecided ? (
            <div
              className={`font-mono text-xs ${sheet.status === "approved" ? "text-nc-green" : "text-destructive"}`}
              data-testid={`status-sheet-${sheet.id}`}
            >
              {sheet.status === "approved"
                ? "APPROVED — awaiting Close & Apply"
                : "REJECTED — awaiting Close"}
            </div>
          ) : (
            <div className="font-mono text-xs text-muted-foreground" data-testid={`tally-sheet-${sheet.id}`}>
              <span className="text-nc-green">{sheet.approveCount ?? 0}</span>/{sheet.threshold ?? "?"} approve ·{" "}
              <span className="text-destructive">{sheet.rejectCount ?? 0}</span> reject
              {(sheet.pauseCount ?? 0) > 0 ? (
                <>
                  {" "}· <span className="text-nc-yellow">{sheet.pauseCount}</span> paused
                </>
              ) : null}
              {my ? (
                <span className="ml-2">
                  · you voted{" "}
                  <span
                    className={
                      my.vote === "approve" ? "text-nc-green" : my.vote === "pause" ? "text-nc-yellow" : "text-destructive"
                    }
                  >
                    {my.vote.toUpperCase()}
                  </span>
                </span>
              ) : null}
            </div>
          )
        }
        actions={
          <div className="space-y-2">
            {isReviewer && isDecided && (
              <LifecycleActions subjectType="sheet" id={sheet.id} status={sheet.status} actions={actions} />
            )}
            {isReviewer && (
              <div className="flex flex-wrap gap-2">
                {sheet.status === "pending" && (
                  <>
                    {canVote && (
                      <>
                        <Button
                          className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                          disabled={busy}
                          onClick={() => vote.mutate({ id: sheet.id, data: { vote: "approve" } })}
                          data-testid={`button-approve-sheet-${sheet.id}`}
                        >
                          {my?.vote === "approve" ? "VOTED APPROVE" : "VOTE APPROVE"}
                        </Button>
                        <Button
                          variant="outline"
                          className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                          disabled={busy}
                          onClick={() => vote.mutate({ id: sheet.id, data: { vote: "reject" } })}
                          data-testid={`button-reject-sheet-${sheet.id}`}
                        >
                          {my?.vote === "reject" ? "VOTED REJECT" : "VOTE REJECT"}
                        </Button>
                        <Button
                          variant="outline"
                          className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                          disabled={busy}
                          onClick={() => vote.mutate({ id: sheet.id, data: { vote: "pause" } })}
                          data-testid={`button-pause-sheet-${sheet.id}`}
                          title="Pause marker — doesn't count toward the decision"
                        >
                          {my?.vote === "pause" ? "VOTED PAUSE" : "VOTE PAUSE"}
                        </Button>
                      </>
                    )}
                    {isAdmin && (
                      <OverrideButton
                        disabled={busy}
                        onDecide={(decision) => override.mutate({ id: sheet.id, data: { decision } })}
                        testIdSuffix={`sheet-${sheet.id}`}
                        subjectLabel="this character sheet"
                      />
                    )}
                  </>
                )}
                <DiscordThreadDrawer
                  subjectType="sheet"
                  subjectId={sheet.id}
                  buttonLabel="FIXER COMMUNICATION"
                  watchUnread
                  buttonClassName="rounded-none border-nc-magenta/60 text-nc-magenta hover:bg-nc-magenta/10 font-display text-xs tracking-widest h-9 shrink-0"
                />
              </div>
            )}
            <Link href={`/sheets/${sheet.id}`}>
              <Button
                variant="outline"
                className="w-full rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
                data-testid={`button-open-sheet-${sheet.id}`}
              >
                OPEN SHEET
              </Button>
            </Link>
          </div>
        }
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ReviewSortDropdown value={sortMode} onChange={setSortMode} testId="select-sort-sheets" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sheets.map((sheet) => renderCard(sheet))}
      </div>
    </div>
  );
}

const LORE_FIELD_LABELS: Record<string, string> = {
  category: "Category",
  name: "Name",
  summary: "Summary",
  responsibleFixer: "Story Lead",
  aliases: "Aliases",
  publicBody: "Public Body",
  fixerBody: "Fixer-Only Body",
  sources: "Sources",
};

function fmtLoreValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    return v
      .map((item) =>
        item && typeof item === "object" && "label" in item
          ? (item as { label: string }).label
          : String(item),
      )
      .join(", ");
  }
  return String(v);
}

// A lore proposal (new entry OR edit) on the shared majority-vote review
// pipeline — it votes / tallies / closes exactly like Misc Requests and
// Character Edits. pending/changes_requested are "in vote"; approved/rejected
// are decided and awaiting a closer (the CLOSE & APPLY step is where lore's
// applyProposal actually publishes the entry). The card itself owns the vote /
// override / close / reopen mutations so its toasts + invalidation stay local.
function LoreEditCard({ edit, unseen }: { edit: LorePendingEdit; unseen: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListLoreEditsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
  };
  const onMutationError = (title: string) => (err: unknown) => {
    toast({ title, description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
  };

  const voteMut = useVoteLoreEdit({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        const decidedAs = (res as { decided?: string })?.decided;
        const cleared = (res as { cleared?: boolean })?.cleared;
        toast({
          title:
            decidedAs === "approved"
              ? "Approved — majority reached"
              : decidedAs === "rejected"
                ? "Rejected — majority reached"
                : cleared
                  ? "Vote cleared"
                  : "Vote recorded",
        });
      },
      onError: onMutationError("Could not vote"),
    },
  });
  const overrideMut = useOverrideLoreEdit({
    mutation: {
      onSuccess: (_res, vars) => {
        invalidate();
        toast({
          title:
            (vars as { data?: { decision?: string } })?.data?.decision === "deny"
              ? "Denied via override"
              : "Approved via override",
        });
      },
      onError: onMutationError("Could not override"),
    },
  });
  const actions = useReviewTicketActions(invalidate);

  const diff = (edit.proposedDiff ?? {}) as LoreEntryUpdate;
  const before = (edit.beforeSnapshot ?? {}) as Record<string, unknown>;
  const changedKeys = Object.keys(diff).filter((k) => k in LORE_FIELD_LABELS);
  const status = String(edit.status);
  const isVoting = status === "pending" || status === "changes_requested";
  const isApproved = status === "approved";
  const isRejected = status === "rejected";
  const tone: "default" | "approved" | "rejected" = isApproved
    ? "approved"
    : isRejected
      ? "rejected"
      : "default";

  return (
    <ReviewQueueCard
      subjectType="lore"
      id={edit.id}
      testId={`card-lore-edit-${edit.id}`}
      unseen={unseen}
      badgeLabel={`LORE ${edit.kind.toUpperCase()}`}
      badgeIcon={BookOpen}
      title={(diff.name as string) || edit.entryName || "New lore entry"}
      subtitle={`by ${edit.submittedByName || edit.submittedBy}`}
      date={edit.createdAt}
      tone={tone}
      showRoster={isVoting}
      roster={{
        eligibleReviewers: edit.eligibleReviewers ?? [],
        voters: (edit.voters ?? []).map((v) => ({ id: v.id, vote: v.vote })),
      }}
      markSeenOnMount
      awaitingVote={!!edit.canVote && !edit.myVote}
      tally={
        isVoting ? (
          <div className="font-mono text-xs text-muted-foreground" data-testid={`tally-lore-${edit.id}`}>
            <span className="text-nc-green">{edit.approveCount ?? 0}</span>/{edit.threshold ?? "?"} approve ·{" "}
            <span className="text-destructive">{edit.rejectCount ?? 0}</span> reject
            {edit.myVote ? (
              <span className="ml-2">
                · you voted{" "}
                <span className={edit.myVote === "approve" ? "text-nc-green" : "text-destructive"}>
                  {edit.myVote.toUpperCase()}
                </span>
              </span>
            ) : null}
          </div>
        ) : (
          <div className="font-mono text-xs" data-testid={`status-lore-${edit.id}`}>
            <span className={isApproved ? "text-nc-green font-display tracking-widest" : "text-destructive font-display tracking-widest"}>
              {isApproved ? "APPROVED — AWAITING CLOSE & APPLY" : "REJECTED — AWAITING CLOSE"}
            </span>
            {edit.decisionSummary ? <span className="block italic mt-0.5 text-muted-foreground">"{edit.decisionSummary}"</span> : null}
          </div>
        )
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {isVoting && status === "pending" && (
            <>
              {edit.canVote && (
                <>
                  <Button
                    className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                    disabled={voteMut.isPending}
                    onClick={() => voteMut.mutate({ id: edit.id, data: { vote: "approve" } })}
                    data-testid={`button-approve-lore-${edit.id}`}
                  >
                    {edit.myVote === "approve" ? "VOTED APPROVE" : "VOTE APPROVE"}
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                    disabled={voteMut.isPending}
                    onClick={() => voteMut.mutate({ id: edit.id, data: { vote: "reject" } })}
                    data-testid={`button-reject-lore-${edit.id}`}
                  >
                    {edit.myVote === "reject" ? "VOTED REJECT" : "VOTE REJECT"}
                  </Button>
                </>
              )}
              {edit.canOverride && (
                <OverrideButton
                  disabled={overrideMut.isPending}
                  onDecide={(decision) => overrideMut.mutate({ id: edit.id, data: { decision } })}
                  testIdSuffix={`lore-${edit.id}`}
                  subjectLabel="this lore edit"
                />
              )}
            </>
          )}
          {(isApproved || isRejected) && (
            <LifecycleActions subjectType="lore" id={edit.id} status={status} actions={actions} />
          )}
        </div>
      }
    >
      {edit.updateNote && (
        <p className="font-mono text-xs text-muted-foreground border-l-2 border-nc-cyan pl-3" data-testid={`text-lore-edit-note-${edit.id}`}>
          “{edit.updateNote}”
        </p>
      )}
      <div className="space-y-2">
        {changedKeys.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground italic">No field changes.</p>
        ) : (
          changedKeys.map((k) => (
            <div key={k} className="font-mono text-xs">
              <div className="text-nc-cyan uppercase tracking-widest mb-0.5">{LORE_FIELD_LABELS[k]}</div>
              {edit.kind === "edit" ? (
                <DiffValue before={fmtLoreValue(before[k])} after={fmtLoreValue((diff as Record<string, unknown>)[k])} compact />
              ) : (
                <div className="text-foreground whitespace-pre-wrap break-words">{fmtLoreValue((diff as Record<string, unknown>)[k])}</div>
              )}
            </div>
          ))
        )}
      </div>
    </ReviewQueueCard>
  );
}

function LoreEditsTab() {
  const [sortMode, setSortMode] = useState<ReviewSortMode>("updated");
  const pending = useListLoreEdits(
    { status: "pending" },
    { query: { queryKey: getListLoreEditsQueryKey({ status: "pending" }) } },
  );
  const approved = useListLoreEdits(
    { status: "approved" },
    { query: { queryKey: getListLoreEditsQueryKey({ status: "approved" }) } },
  );
  const rejected = useListLoreEdits(
    { status: "rejected" },
    { query: { queryKey: getListLoreEditsQueryKey({ status: "rejected" }) } },
  );
  const { data: unseenIds } = useGetReviewUnseenIds();
  const unseen = new Set((unseenIds?.lore ?? []) as number[]);

  const isLoading = pending.isLoading || approved.isLoading || rejected.isLoading;

  const combined = [
    ...((pending.data ?? []) as LorePendingEdit[]),
    ...((approved.data ?? []) as LorePendingEdit[]),
    ...((rejected.data ?? []) as LorePendingEdit[]),
  ];

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }
  if (combined.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No lore changes require attention.</p>
      </div>
    );
  }

  const sorted = decidedFirst(
    sortReviewItems(
      combined,
      sortMode,
      (l) => l.createdAt,
      (l) => l.lastActivityAt,
    ),
    (l) => String(l.status),
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ReviewSortDropdown value={sortMode} onChange={setSortMode} testId="select-sort-lore" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sorted.map((e) => (
          <LoreEditCard key={e.id} edit={e} unseen={unseen.has(e.id)} />
        ))}
      </div>
    </div>
  );
}

const GUIDEBOOK_FIELD_LABELS: Record<string, string> = {
  section: "Section",
  title: "Title",
  description: "Description",
  body: "Body",
  images: "Images",
  sources: "Sources",
  position: "Position",
};

function GuidebookEditCard({ edit }: { edit: GuidebookPendingEdit }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: getListGuidebookEditsQueryKey() });

  const approve = useApproveGuidebookEdit({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: "Guidebook change approved & published" }); },
      onError: (err) => toast({ title: "Could not approve", description: apiErrorMessage(err, "Try again."), variant: "destructive" }),
    },
  });
  const reject = useRejectGuidebookEdit({
    mutation: {
      onSuccess: () => { invalidate(); setRejecting(false); setNote(""); toast({ title: "Guidebook change rejected" }); },
      onError: (err) => toast({ title: "Could not reject", description: apiErrorMessage(err, "Try again."), variant: "destructive" }),
    },
  });

  const diff = (edit.proposedDiff ?? {}) as GuidebookPageUpdate;
  const before = (edit.beforeSnapshot ?? {}) as Record<string, unknown>;
  const changedKeys = Object.keys(diff).filter((k) => k in GUIDEBOOK_FIELD_LABELS);
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="rounded-none border-border bg-card/50 flex flex-col" data-testid={`card-guidebook-edit-${edit.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-mono text-[10px]">
            <BookMarked className="w-3 h-3 mr-1" /> GUIDEBOOK {edit.kind.toUpperCase()}
          </Badge>
          <span className="text-xs font-mono text-muted-foreground">{formatDate(edit.createdAt)}</span>
        </div>
        <CardTitle className="text-lg font-display truncate mt-2">
          {(diff.title as string) || edit.pageTitle || "New guidebook page"}
        </CardTitle>
        <CardDescription className="font-mono text-xs">by {edit.submittedByName || edit.submittedBy}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 gap-4">
        {edit.updateNote && (
          <p className="font-mono text-xs text-muted-foreground border-l-2 border-nc-cyan pl-3" data-testid={`text-guidebook-edit-note-${edit.id}`}>
            “{edit.updateNote}”
          </p>
        )}
        <div className="space-y-2">
          {changedKeys.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground italic">No field changes.</p>
          ) : (
            changedKeys.map((k) => (
              <div key={k} className="font-mono text-xs">
                <div className="text-nc-cyan uppercase tracking-widest mb-0.5">{GUIDEBOOK_FIELD_LABELS[k]}</div>
                {edit.kind === "edit" ? (
                  <DiffValue before={fmtLoreValue(before[k])} after={fmtLoreValue((diff as Record<string, unknown>)[k])} compact />
                ) : (
                  <div className="text-foreground whitespace-pre-wrap break-words">{fmtLoreValue((diff as Record<string, unknown>)[k])}</div>
                )}
              </div>
            ))
          )}
        </div>

        {rejecting ? (
          <div className="mt-auto space-y-2 pt-3 border-t border-border/40">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (optional)"
              className="rounded-none font-mono"
              data-testid={`input-guidebook-reject-note-${edit.id}`}
            />
            <div className="flex gap-2">
              <Button variant="ghost" className="rounded-none flex-1 font-display text-xs" onClick={() => setRejecting(false)}>CANCEL</Button>
              <Button
                variant="outline"
                className="rounded-none flex-1 border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                disabled={busy}
                onClick={() => reject.mutate({ id: edit.id, data: { decisionSummary: note.trim() || undefined } })}
                data-testid={`button-confirm-reject-guidebook-${edit.id}`}
              >
                {reject.isPending ? "..." : "CONFIRM REJECT"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-auto flex gap-2 pt-3 border-t border-border/40">
            <Button
              className="rounded-none flex-1 bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
              disabled={busy}
              onClick={() => approve.mutate({ id: edit.id })}
              data-testid={`button-approve-guidebook-${edit.id}`}
            >
              {approve.isPending ? "PUBLISHING..." : "APPROVE & PUBLISH"}
            </Button>
            <Button
              variant="outline"
              className="rounded-none flex-1 border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
              disabled={busy}
              onClick={() => setRejecting(true)}
              data-testid={`button-reject-guidebook-${edit.id}`}
            >
              REJECT
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GuidebookEditsTab() {
  const { data, isLoading } = useListGuidebookEdits({ status: "pending" });
  const edits = (data ?? []) as GuidebookPendingEdit[];

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }
  if (edits.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <BookMarked className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No guidebook changes await approval.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {edits.map((e) => (
        <GuidebookEditCard key={e.id} edit={e} />
      ))}
    </div>
  );
}

// ---- Cross-cutting Completed / Denied terminal tabs ----
//
// These two tabs aggregate the terminal items from all four queues (custom
// requests, character edits, new-character sheets, lore) so staff can review
// what has already been decided in one place, separate from active work.
//
// Decision mapping:
//   approved              -> Completed
//   rejected / cancelled  -> Denied
//   closed (custom req)   -> Completed when appliedRef is set, else Denied
//   closed (edit/sheet)   -> Completed (closing is the apply-on-close of an
//                            approved item; rejected-then-closed is rare)
//   lore has no closed state (approved=Completed, rejected=Denied).

type TerminalKind = "request" | "edit" | "sheet" | "lore" | "guidebook";
type TerminalDecision = "completed" | "denied";

interface TerminalItem {
  key: string;
  kind: TerminalKind;
  // Only request/edit/sheet support reopen via the review lifecycle; lore is null.
  subjectType: "request" | "edit" | "sheet" | null;
  id: number;
  title: string;
  subtitle: string;
  date: string;
  status: string;
  note?: string | null;
  archived: boolean;
  detailHref?: string;
  badgeLabel: string;
  Icon: typeof Home;
}

function classifyRequest(r: CustomRequest): TerminalDecision | null {
  const status = String(r.status);
  // approved / rejected are NOT terminal anymore — they live in the Misc queue
  // as green / red action cards awaiting CLOSE & APPLY / CLOSE & DENY. Only a
  // closed (or cancelled) request is truly done and belongs in the history tabs.
  if (status === "cancelled") return "denied";
  if (status === "closed") return r.appliedRef ? "completed" : "denied";
  return null;
}

// Shared mapping for edits and sheets: approved/closed -> Completed,
// rejected/cancelled -> Denied.
function classifyEditOrSheet(status: string): TerminalDecision | null {
  if (status === "approved" || status === "closed") return "completed";
  if (status === "rejected" || status === "cancelled") return "denied";
  return null;
}

// Aggregates terminal items across the four queues, gated by role visibility so
// we never fetch (or 403 on) a queue the viewer can't see.
function useTerminalItems() {
  const { data: me } = useEffectiveMe();
  // Unified reviewer pool (fixer / cs-approver / admin) for every queue's
  // terminal (completed/denied) history, matching the server.
  const canMisc = !!(me?.isAdmin || me?.isFixer || me?.isCsApprover);
  const canEdits = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  const canSheets = !!(me?.isAdmin || me?.isCsApprover || me?.isFixer);
  // Lore now rides the shared reviewer pipeline (fixer / cs-approver / admin);
  // guidebook is still the admin-only flow.
  const canLore = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  const canGuidebook = !!me?.isAdmin;

  const reqResolved = useListCustomRequests(
    { bucket: "resolved" },
    { query: { enabled: canMisc, queryKey: getListCustomRequestsQueryKey({ bucket: "resolved" }) } },
  );
  const reqArchive = useListCustomRequests(
    { bucket: "archive" },
    { query: { enabled: canMisc, queryKey: getListCustomRequestsQueryKey({ bucket: "archive" }) } },
  );
  const editResolved = useListPendingEdits(
    { bucket: "resolved" },
    { query: { enabled: canEdits, queryKey: getListPendingEditsQueryKey({ bucket: "resolved" }) } },
  );
  const editArchive = useListPendingEdits(
    { bucket: "archive" },
    { query: { enabled: canEdits, queryKey: getListPendingEditsQueryKey({ bucket: "archive" }) } },
  );
  const sheetResolved = useListPendingSheets(
    { bucket: "resolved" },
    { query: { enabled: canSheets, queryKey: getListPendingSheetsQueryKey({ bucket: "resolved" }) } },
  );
  const sheetArchive = useListPendingSheets(
    { bucket: "archive" },
    { query: { enabled: canSheets, queryKey: getListPendingSheetsQueryKey({ bucket: "archive" }) } },
  );
  // Lore decided (approved/rejected) items now live in the active LORE queue
  // awaiting CLOSE & APPLY; only a CLOSED lore proposal is truly terminal.
  const loreClosed = useListLoreEdits(
    { status: "closed" },
    { query: { enabled: canLore, queryKey: getListLoreEditsQueryKey({ status: "closed" }) } },
  );
  const guidebookApproved = useListGuidebookEdits(
    { status: "approved" },
    { query: { enabled: canGuidebook, queryKey: getListGuidebookEditsQueryKey({ status: "approved" }) } },
  );
  const guidebookRejected = useListGuidebookEdits(
    { status: "rejected" },
    { query: { enabled: canGuidebook, queryKey: getListGuidebookEditsQueryKey({ status: "rejected" }) } },
  );

  const isLoading =
    reqResolved.isLoading || reqArchive.isLoading ||
    editResolved.isLoading || editArchive.isLoading ||
    sheetResolved.isLoading || sheetArchive.isLoading ||
    loreClosed.isLoading ||
    guidebookApproved.isLoading || guidebookRejected.isLoading;

  const completed: TerminalItem[] = [];
  const denied: TerminalItem[] = [];
  const push = (decision: TerminalDecision | null, item: TerminalItem) => {
    if (decision === "completed") completed.push(item);
    else if (decision === "denied") denied.push(item);
  };

  const requests = [
    ...((reqResolved.data ?? []) as CustomRequest[]),
    ...((reqArchive.data ?? []) as CustomRequest[]),
  ];
  for (const r of requests) {
    const status = String(r.status);
    push(classifyRequest(r), {
      key: `request-${r.id}`,
      kind: "request",
      subjectType: "request",
      id: r.id,
      title: r.title,
      subtitle: `${r.characterName} · by ${r.requestedByName || r.requestedById}`,
      date: (r as { closedAt?: string | null }).closedAt || r.reviewedAt || r.createdAt,
      status,
      note: r.reviewerNote,
      archived: status === "closed",
      badgeLabel: TYPE_META[r.type]?.label ?? "REQUEST",
      Icon: TYPE_META[r.type]?.Icon ?? Inbox,
    });
  }

  const edits = [
    ...((editResolved.data ?? []) as PendingEditSummary[]),
    ...((editArchive.data ?? []) as PendingEditSummary[]),
  ];
  for (const e of edits) {
    const status = String(e.status);
    const anyEdit = e as Record<string, any>;
    push(classifyEditOrSheet(status), {
      key: `edit-${e.id}`,
      kind: "edit",
      subjectType: "edit",
      id: e.id,
      title: anyEdit.characterName ?? `Edit #${e.id}`,
      subtitle: `by ${anyEdit.submitterName || anyEdit.submittedBy || "unknown"}`,
      date: anyEdit.decidedAt || anyEdit.submittedAt || anyEdit.createdAt || new Date().toISOString(),
      status,
      note: anyEdit.decisionSummary ?? null,
      archived: status === "closed",
      detailHref: `/pending-edits/${e.id}`,
      badgeLabel: "CHAR EDIT",
      Icon: FileText,
    });
  }

  const sheets = [
    ...((sheetResolved.data ?? []) as any[]),
    ...((sheetArchive.data ?? []) as any[]),
  ];
  for (const s of sheets) {
    const status = String(s.status);
    push(classifyEditOrSheet(status), {
      key: `sheet-${s.id}`,
      kind: "sheet",
      subjectType: "sheet",
      id: s.id,
      title: s.name ?? `Sheet #${s.id}`,
      subtitle: `by ${s.ownerName || s.ownerId || "unknown"}`,
      date: s.decidedAt || s.createdAt || new Date().toISOString(),
      status,
      note: null,
      archived: status === "closed",
      detailHref: `/sheets/${s.id}`,
      badgeLabel: "NEW CHAR",
      Icon: FileText,
    });
  }

  // A closed lore proposal that published an entry (appliedEntryId set) is
  // Completed; a closed-after-rejection one is Denied.
  const loreToItem = (l: LorePendingEdit): TerminalItem => {
    const diff = (l.proposedDiff ?? {}) as Record<string, unknown>;
    return {
      key: `lore-${l.id}`,
      kind: "lore",
      subjectType: null,
      id: l.id,
      title: (diff.name as string) || l.entryName || "Lore entry",
      subtitle: `by ${l.submittedByName || l.submittedBy}`,
      date: (l as { closedAt?: string | null }).closedAt || (l as { decidedAt?: string | null }).decidedAt || l.createdAt,
      status: "closed",
      note: (l as { decisionSummary?: string | null }).decisionSummary ?? null,
      archived: true,
      detailHref: l.appliedEntryId ? `/directory/lore` : undefined,
      badgeLabel: "LORE",
      Icon: BookOpen,
    };
  };
  for (const l of (loreClosed.data ?? []) as LorePendingEdit[]) {
    const item = loreToItem(l);
    if (l.appliedEntryId) completed.push(item);
    else denied.push(item);
  }

  const guidebookToItem = (g: GuidebookPendingEdit, decision: TerminalDecision): TerminalItem => {
    const diff = (g.proposedDiff ?? {}) as Record<string, unknown>;
    return {
      key: `guidebook-${g.id}`,
      kind: "guidebook",
      subjectType: null,
      id: g.id,
      title: (diff.title as string) || g.pageTitle || "Guidebook page",
      subtitle: `by ${g.submittedByName || g.submittedBy}`,
      date: g.decidedAt || g.createdAt,
      status: decision === "completed" ? "approved" : "rejected",
      note: g.decisionSummary ?? null,
      archived: false,
      detailHref: decision === "completed" && g.appliedPageId ? `/guidebook/${g.appliedPageId}` : undefined,
      badgeLabel: "GUIDEBOOK",
      Icon: BookMarked,
    };
  };
  for (const g of (guidebookApproved.data ?? []) as GuidebookPendingEdit[]) completed.push(guidebookToItem(g, "completed"));
  for (const g of (guidebookRejected.data ?? []) as GuidebookPendingEdit[]) denied.push(guidebookToItem(g, "denied"));

  const byDateDesc = (a: TerminalItem, b: TerminalItem) =>
    new Date(b.date).getTime() - new Date(a.date).getTime();
  completed.sort(byDateDesc);
  denied.sort(byDateDesc);

  // Approved-but-not-yet-applied tickets: decided (status "approved") but their
  // effect (lease / inventory item / new character) is only created when the
  // ticket is closed. These are surfaced in the top "Ready to apply" panel so
  // staff finish them in place instead of digging through the Completed tab.
  // Lore/guidebook (subjectType null) apply immediately on approve, so excluded.
  const readyToApply = completed.filter(
    (i) => i.subjectType !== null && i.status === "approved" && !i.archived,
  );
  readyToApply.sort(byDateDesc);

  return { completed, denied, readyToApply, isLoading };
}

function TerminalCard({
  item,
  actions,
}: {
  item: TerminalItem;
  actions: ReturnType<typeof useReviewTicketActions>;
}) {
  const Icon = item.Icon;
  return (
    <Card className="rounded-none border-border bg-card/50 flex flex-col" data-testid={`card-terminal-${item.kind}-${item.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-mono text-[10px]">
            <Icon className="w-3 h-3 mr-1" /> {item.badgeLabel}
          </Badge>
          <span className="text-xs font-mono text-muted-foreground">{formatDate(item.date)}</span>
        </div>
        <CardTitle className="text-lg font-display truncate mt-2">{item.title}</CardTitle>
        <CardDescription className="font-mono text-xs">{item.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 gap-3">
        <div className="font-mono text-xs text-muted-foreground" data-testid={`status-terminal-${item.kind}-${item.id}`}>
          Status: <span className="text-foreground uppercase">{item.status.replace("_", " ")}</span>
          {item.archived ? <span className="ml-2 text-nc-yellow">ARCHIVED</span> : null}
          {item.note ? <span className="block italic mt-0.5">"{item.note}"</span> : null}
        </div>
        <div className="mt-auto pt-3 border-t border-border/40 space-y-2">
          {item.detailHref ? (
            <Link href={item.detailHref}>
              <Button
                variant="outline"
                className="w-full rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
                data-testid={`button-open-terminal-${item.kind}-${item.id}`}
              >
                VIEW
              </Button>
            </Link>
          ) : null}
          {/* Resolved (non-archived) request/edit/sheet keep Close + Reopen.
              Archived custom requests offer Reopen only (responding disabled).
              Archived edits/sheets and lore are read-only. */}
          {!item.archived && item.subjectType ? (
            <LifecycleActions subjectType={item.subjectType} id={item.id} status={item.status} actions={actions} />
          ) : item.archived && item.kind === "request" ? (
            <Button
              variant="outline"
              className="w-full rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
              disabled={actions.busy}
              onClick={() => actions.reopen.mutate({ subjectType: "request", id: item.id })}
              data-testid={`button-reopen-request-${item.id}`}
            >
              REOPEN
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function TerminalTab({ which }: { which: TerminalDecision }) {
  const qc = useQueryClient();
  const { completed, denied, isLoading } = useTerminalItems();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
    qc.invalidateQueries({ queryKey: getListLoreEditsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
  };
  const actions = useReviewTicketActions(invalidate);
  const items = which === "completed" ? completed : denied;

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }
  if (items.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <Inbox className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">NOTHING HERE</h3>
        <p className="text-muted-foreground font-mono text-sm">
          No {which} requests yet.
        </p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {items.map((item) => (
        <TerminalCard key={item.key} item={item} actions={actions} />
      ))}
    </div>
  );
}

// Small count chip shown next to a tab label. Renders nothing when zero so
// quiet queues stay uncluttered.
function TabCount({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span
      className="ml-2 min-w-5 h-5 px-1.5 inline-flex items-center justify-center bg-nc-yellow text-background font-mono text-[11px] font-bold rounded-none shadow-[0_0_8px_rgba(255,255,0,0.5)]"
      data-testid="badge-tab-count"
    >
      {n}
    </span>
  );
}

export default function PendingRequests() {
  const { data: me } = useEffectiveMe();
  // STAFF VIEW access to the queues is broad (fixer / cs-approver / admin),
  // matching the server's isReviewer. Casting a counted vote is narrower —
  // CS_APPROVER only (see canVote above). Fixers and admins see the tab + badges
  // and the roster, but can't vote (admins use OVERRIDE).
  const canMisc = !!(me?.isAdmin || me?.isFixer || me?.isCsApprover);
  // Archivists also reach the Misc tab to approve mission proposals.
  const canSeeMisc = canMisc || !!me?.isArchivist;
  // Fixers still have staff access to the Sheets queue (sidebar badge counts
  // unseen sheets for them), so they must see the Sheets tab — they just can't
  // cast counted votes there anymore.
  const canNewChars = !!(me?.isAdmin || me?.isCsApprover || me?.isFixer);
  // Lore now rides the shared reviewer pipeline (fixer / cs-approver / admin);
  // guidebook is still the admin-only flow.
  const canLore = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  const canGuidebook = !!me?.isAdmin;
  // The terminal (Completed/Denied) tabs aggregate reviewer queues; only show
  // them to staff who can see at least one of those queues.
  const isReviewer = canSeeMisc || canNewChars || canLore;

  // Per-tab badges show UNSEEN-by-me counts (drop once the reviewer opens an
  // item), not the raw pending totals — lore now has seen-tracking like the
  // other reviewer queues. Guidebook stays the admin-only pending count.
  const { data: unseen } = useGetReviewUnseenCounts();
  const { data: guidebookData } = useListGuidebookEdits(
    { status: "pending" },
    { query: { enabled: canGuidebook, queryKey: getListGuidebookEditsQueryKey({ status: "pending" }) } },
  );
  const miscCount = unseen?.requests ?? 0;
  const editsCount = unseen?.edits ?? 0;
  const sheetsCount = unseen?.sheets ?? 0;
  const loreCount = unseen?.lore ?? 0;
  const guidebookCount = (guidebookData ?? []).length;

  // Land on the first tab that actually has unseen items, so a reviewer arriving
  // from the sidebar "Review Queue" badge isn't dropped on an empty MISC tab
  // while the pending item sits on, say, CHARACTER EDITS (the badge aggregates
  // every queue). Falls back to the first tab the staffer can act on when every
  // queue is clear. Controlled (not defaultValue) because the counts load
  // asynchronously after mount; once the viewer picks a tab, that choice sticks.
  const computedTab =
    canMisc && miscCount > 0
      ? "misc"
      : editsCount > 0
        ? "edits"
        : canNewChars && sheetsCount > 0
          ? "sheets"
          : canLore && loreCount > 0
            ? "lore"
            : canGuidebook && guidebookCount > 0
              ? "guidebook"
              : canSeeMisc
                ? "misc"
                : "edits";
  // Honor a ?tab= deep link as the initial tab (used by "back to queue" from
  // detail pages). It seeds the initial value only; once the viewer clicks a
  // tab, activeTab takes over and that choice sticks. Validate against the tabs
  // this viewer can actually see (mirrors the TabsTrigger guards below) so a
  // crafted URL can't strand them on an unrendered, empty tab.
  const visibleTabs = new Set<string>(["edits"]);
  if (canSeeMisc) visibleTabs.add("misc");
  if (canNewChars) visibleTabs.add("sheets");
  if (canLore) visibleTabs.add("lore");
  if (canGuidebook) visibleTabs.add("guidebook");
  if (isReviewer) { visibleTabs.add("completed"); visibleTabs.add("denied"); }
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const urlTab = searchParams.get("tab");
  const initialUrlTab = urlTab && visibleTabs.has(urlTab) ? urlTab : null;
  // A ?focus=<requestId> deep link (from the Discord CS-approver post) targets a
  // misc request, so land on the MISC tab and let it expand + scroll the card.
  const focusParam = searchParams.get("focus");
  const focusId = focusParam && /^\d+$/.test(focusParam) ? Number(focusParam) : null;
  const focusTab = focusId != null && canSeeMisc ? "misc" : null;
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const tab = activeTab ?? initialUrlTab ?? focusTab ?? computedTab;
  const unseenLoaded = unseen !== undefined;

  // Once the unseen counts have loaded, freeze the resolved tab into state. The
  // auto-land heuristic (computedTab) is derived live from those counts, so
  // without this, marking an item as seen — even just by opening its thread —
  // would drop a count, recompute computedTab, and slide the viewer onto a
  // different tab. Freezing means the tab only changes when the viewer clicks one.
  useEffect(() => {
    if (activeTab != null || !unseenLoaded) return;
    setActiveTab(initialUrlTab ?? focusTab ?? computedTab);
  }, [activeTab, unseenLoaded, initialUrlTab, focusTab, computedTab]);

  // Mirror the active tab into the URL (?tab=) so navigating into a detail page
  // (View / Open Edit) and clicking browser Back restores the same tab instead
  // of falling back to the auto-land heuristic. Replace (not push) so we don't
  // litter history; the equality guard prevents a navigate loop.
  useEffect(() => {
    if (!unseenLoaded || urlTab === tab) return;
    const params = new URLSearchParams(search);
    params.set("tab", tab);
    navigate(`/requests?${params.toString()}`, { replace: true });
  }, [tab, urlTab, unseenLoaded, search, navigate]);

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-pending-requests-title"
        >
          <Clock className="w-8 h-8 text-nc-yellow" /> REVIEW QUEUE
        </h1>
        <p className="text-muted-foreground font-mono mt-2">Review player submissions across the server.</p>
      </div>

      <Tabs value={tab} onValueChange={setActiveTab}>
        <TabsList className="rounded-none bg-card/60 border border-border p-1 flex flex-wrap h-auto justify-start gap-1">
          {canSeeMisc && (
            <TabsTrigger value="misc" className="rounded-none font-display tracking-widest" data-testid="tab-misc">
              MISC REQUESTS<TabCount n={miscCount} />
            </TabsTrigger>
          )}
          <TabsTrigger value="edits" className="rounded-none font-display tracking-widest" data-testid="tab-edits">
            CHARACTER EDITS<TabCount n={editsCount} />
          </TabsTrigger>
          {canNewChars && (
            <TabsTrigger value="sheets" className="rounded-none font-display tracking-widest" data-testid="tab-sheets">
              NEW CHARACTERS<TabCount n={sheetsCount} />
            </TabsTrigger>
          )}
          {canLore && (
            <TabsTrigger value="lore" className="rounded-none font-display tracking-widest" data-testid="tab-lore">
              LORE<TabCount n={loreCount} />
            </TabsTrigger>
          )}
          {canGuidebook && (
            <TabsTrigger value="guidebook" className="rounded-none font-display tracking-widest" data-testid="tab-guidebook">
              GUIDEBOOK<TabCount n={guidebookCount} />
            </TabsTrigger>
          )}
          {isReviewer && (
            <TabsTrigger value="completed" className="rounded-none font-display tracking-widest" data-testid="tab-completed">
              COMPLETED
            </TabsTrigger>
          )}
          {isReviewer && (
            <TabsTrigger value="denied" className="rounded-none font-display tracking-widest" data-testid="tab-denied">
              DENIED
            </TabsTrigger>
          )}
        </TabsList>

        {canSeeMisc && (
          <TabsContent value="misc" className="mt-6">
            <ErrorBoundary><MiscRequestsTab focusId={focusId} /></ErrorBoundary>
          </TabsContent>
        )}
        <TabsContent value="edits" className="mt-6">
          <ErrorBoundary><PendingEditsList embedded activeOnly /></ErrorBoundary>
        </TabsContent>
        {canNewChars && (
          <TabsContent value="sheets" className="mt-6">
            <ErrorBoundary><NewCharactersTab /></ErrorBoundary>
          </TabsContent>
        )}
        {canLore && (
          <TabsContent value="lore" className="mt-6">
            <ErrorBoundary><LoreEditsTab /></ErrorBoundary>
          </TabsContent>
        )}
        {canGuidebook && (
          <TabsContent value="guidebook" className="mt-6">
            <ErrorBoundary><GuidebookEditsTab /></ErrorBoundary>
          </TabsContent>
        )}
        {isReviewer && (
          <TabsContent value="completed" className="mt-6">
            <ErrorBoundary><TerminalTab which="completed" /></ErrorBoundary>
          </TabsContent>
        )}
        {isReviewer && (
          <TabsContent value="denied" className="mt-6">
            <ErrorBoundary><TerminalTab which="denied" /></ErrorBoundary>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
