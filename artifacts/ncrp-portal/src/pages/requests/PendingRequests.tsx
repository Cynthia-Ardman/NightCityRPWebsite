import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useListCustomRequests,
  useVoteCustomRequest,
  useOverrideCustomRequest,
  useListPendingSheets,
  useListLoreEdits,
  useApproveLoreEdit,
  useRejectLoreEdit,
  useGetReviewUnseenCounts,
  useGetReviewUnseenIds,
  getGetReviewUnseenIdsQueryKey,
  getListCustomRequestsQueryKey,
  getListPendingSheetsQueryKey,
  getListLoreEditsQueryKey,
  type CustomRequest,
  type LorePendingEdit,
  type LoreEntryUpdate,
} from "@workspace/api-client-react";
import { type LifecycleBucket } from "@/lib/reviewLifecycle";
import { UnseenDot, useReviewTicketActions, LifecycleActions, BucketSection } from "@/components/review/ReviewLifecycleUI";
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
import { Clock, FileText, Inbox, Home, Crosshair, Cpu, Store, Syringe, BookOpen, PackagePlus, MessageSquare, ChevronDown, ChevronUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthMe } from "@/hooks/useAuthMe";
import PendingEditsList from "@/pages/pending-edits/PendingEditsList";
import ReviewCommentThread, { AwaitingVoteBanner } from "@/components/ReviewCommentThread";

const TYPE_META: Record<
  CustomRequest["type"],
  { label: string; Icon: typeof Home }
> = {
  property: { label: "PROPERTY", Icon: Home },
  gun: { label: "GUN", Icon: Crosshair },
  cyberware: { label: "CYBERWARE", Icon: Cpu },
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
};

// Venue requests stash purpose/location in the details payload — surface them
// in the review card so staff can act without opening anything else.
function venueDetails(r: CustomRequest): { purpose?: string; location?: string } | null {
  if (r.type !== "store" && r.type !== "ripperdoc") return null;
  const d = r.details;
  if (!d || typeof d !== "object") return null;
  return d as { purpose?: string; location?: string };
}

