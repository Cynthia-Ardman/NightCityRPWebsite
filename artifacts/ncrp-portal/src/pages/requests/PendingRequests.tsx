import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import {
  useListCustomRequests,
  useVoteCustomRequest,
  useOverrideCustomRequest,
  useListPendingSheets,
  useVoteSheet,
  useOverrideSheet,
  useListPendingEdits,
  useListLoreEdits,
  useApproveLoreEdit,
  useRejectLoreEdit,
  useListGuidebookEdits,
  useApproveGuidebookEdit,
  useRejectGuidebookEdit,
  useCloseReviewTicket,
  useGetReviewUnseenCounts,
  useGetReviewUnseenIds,
  getGetReviewUnseenIdsQueryKey,
  getGetReviewUnseenCountsQueryKey,
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
import { type LifecycleBucket } from "@/lib/reviewLifecycle";
import { formatEddies } from "@/lib/format";
import { ReviewSortDropdown, sortReviewItems, type ReviewSortMode } from "./reviewSort";
import { useReviewTicketActions, LifecycleActions } from "@/components/review/ReviewLifecycleUI";
import { ReviewQueueCard } from "@/components/review/ReviewQueueCard";
import DiscordThreadDrawer from "@/components/DiscordThreadDrawer";
import DiffValue from "@/components/DiffValue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Clock, FileText, Inbox, Home, Crosshair, Cpu, Store, Syringe, BookOpen, BookMarked, PackagePlus, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import PendingEditsList from "@/pages/pending-edits/PendingEditsList";
import ErrorBoundary from "@/components/ErrorBoundary";

const TYPE_META: Record<
  CustomRequest["type"],
  { label: string; Icon: typeof Home }
> = {
  property: { label: "PROPERTY", Icon: Home },
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
  // Active-only tab: completed/denied requests live in the cross-cutting
  // Completed/Denied tabs. We only fetch the active bucket here.
  const { data: active, isLoading } = useListCustomRequests({ bucket: "active" });
  const { data: unseenIds } = useGetReviewUnseenIds();
  const { data: me } = useEffectiveMe();
  const [approveTarget, setApproveTarget] = useState<CustomRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CustomRequest | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<CustomRequest | null>(null);
  const [sortMode, setSortMode] = useState<ReviewSortMode>("updated");

  const isReviewer = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  // Approver pool: only fixers / cs-approvers cast counted votes. A pure admin
  // (no fixer role) is staff (sees the queue + roster + override) but is NOT an
  // approver — they use OVERRIDE, not the vote buttons.
  const canVote = !!(me?.isFixer || me?.isCsApprover);
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

  const activeRequests = sortReviewItems(
    (active ?? []) as CustomRequest[],
    sortMode,
    (r) => r.createdAt,
    (r) => r.lastActivityAt,
  );

  // A ?focus=<id> deep link (from the Discord CS-approver post) scrolls the
  // matching card into view once the active queue has rendered.
  useEffect(() => {
    if (focusId == null) return;
    const el = document.getElementById(`review-request-${focusId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, activeRequests.length]);

  const renderCard = (r: CustomRequest, bucket: LifecycleBucket) => {
    const meta = TYPE_META[r.type] ?? { label: "REQUEST", Icon: Inbox };
    const det = venueDetails(r);
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
        showRoster={isReviewer && bucket === "active"}
        roster={{
          eligibleReviewers: r.eligibleReviewers ?? [],
          voters: (r.voters ?? []).map((v) => ({ id: v.id, vote: v.vote })),
        }}
        markSeenOnMount={isReviewer}
        initiallyExpanded={r.id === focusId}
        awaitingVote={canVote && bucket === "active" && r.status === "pending" && !r.myVote}
        tally={
          bucket === "active" ? (
            <div className="font-mono text-xs text-muted-foreground" data-testid={`tally-misc-${r.id}`}>
              <span className="text-nc-green">{r.approveCount ?? 0}</span>/{r.threshold ?? "?"} approve ·{" "}
              <span className="text-destructive">{r.rejectCount ?? 0}</span> reject
              {r.myVote ? (
                <span className="ml-2">
                  · you voted{" "}
                  <span className={r.myVote === "approve" ? "text-nc-green" : "text-destructive"}>
                    {r.myVote.toUpperCase()}
                  </span>
                </span>
              ) : null}
            </div>
          ) : (
            <div className="font-mono text-xs text-muted-foreground" data-testid={`status-misc-${r.id}`}>
              Status: <span className="text-foreground uppercase">{r.status.replace("_", " ")}</span>
              {r.reviewerNote ? <span className="block italic mt-0.5">"{r.reviewerNote}"</span> : null}
            </div>
          )
        }
        actions={
          isReviewer ? (
            <div className="flex flex-wrap gap-2">
              {bucket === "active" && r.status === "pending" && (
                <>
                  {canVote && (
                    <>
                      <Button
                        className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                        onClick={() => setApproveTarget(r)}
                        data-testid={`button-approve-misc-${r.id}`}
                      >
                        {r.myVote === "approve" ? "VOTED APPROVE" : "VOTE APPROVE"}
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                        onClick={() => setRejectTarget(r)}
                        data-testid={`button-reject-misc-${r.id}`}
                      >
                        {r.myVote === "reject" ? "VOTED REJECT" : "VOTE REJECT"}
                      </Button>
                    </>
                  )}
                  {isAdmin && (
                    <Button
                      variant="outline"
                      className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                      onClick={() => setOverrideTarget(r)}
                      data-testid={`button-override-misc-${r.id}`}
                    >
                      OVERRIDE
                    </Button>
                  )}
                </>
              )}
              <DiscordThreadDrawer
                subjectType="request"
                subjectId={r.id}
                buttonLabel="SEE THREAD"
                watchUnread
                buttonClassName="rounded-none border-nc-magenta/60 text-nc-magenta hover:bg-nc-magenta/10 font-display text-xs tracking-widest h-9 shrink-0"
              />
            </div>
          ) : null
        }
      >
        {r.imageUrl ? (
          <a
            href={r.imageUrl}
            target="_blank"
            rel="noreferrer"
            className="block border border-border bg-background"
            data-testid={`link-misc-image-${r.id}`}
          >
            <img
              src={r.imageUrl}
              alt={r.title}
              className="w-full h-40 object-contain"
              loading="lazy"
              data-testid={`img-misc-request-${r.id}`}
            />
          </a>
        ) : null}
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

  if (isLoading || (canSeeOwnedMissions && ownedMissions.isLoading)) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }

  if (activeRequests.length === 0 && missionProposals.length === 0) {
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

      {activeRequests.length > 0 && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <ReviewSortDropdown value={sortMode} onChange={setSortMode} testId="select-sort-misc" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {activeRequests.map((r) => renderCard(r, "active"))}
          </div>
        </div>
      )}

      <ApproveDialog request={approveTarget} mode="vote" onClose={() => setApproveTarget(null)} />
      <ApproveDialog request={overrideTarget} mode="override" onClose={() => setOverrideTarget(null)} />
      <RejectDialog request={rejectTarget} onClose={() => setRejectTarget(null)} />
    </div>
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
          description: e instanceof Error ? e.message : "Please try again.",
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
                    {when ? when.toLocaleDateString() : "No date"}
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

function ApproveDialog({
  request,
  mode,
  onClose,
}: {
  request: CustomRequest | null;
  mode: "vote" | "override";
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reviewerNote, setReviewerNote] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("");
  const [kind, setKind] = useState<"residential" | "business">("residential");
  const [businessName, setBusinessName] = useState("");
  const [cwp, setCwp] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [retail, setRetail] = useState("");
  const [qty, setQty] = useState("1");

  // Re-seed local form state whenever a different request is opened.
  const seedKey = request?.id ?? -1;
  const [seededFor, setSeededFor] = useState(-1);
  if (request && seededFor !== seedKey) {
    setReviewerNote("");
    setMonthlyRent("");
    setKind("residential");
    setBusinessName("");
    setCwp("");
    setUnitCost("");
    setRetail("");
    setQty("1");
    setSeededFor(seedKey);
  }

  const onDone = (title: string) => {
    // Invalidate the base key (no params) so every bucket variant — active /
    // resolved / archive — refetches. The list is fetched with { bucket } but a
    // status-scoped key here would not prefix-match it, leaving votes stale
    // until a manual refresh.
    qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey() });
    toast({ title });
    onClose();
  };
  const onFail = (err: unknown) => {
    const msg =
      (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
      (err instanceof Error ? err.message : "Please try again.");
    toast({ title: "Could not approve", description: msg, variant: "destructive" });
  };

  const voteApprove = useVoteCustomRequest({
    mutation: {
      onSuccess: (res) => onDone((res as { decided?: string })?.decided === "approved" ? "Request approved — majority reached" : "Approve vote recorded"),
      onError: onFail,
    },
  });
  const override = useOverrideCustomRequest({
    mutation: {
      onSuccess: (_res, vars) =>
        onDone(
          (vars as { data?: { decision?: string } })?.data?.decision === "deny"
            ? "Request denied via override"
            : "Request approved via override",
        ),
      onError: onFail,
    },
  });
  const busy = voteApprove.isPending || override.isPending;

  if (!request) return null;

  const isProperty = request.type === "property";
  const isCyberware = request.type === "cyberware";
  const isVenueStock = request.type === "venue_stock";
  const rentNum = parseInt(monthlyRent, 10);
  const cwpNum = parseInt(cwp, 10);
  const unitCostNum = parseInt(unitCost, 10);
  const retailNum = parseInt(retail, 10);
  const qtyNum = parseInt(qty, 10);
  const valid =
    (!isProperty || (Number.isFinite(rentNum) && rentNum >= 0)) &&
    (!isCyberware || (Number.isFinite(cwpNum) && cwpNum >= 0)) &&
    (!isVenueStock ||
      (Number.isFinite(unitCostNum) && unitCostNum >= 0 &&
        Number.isFinite(retailNum) && retailNum >= 0 &&
        Number.isFinite(qtyNum) && qtyNum >= 1));

  const submit = () => {
    const params = {
      ...(isProperty ? { monthlyRent: rentNum, kind, ...(businessName.trim() ? { businessName: businessName.trim() } : {}) } : {}),
      ...(isCyberware ? { cwp: cwpNum } : {}),
      ...(isVenueStock ? { unitCost: unitCostNum, retail: retailNum, qty: qtyNum } : {}),
    };
    if (mode === "override") {
      override.mutate({ id: request.id, data: { decision: "approve", reviewerNote: reviewerNote.trim() || undefined, ...params } });
    } else {
      voteApprove.mutate({ id: request.id, data: { vote: "approve", note: reviewerNote.trim() || undefined, ...params } });
    }
  };

  const heading = mode === "override" ? "OVERRIDE" : "VOTE APPROVE";
  const cta = mode === "override" ? "OVERRIDE & APPLY" : "CAST APPROVE VOTE";

  return (
    <Dialog open={!!request} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-none border-nc-green/40 bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-green break-words">
            {heading} — {request.title.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {mode === "override"
              ? `Bypasses the vote and applies this to ${request.characterName} immediately.`
              : `These mechanical params are used if your vote reaches majority and approves for ${request.characterName}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {isProperty && (
            <>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Monthly Rent (€$)</Label>
                <Input
                  type="number"
                  min={0}
                  value={monthlyRent}
                  onChange={(e) => setMonthlyRent(e.target.value)}
                  placeholder="e.g. 2500"
                  className="rounded-none font-mono"
                  data-testid="input-approve-rent"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Business / Property Name</Label>
                <Input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Leave blank to keep the requested name"
                  className="rounded-none font-mono"
                  data-testid="input-approve-business-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as "residential" | "business")}>
                  <SelectTrigger className="rounded-none font-mono" data-testid="select-approve-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="residential">Residential</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {isCyberware && (
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">CWP (chrome point cost)</Label>
              <Input
                type="number"
                min={0}
                value={cwp}
                onChange={(e) => setCwp(e.target.value)}
                placeholder="e.g. 2"
                className="rounded-none font-mono"
                data-testid="input-approve-cwp"
              />
            </div>
          )}
          {isVenueStock && (
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
                  data-testid="input-approve-unit-cost"
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
                  data-testid="input-approve-retail"
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
                  data-testid="input-approve-qty"
                />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Reviewer Note (optional)</Label>
            <Input
              value={reviewerNote}
              onChange={(e) => setReviewerNote(e.target.value)}
              placeholder="Visible to the player"
              className="rounded-none font-mono"
              data-testid="input-approve-note"
            />
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:space-x-0">
          <Button
            variant="ghost"
            className="w-full rounded-none font-display sm:w-auto"
            onClick={onClose}
          >
            CANCEL
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            {mode === "override" && (
              <Button
                variant="outline"
                className="w-full rounded-none font-display tracking-widest border-destructive text-destructive hover:bg-destructive/10 sm:w-auto"
                disabled={busy}
                onClick={() => override.mutate({ id: request.id, data: { decision: "deny", reviewerNote: reviewerNote.trim() || undefined } })}
                data-testid="button-override-deny"
              >
                {busy ? "WORKING..." : "OVERRIDE & DENY"}
              </Button>
            )}
            <Button
              className="w-full rounded-none font-display tracking-widest bg-nc-green text-background hover:bg-nc-green/80 sm:w-auto"
              disabled={!valid || busy}
              onClick={submit}
              data-testid="button-confirm-approve"
            >
              {busy ? "WORKING..." : cta}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ request, onClose }: { request: CustomRequest | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reviewerNote, setReviewerNote] = useState("");

  const seedKey = request?.id ?? -1;
  const [seededFor, setSeededFor] = useState(-1);
  if (request && seededFor !== seedKey) {
    setReviewerNote("");
    setSeededFor(seedKey);
  }

  const voteReject = useVoteCustomRequest({
    mutation: {
      onSuccess: (res) => {
        // Base key (no params) so every bucket variant refetches — see onDone.
        qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey() });
        toast({
          title: (res as { decided?: string })?.decided === "rejected" ? "Request rejected — majority reached" : "Reject vote recorded",
        });
        onClose();
      },
      onError: (err) => {
        const msg =
          (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
          (err instanceof Error ? err.message : "Please try again.");
        toast({ title: "Could not vote", description: msg, variant: "destructive" });
      },
    },
  });

  if (!request) return null;

  return (
    <Dialog open={!!request} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-none border-destructive/40 bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-destructive">
            VOTE REJECT — {request.title.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            A reject majority declines this request. To send it back for edits instead, use Request Changes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Reviewer Note (optional)</Label>
          <Input
            value={reviewerNote}
            onChange={(e) => setReviewerNote(e.target.value)}
            placeholder="Reason for rejection"
            className="rounded-none font-mono"
            data-testid="input-reject-note"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" className="rounded-none font-display" onClick={onClose}>
            CANCEL
          </Button>
          <Button
            variant="outline"
            className="rounded-none font-display tracking-widest border-destructive text-destructive hover:bg-destructive/10"
            disabled={voteReject.isPending}
            onClick={() => voteReject.mutate({ id: request.id, data: { vote: "reject", note: reviewerNote.trim() || undefined } })}
            data-testid="button-confirm-reject"
          >
            {voteReject.isPending ? "VOTING..." : "CAST REJECT VOTE"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewCharactersTab() {
  // Active-only tab: resolved/closed sheets live in the cross-cutting
  // Completed/Denied tabs.
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: active, isLoading } = useListPendingSheets({ bucket: "active" });
  const { data: unseenIds } = useGetReviewUnseenIds();
  const { data: me } = useEffectiveMe();
  const unseen = new Set(unseenIds?.sheet ?? []);
  const isReviewer = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  // Only fixers / cs-approvers cast counted votes; a pure admin uses OVERRIDE.
  const canVote = !!(me?.isFixer || me?.isCsApprover);
  const isAdmin = !!me?.isAdmin;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
  };
  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

  const vote = useVoteSheet({
    mutation: {
      onSuccess: (res) => {
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
      onSuccess: () => {
        invalidate();
        toast({ title: "Sheet approved via override" });
      },
      onError: (err) =>
        toast({ title: "Override failed", description: errMsg(err, "Override failed"), variant: "destructive" }),
    },
  });
  const busy = vote.isPending || override.isPending;
  const [sortMode, setSortMode] = useState<ReviewSortMode>("updated");

  const sheets = sortReviewItems(
    (active ?? []) as PendingSheetSummary[],
    sortMode,
    (s) => s.createdAt,
    (s) => s.lastActivityAt,
  );

  if (isLoading) {
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
        date={sheet.createdAt}
        showRoster={isReviewer}
        roster={{
          eligibleReviewers: sheet.eligibleReviewers ?? [],
          voters: (sheet.voters ?? []).map((v) => ({ id: v.id, vote: v.vote })),
        }}
        markSeenOnMount={isReviewer}
        awaitingVote={canVote && sheet.status === "pending" && !my}
        tally={
          <div className="font-mono text-xs text-muted-foreground" data-testid={`tally-sheet-${sheet.id}`}>
            <span className="text-nc-green">{sheet.approveCount ?? 0}</span>/{sheet.threshold ?? "?"} approve ·{" "}
            <span className="text-destructive">{sheet.rejectCount ?? 0}</span> reject
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
                      </>
                    )}
                    {isAdmin && (
                      <Button
                        variant="outline"
                        className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                        disabled={busy}
                        onClick={() => override.mutate({ id: sheet.id, data: { decision: "approve" } })}
                        data-testid={`button-override-sheet-${sheet.id}`}
                      >
                        OVERRIDE
                      </Button>
                    )}
                  </>
                )}
                <DiscordThreadDrawer
                  subjectType="sheet"
                  subjectId={sheet.id}
                  buttonLabel="SEE THREAD"
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

function LoreEditCard({ edit }: { edit: LorePendingEdit }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: getListLoreEditsQueryKey() });

  const approve = useApproveLoreEdit({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: "Lore change approved & published" }); },
      onError: (err) => toast({ title: "Could not approve", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
    },
  });
  const reject = useRejectLoreEdit({
    mutation: {
      onSuccess: () => { invalidate(); setRejecting(false); setNote(""); toast({ title: "Lore change rejected" }); },
      onError: (err) => toast({ title: "Could not reject", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
    },
  });

  const diff = (edit.proposedDiff ?? {}) as LoreEntryUpdate;
  const before = (edit.beforeSnapshot ?? {}) as Record<string, unknown>;
  const changedKeys = Object.keys(diff).filter((k) => k in LORE_FIELD_LABELS);
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="rounded-none border-border bg-card/50 flex flex-col" data-testid={`card-lore-edit-${edit.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-mono text-[10px]">
            <BookOpen className="w-3 h-3 mr-1" /> LORE {edit.kind.toUpperCase()}
          </Badge>
          <span className="text-xs font-mono text-muted-foreground">{new Date(edit.createdAt).toLocaleDateString()}</span>
        </div>
        <CardTitle className="text-lg font-display truncate mt-2">
          {(diff.name as string) || edit.entryName || "New lore entry"}
        </CardTitle>
        <CardDescription className="font-mono text-xs">by {edit.submittedByName || edit.submittedBy}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 gap-4">
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

        {rejecting ? (
          <div className="mt-auto space-y-2 pt-3 border-t border-border/40">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (optional)"
              className="rounded-none font-mono"
              data-testid={`input-lore-reject-note-${edit.id}`}
            />
            <div className="flex gap-2">
              <Button variant="ghost" className="rounded-none flex-1 font-display text-xs" onClick={() => setRejecting(false)}>CANCEL</Button>
              <Button
                variant="outline"
                className="rounded-none flex-1 border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                disabled={busy}
                onClick={() => reject.mutate({ id: edit.id, data: { decisionSummary: note.trim() || undefined } })}
                data-testid={`button-confirm-reject-lore-${edit.id}`}
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
              data-testid={`button-approve-lore-${edit.id}`}
            >
              {approve.isPending ? "PUBLISHING..." : "APPROVE & PUBLISH"}
            </Button>
            <Button
              variant="outline"
              className="rounded-none flex-1 border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
              disabled={busy}
              onClick={() => setRejecting(true)}
              data-testid={`button-reject-lore-${edit.id}`}
            >
              REJECT
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LoreEditsTab() {
  const { data, isLoading } = useListLoreEdits({ status: "pending" });
  const edits = (data ?? []) as LorePendingEdit[];

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }
  if (edits.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No lore changes await approval.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {edits.map((e) => (
        <LoreEditCard key={e.id} edit={e} />
      ))}
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
      onError: (err) => toast({ title: "Could not approve", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
    },
  });
  const reject = useRejectGuidebookEdit({
    mutation: {
      onSuccess: () => { invalidate(); setRejecting(false); setNote(""); toast({ title: "Guidebook change rejected" }); },
      onError: (err) => toast({ title: "Could not reject", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
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
          <span className="text-xs font-mono text-muted-foreground">{new Date(edit.createdAt).toLocaleDateString()}</span>
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
  if (status === "approved") return "completed";
  if (status === "rejected" || status === "cancelled") return "denied";
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
  const canLore = !!me?.isAdmin;

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
  const loreApproved = useListLoreEdits(
    { status: "approved" },
    { query: { enabled: canLore, queryKey: getListLoreEditsQueryKey({ status: "approved" }) } },
  );
  const loreRejected = useListLoreEdits(
    { status: "rejected" },
    { query: { enabled: canLore, queryKey: getListLoreEditsQueryKey({ status: "rejected" }) } },
  );
  const guidebookApproved = useListGuidebookEdits(
    { status: "approved" },
    { query: { enabled: canLore, queryKey: getListGuidebookEditsQueryKey({ status: "approved" }) } },
  );
  const guidebookRejected = useListGuidebookEdits(
    { status: "rejected" },
    { query: { enabled: canLore, queryKey: getListGuidebookEditsQueryKey({ status: "rejected" }) } },
  );

  const isLoading =
    reqResolved.isLoading || reqArchive.isLoading ||
    editResolved.isLoading || editArchive.isLoading ||
    sheetResolved.isLoading || sheetArchive.isLoading ||
    loreApproved.isLoading || loreRejected.isLoading ||
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
  const requestsById = new Map<number, CustomRequest>();
  for (const r of requests) requestsById.set(r.id, r);
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

  const loreToItem = (l: LorePendingEdit, decision: TerminalDecision): TerminalItem => {
    const diff = (l.proposedDiff ?? {}) as Record<string, unknown>;
    return {
      key: `lore-${l.id}`,
      kind: "lore",
      subjectType: null,
      id: l.id,
      title: (diff.name as string) || l.entryName || "Lore entry",
      subtitle: `by ${l.submittedByName || l.submittedBy}`,
      date: (l as { decidedAt?: string | null }).decidedAt || l.createdAt,
      status: decision === "completed" ? "approved" : "rejected",
      note: (l as { decisionSummary?: string | null }).decisionSummary ?? null,
      archived: false,
      badgeLabel: "LORE",
      Icon: BookOpen,
    };
  };
  for (const l of (loreApproved.data ?? []) as LorePendingEdit[]) completed.push(loreToItem(l, "completed"));
  for (const l of (loreRejected.data ?? []) as LorePendingEdit[]) denied.push(loreToItem(l, "denied"));

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

  return { completed, denied, readyToApply, requestsById, isLoading };
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
          <span className="text-xs font-mono text-muted-foreground">{new Date(item.date).toLocaleDateString()}</span>
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

// Pinned panel surfacing every approved-but-not-yet-applied ticket so staff can
// finalize them in place (per-item CLOSE & APPLY) or clear them all at once
// (APPLY ALL), without switching to the Completed tab. Applying still routes
// through the same idempotent close endpoint that materializes staged effects.
function ReadyToApplyPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useEffectiveMe();
  const isAdmin = !!me?.isAdmin;
  const { readyToApply, requestsById } = useTerminalItems();
  const [applyingAll, setApplyingAll] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [editRequest, setEditRequest] = useState<CustomRequest | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
  };

  const close = useCloseReviewTicket({
    mutation: {
      onError: (err) => {
        const msg =
          (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
          (err instanceof Error ? err.message : "Please try again.");
        toast({ title: "Could not apply", description: msg, variant: "destructive" });
      },
    },
  });

  if (readyToApply.length === 0) return null;
  const busy = applyingAll || applyingId !== null;

  const applyOne = async (item: TerminalItem) => {
    if (!item.subjectType) return;
    setApplyingId(item.key);
    try {
      await close.mutateAsync({ subjectType: item.subjectType, id: item.id });
      invalidate();
      toast({ title: `Applied "${item.title}"` });
    } catch {
      /* error toast handled by mutation onError */
    } finally {
      setApplyingId(null);
    }
  };

  const applyAll = async () => {
    setApplyingAll(true);
    let ok = 0;
    let failed = 0;
    // Sequential so a mid-batch failure doesn't fire a flood of parallel
    // requests; each close is independently idempotent.
    for (const item of readyToApply) {
      if (!item.subjectType) continue;
      try {
        await close.mutateAsync({ subjectType: item.subjectType, id: item.id });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    invalidate();
    setApplyingAll(false);
    toast({
      title: `Applied ${ok} approved request${ok === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`,
      variant: failed ? "destructive" : undefined,
    });
  };

  return (
    <Card className="rounded-none border-nc-yellow/60 bg-nc-yellow/5" data-testid="panel-ready-to-apply">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg font-display tracking-widest text-nc-yellow">
              READY TO APPLY ({readyToApply.length})
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Approved — finalize to create the lease / item / character.
            </CardDescription>
          </div>
          <Button
            className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display text-xs tracking-widest"
            disabled={busy}
            onClick={applyAll}
            data-testid="button-apply-all-approved"
          >
            {applyingAll ? "APPLYING..." : `APPLY ALL (${readyToApply.length})`}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {readyToApply.map((item) => {
            const Icon = item.Icon;
            // Only request tickets carry editable mechanical params (rent / CWP /
            // stock pricing). An admin can correct a bad staged value in place by
            // re-overriding before the ticket is closed/applied.
            const req = item.subjectType === "request" ? requestsById.get(item.id) : undefined;
            const canEdit =
              isAdmin && !!req &&
              (req.type === "property" || req.type === "cyberware" || req.type === "venue_stock");
            return (
              <div
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-3 border border-border/60 bg-card/60 px-3 py-2"
                data-testid={`row-ready-${item.kind}-${item.id}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-mono text-[10px] shrink-0">
                    <Icon className="w-3 h-3 mr-1" /> {item.badgeLabel}
                  </Badge>
                  <div className="min-w-0">
                    <div className="font-display text-sm truncate">{item.title}</div>
                    <div className="font-mono text-[11px] text-muted-foreground truncate">{item.subtitle}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canEdit && (
                    <Button
                      variant="outline"
                      className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
                      disabled={busy}
                      onClick={() => setEditRequest(req!)}
                      data-testid={`button-edit-ready-${item.kind}-${item.id}`}
                    >
                      EDIT
                    </Button>
                  )}
                  <Button
                    className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs tracking-widest"
                    disabled={busy}
                    onClick={() => applyOne(item)}
                    data-testid={`button-apply-ready-${item.kind}-${item.id}`}
                  >
                    {applyingId === item.key ? "APPLYING..." : "CLOSE & APPLY"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
      <ApproveDialog request={editRequest} mode="override" onClose={() => setEditRequest(null)} />
    </Card>
  );
}

export default function PendingRequests() {
  const { data: me } = useEffectiveMe();
  // The custom-request reviewer pool is generic (fixer / cs-approver / admin),
  // matching the server's isEligibleReviewer, so CS-Approvers can vote on misc
  // requests and must see the tab + badges (they were previously hidden).
  const canMisc = !!(me?.isAdmin || me?.isFixer || me?.isCsApprover);
  // Archivists also reach the Misc tab to approve mission proposals.
  const canSeeMisc = canMisc || !!me?.isArchivist;
  // Fixers are sheet reviewers too (see NewCharactersTab.isReviewer/canVote and
  // the sidebar badge, which counts unseen sheets for fixers), so they must see
  // the Sheets tab — otherwise the badge sends them here to a tab that's hidden.
  const canNewChars = !!(me?.isAdmin || me?.isCsApprover || me?.isFixer);
  const canLore = !!me?.isAdmin;
  // The terminal (Completed/Denied) tabs aggregate reviewer queues; only show
  // them to staff who can see at least one of those queues.
  const isReviewer = canSeeMisc || canNewChars || canLore;

  // Per-tab badges show UNSEEN-by-me counts (drop once the reviewer opens an
  // item), not the raw pending totals. Lore is the exception — it's a single-
  // approver admin queue with no seen-tracking, so it keeps the pending count.
  const { data: unseen } = useGetReviewUnseenCounts();
  const { data: loreData } = useListLoreEdits(
    { status: "pending" },
    { query: { enabled: canLore, queryKey: getListLoreEditsQueryKey({ status: "pending" }) } },
  );
  const { data: guidebookData } = useListGuidebookEdits(
    { status: "pending" },
    { query: { enabled: canLore, queryKey: getListGuidebookEditsQueryKey({ status: "pending" }) } },
  );
  const miscCount = unseen?.requests ?? 0;
  const editsCount = unseen?.edits ?? 0;
  const sheetsCount = unseen?.sheets ?? 0;
  const loreCount = (loreData ?? []).length;
  const guidebookCount = (guidebookData ?? []).length;

  // Land on the first tab that actually has unseen items, so a reviewer arriving
  // from the sidebar "Pending Requests" badge isn't dropped on an empty MISC tab
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
            : canLore && guidebookCount > 0
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
  if (canLore) { visibleTabs.add("lore"); visibleTabs.add("guidebook"); }
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
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const tab = activeTab ?? initialUrlTab ?? focusTab ?? computedTab;

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-pending-requests-title"
        >
          <Clock className="w-8 h-8 text-nc-yellow" /> PENDING REQUESTS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">Review player submissions across the server.</p>
      </div>

      {isReviewer && (
        <ErrorBoundary><ReadyToApplyPanel /></ErrorBoundary>
      )}

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
          {canLore && (
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
        {canLore && (
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