function MiscRequestsTab() {
  const qc = useQueryClient();
  const { data: active, isLoading: loadingActive } = useListCustomRequests({ bucket: "active" });
  const { data: resolved, isLoading: loadingResolved } = useListCustomRequests({ bucket: "resolved" });
  const { data: archive, isLoading: loadingArchive } = useListCustomRequests({ bucket: "archive" });
  const { data: unseenIds } = useGetReviewUnseenIds();
  const { data: me } = useAuthMe();
  const [approveTarget, setApproveTarget] = useState<CustomRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CustomRequest | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<CustomRequest | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const isReviewer = !!(me?.isFixer || me?.isCsApprover || me?.isAdmin);
  const isAdmin = !!me?.isAdmin;
  const isLoading = loadingActive || loadingResolved || loadingArchive;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
  };
  const actions = useReviewTicketActions(invalidate);
  const unseen = new Set(unseenIds?.request ?? []);

  const buckets: Record<LifecycleBucket, CustomRequest[]> = {
    active: (active ?? []) as CustomRequest[],
    resolved: (resolved ?? []) as CustomRequest[],
    archive: (archive ?? []) as CustomRequest[],
  };

  const renderCard = (r: CustomRequest, bucket: LifecycleBucket) => {
        const meta = TYPE_META[r.type];
        const Icon = meta.Icon;
        return (
          <Card
            key={r.id}
            className="rounded-none border-border bg-card/50 flex flex-col"
            data-testid={`card-misc-request-${r.id}`}
          >
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <UnseenDot show={unseen.has(r.id)} testid={`dot-unseen-request-${r.id}`} />
                  <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-mono text-[10px]">
                    <Icon className="w-3 h-3 mr-1" /> {meta.label}
                  </Badge>
                </div>
                <span className="text-xs font-mono text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>
              <CardTitle className="text-lg font-display truncate mt-2">{r.title}</CardTitle>
              <CardDescription className="font-mono text-xs">
                {r.characterName} · by {r.requestedByName || r.requestedById}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col flex-1 gap-4">
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
              {(() => {
                const det = venueDetails(r);
                if (!det) return null;
                return (
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
                );
              })()}
              {r.description ? (
                <p className="font-mono text-sm text-muted-foreground whitespace-pre-wrap">{r.description}</p>
              ) : (
                <p className="font-mono text-sm text-muted-foreground italic">No description provided.</p>
              )}
              <div className="mt-auto pt-3 border-t border-border/40 space-y-3">
                {bucket === "active" ? (
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
                    {r.reviewerNote ? (
                      <span className="block italic mt-0.5">"{r.reviewerNote}"</span>
                    ) : null}
                  </div>
                )}
                {isReviewer && bucket === "active" && r.status === "pending" && (
                  <div className="flex flex-wrap gap-2">
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
                  </div>
                )}
                {isReviewer && bucket === "resolved" && (
                  <LifecycleActions subjectType="request" id={r.id} status={r.status} actions={actions} />
                )}
                <Button
                  variant="outline"
                  className="w-full rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
                  onClick={() => setExpanded((cur) => (cur === r.id ? null : r.id))}
                  data-testid={`button-view-respond-misc-${r.id}`}
                >
                  <MessageSquare className="w-3 h-3 mr-1" />
                  VIEW &amp; RESPOND
                  {expanded === r.id ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
                </Button>
                {expanded === r.id && (
                  <div className="space-y-3">
                    <AwaitingVoteBanner show={isReviewer && bucket === "active" && r.status === "pending" && !r.myVote} />
                    <ReviewCommentThread subjectType="request" subjectId={r.id} markSeenOnMount={isReviewer} />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
  };

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }

  const total = buckets.active.length + buckets.resolved.length + buckets.archive.length;
  if (total === 0) {
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
      {(["active", "resolved", "archive"] as const).map((b) => (
        <BucketSection key={b} bucket={b} count={buckets[b].length}>
          {buckets[b].map((r) => renderCard(r, b))}
        </BucketSection>
      ))}

      <ApproveDialog request={approveTarget} mode="vote" onClose={() => setApproveTarget(null)} />
      <ApproveDialog request={overrideTarget} mode="override" onClose={() => setOverrideTarget(null)} />
      <RejectDialog request={rejectTarget} onClose={() => setRejectTarget(null)} />
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
    setCwp("");
    setUnitCost("");
    setRetail("");
    setQty("1");
    setSeededFor(seedKey);
  }

  const onDone = (title: string) => {
    qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey({ status: "pending" }) });
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
      onSuccess: () => onDone("Request approved via override"),
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
      ...(isProperty ? { monthlyRent: rentNum, kind } : {}),
      ...(isCyberware ? { cwp: cwpNum } : {}),
      ...(isVenueStock ? { unitCost: unitCostNum, retail: retailNum, qty: qtyNum } : {}),
    };
    if (mode === "override") {
      override.mutate({ id: request.id, data: { reviewerNote: reviewerNote.trim() || undefined, ...params } });
    } else {
      voteApprove.mutate({ id: request.id, data: { vote: "approve", note: reviewerNote.trim() || undefined, ...params } });
    }
  };

  const heading = mode === "override" ? "OVERRIDE" : "VOTE APPROVE";
  const cta = mode === "override" ? "OVERRIDE & APPLY" : "CAST APPROVE VOTE";

  return (
    <Dialog open={!!request} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-none border-nc-green/40 bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-green">
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
        <DialogFooter>
          <Button variant="ghost" className="rounded-none font-display" onClick={onClose}>
            CANCEL
          </Button>
          <Button
            className="rounded-none font-display tracking-widest bg-nc-green text-background hover:bg-nc-green/80"
            disabled={!valid || busy}
            onClick={submit}
            data-testid="button-confirm-approve"
          >
            {busy ? "WORKING..." : cta}
          </Button>
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
        qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey({ status: "pending" }) });
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
  const qc = useQueryClient();
  const { data: active, isLoading: loadingActive } = useListPendingSheets({ bucket: "active" });
  const { data: resolved, isLoading: loadingResolved } = useListPendingSheets({ bucket: "resolved" });
  const { data: archive, isLoading: loadingArchive } = useListPendingSheets({ bucket: "archive" });
  const { data: unseenIds } = useGetReviewUnseenIds();
  const isLoading = loadingActive || loadingResolved || loadingArchive;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
  };
  const actions = useReviewTicketActions(invalidate);
  const unseen = new Set(unseenIds?.sheet ?? []);

  const buckets: Record<LifecycleBucket, any[]> = {
    active: active ?? [],
    resolved: resolved ?? [],
    archive: archive ?? [],
  };

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }

  const total = buckets.active.length + buckets.resolved.length + buckets.archive.length;
  if (total === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No pending sheets require attention.</p>
      </div>
    );
  }

  const renderCard = (sheet: any, bucket: LifecycleBucket) => (
    <Card
      key={sheet.id}
      className="rounded-none border-border bg-card/50 flex flex-col h-full"
      data-testid={`card-pending-sheet-${sheet.id}`}
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <UnseenDot show={unseen.has(sheet.id)} testid={`dot-unseen-sheet-${sheet.id}`} />
          <CardTitle className="text-xl font-display truncate">{sheet.name}</CardTitle>
        </div>
        <CardDescription className="font-mono text-xs">By {sheet.ownerName || sheet.ownerId}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto flex flex-col gap-3 border-t border-border/50 pt-4">
        <div className="flex justify-between items-center">
          <div className="text-xs font-mono text-muted-foreground">
            {new Date(sheet.createdAt).toLocaleDateString()}
          </div>
          {bucket === "active" ? (
            <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none animate-pulse">
              REVIEW REQ
            </Badge>
          ) : (
            <Badge variant="outline" className="border-border text-muted-foreground rounded-none uppercase" data-testid={`status-sheet-${sheet.id}`}>
              {String(sheet.status).replace("_", " ")}
            </Badge>
          )}
        </div>
        <Link href={`/sheets/${sheet.id}`}>
          <Button
            variant="outline"
            className="w-full rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display text-xs tracking-widest"
            data-testid={`button-open-sheet-${sheet.id}`}
          >
            OPEN SHEET
          </Button>
        </Link>
        {bucket === "resolved" && (
          <LifecycleActions subjectType="sheet" id={sheet.id} status={String(sheet.status)} actions={actions} />
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-8">
      {(["active", "resolved", "archive"] as const).map((b) => (
        <BucketSection key={b} bucket={b} count={buckets[b].length}>
          {buckets[b].map((sheet) => renderCard(sheet, b))}
        </BucketSection>
      ))}
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
                {edit.kind === "edit" && (
                  <div className="text-muted-foreground line-through whitespace-pre-wrap break-words">{fmtLoreValue(before[k])}</div>
                )}
                <div className="text-foreground whitespace-pre-wrap break-words">{fmtLoreValue((diff as Record<string, unknown>)[k])}</div>
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
  const { data: me } = useAuthMe();
  const canMisc = !!(me?.isAdmin || me?.isFixer);
  const canNewChars = !!(me?.isAdmin || me?.isCsApprover);
  const canLore = !!me?.isAdmin;

  // Per-tab badges show UNSEEN-by-me counts (drop once the reviewer opens an
  // item), not the raw pending totals. Lore is the exception — it's a single-
  // approver admin queue with no seen-tracking, so it keeps the pending count.
  const { data: unseen } = useGetReviewUnseenCounts();
  const { data: loreData } = useListLoreEdits(
    { status: "pending" },
    { query: { enabled: canLore, queryKey: getListLoreEditsQueryKey({ status: "pending" }) } },
  );
  const miscCount = unseen?.requests ?? 0;
  const editsCount = unseen?.edits ?? 0;
  const sheetsCount = unseen?.sheets ?? 0;
  const loreCount = (loreData ?? []).length;

  // Default to the first tab the staffer can act on.
  const defaultTab = canMisc ? "misc" : "edits";

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-pending-requests-title"
        >
          <Clock className="w-8 h-8 text-nc-yellow" /> PENDING REQUESTS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">Review player submissions across the server.</p>
      </div>

      <Tabs defaultValue={defaultTab}>
        <TabsList className="rounded-none bg-card/60 border border-border p-1 flex flex-wrap h-auto justify-start gap-1">
          {canMisc && (
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
        </TabsList>

        {canMisc && (
          <TabsContent value="misc" className="mt-6">
            <MiscRequestsTab />
          </TabsContent>
        )}
        <TabsContent value="edits" className="mt-6">
          <PendingEditsList embedded />
        </TabsContent>
        {canNewChars && (
          <TabsContent value="sheets" className="mt-6">
            <NewCharactersTab />
          </TabsContent>
        )}
        {canLore && (
          <TabsContent value="lore" className="mt-6">
            <LoreEditsTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
