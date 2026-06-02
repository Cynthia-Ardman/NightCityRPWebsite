import { Fragment, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useListMyCustomRequests,
  useListMyHousingRequests,
  useListMySheets,
  useListPendingEdits,
  useDecideStockCostRequest,
  useDecideEmployeeInvite,
  useDecideMissionParticipation,
  useUpdateCustomRequest,
  useResubmitCustomRequest,
  useGetMyUnseen,
  getListMyCustomRequestsQueryKey,
  getGetMyUnseenQueryKey,
  type CustomRequest,
  type HousingRequest,
  type CharacterSheet,
  type PendingEditSummary,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { statusBucket, BUCKET_LABEL, type LifecycleBucket } from "@/lib/reviewLifecycle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";
import { ClipboardList, RotateCcw, Pencil, MessageSquare, ChevronDown, ChevronUp } from "lucide-react";
import ReviewCommentThread from "@/components/ReviewCommentThread";

// One unified shape for everything a player has submitted, so custom
// requests (property / gun / cyberware) and standard catalog leases can
// share a single chronological history table.
type HistoryRow = {
  key: string;
  category:
    | "Character"
    | "Character Edit"
    | "Property"
    | "Gun"
    | "Cyberware"
    | "Store"
    | "Ripperdoc"
    | "Stock"
    | "Venue Stock"
    | "Employment"
    | "Mission"
    | "Lease";
  title: string;
  characterName: string;
  status: string;
  createdAt: string;
  reviewedAt?: string | null;
  reviewerNote?: string | null;
  description?: string | null;
  // Set for custom requests the owner can act on directly (stock-cost).
  customId?: number;
  customType?: CustomRequest["type"];
  // Review-subject identity for the discussion thread + unread dots. Housing
  // leases aren't part of the review pipeline, so they leave these unset.
  subjectType?: "request" | "edit" | "sheet";
  subjectId?: number;
  // Set for character sheets / edits: where the player goes to read the
  // reviewer's note and resubmit. Inline resubmit isn't possible for these
  // (they have full forms / diffs), so we link to their detail page.
  respondTo?: string;
  // Employment-invite terms surfaced so the invitee can verify before accepting.
  inviteRole?: string | null;
  inviteCommissionPct?: number | null;
  inviteVenueName?: string | null;
  // Fixer vote tally for custom requests that run through the staff multi-vote
  // pipeline. Only shown for fixer-voted types — owner/player-decided types
  // tally 0/0, which would be misleading.
  approveCount?: number | null;
  rejectCount?: number | null;
  voteThreshold?: number | null;
};

// Custom-request types whose approval runs through the fixer multi-vote
// pipeline. stock_cost / employee_invite / mission_participation are decided by
// the owner or invited player (no fixer votes), so we never show a tally there.
const FIXER_VOTED_TYPES = new Set<CustomRequest["type"]>([
  "property",
  "gun",
  "cyberware",
  "store",
  "ripperdoc",
  "venue_stock",
]);

const CUSTOM_LABEL: Record<CustomRequest["type"], HistoryRow["category"]> = {
  property: "Property",
  gun: "Gun",
  cyberware: "Cyberware",
  store: "Store",
  ripperdoc: "Ripperdoc",
  stock_cost: "Stock",
  venue_stock: "Venue Stock",
  employee_invite: "Employment",
  mission_participation: "Mission",
};

const CATEGORY_FILTERS: Array<HistoryRow["category"] | "All"> = [
  "All",
  "Character",
  "Character Edit",
  "Property",
  "Gun",
  "Cyberware",
  "Store",
  "Ripperdoc",
  "Stock",
  "Venue Stock",
  "Employment",
  "Mission",
  "Lease",
];

function categoryColor(category: HistoryRow["category"]): string {
  switch (category) {
    case "Character":
      return "text-nc-green";
    case "Character Edit":
      return "text-nc-cyan";
    case "Property":
      return "text-nc-cyan";
    case "Gun":
      return "text-nc-magenta";
    case "Cyberware":
      return "text-nc-yellow";
    case "Store":
      return "text-nc-cyan";
    case "Ripperdoc":
      return "text-nc-magenta";
    case "Stock":
      return "text-nc-yellow";
    case "Venue Stock":
      return "text-nc-yellow";
    case "Employment":
      return "text-nc-green";
    case "Mission":
      return "text-nc-cyan";
    case "Lease":
      return "text-nc-green";
  }
}

export default function MyRequests() {
  const { data: me } = useAuthMe();
  const { data: custom, isLoading: loadingCustom } = useListMyCustomRequests();
  const { data: housing, isLoading: loadingHousing } = useListMyHousingRequests();
  const { data: sheets, isLoading: loadingSheets } = useListMySheets();
  const { data: edits, isLoading: loadingEdits } = useListPendingEdits();
  const [, navigate] = useLocation();
  const [category, setCategory] = useState<HistoryRow["category"] | "All">("All");
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ id: number; title: string; description: string } | null>(null);
  const [discussing, setDiscussing] = useState<string | null>(null);
  // Per-queue ids of the player's own submissions with unseen activity. Drives
  // the per-row unread dot; opening a row's discussion clears it server-side.
  const { data: myUnseen } = useGetMyUnseen({ query: { enabled: !!me, queryKey: getGetMyUnseenQueryKey() } });
  const unseenKeys = useMemo(() => {
    const s = new Set<string>();
    for (const id of myUnseen?.request ?? []) s.add(`request-${id}`);
    for (const id of myUnseen?.edit ?? []) s.add(`edit-${id}`);
    for (const id of myUnseen?.sheet ?? []) s.add(`sheet-${id}`);
    return s;
  }, [myUnseen]);
  const isUnseen = (r: HistoryRow) => !!r.subjectType && r.subjectId != null && unseenKeys.has(`${r.subjectType}-${r.subjectId}`);
  const invalidateMine = () => {
    qc.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyUnseenQueryKey() });
  };
  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? fallback;
  const decide = useDecideStockCostRequest({
    mutation: {
      onSuccess: () => invalidateMine(),
    },
  });
  const decideInvite = useDecideEmployeeInvite({
    mutation: {
      onSuccess: (_res, variables) => {
        invalidateMine();
        toast({
          title:
            variables.data.decision === "accept"
              ? "Invitation accepted — you're hired"
              : "Invitation declined",
        });
      },
      onError: (err) => toast({ title: "Could not respond", description: errMsg(err, "Please try again."), variant: "destructive" }),
    },
  });
  const decideParticipation = useDecideMissionParticipation({
    mutation: {
      onSuccess: (_res, variables) => {
        invalidateMine();
        toast({
          title:
            variables.data.decision === "accept"
              ? "Participation confirmed"
              : "Assignment declined",
        });
      },
      onError: (err) => toast({ title: "Could not respond", description: errMsg(err, "Please try again."), variant: "destructive" }),
    },
  });
  const update = useUpdateCustomRequest();
  const resubmit = useResubmitCustomRequest({
    mutation: {
      onSuccess: () => { toast({ title: "Resubmitted for review" }); invalidateMine(); },
      onError: (err) => toast({ title: "Resubmit failed", description: errMsg(err, "Resubmit failed"), variant: "destructive" }),
    },
  });

  // Edit (if changed) then resubmit. Resubmit is allowed even with no edits.
  const saveAndResubmit = async () => {
    if (!editing) return;
    try {
      await update.mutateAsync({ id: editing.id, data: { title: editing.title, description: editing.description } });
      await resubmit.mutateAsync({ id: editing.id });
      setEditing(null);
    } catch (err) {
      toast({ title: "Could not resubmit", description: errMsg(err, "Save failed"), variant: "destructive" });
    }
  };

  const rows = useMemo<HistoryRow[]>(() => {
    const out: HistoryRow[] = [];
    for (const r of (custom ?? []) as CustomRequest[]) {
      const det = (r.details ?? {}) as {
        role?: string | null;
        commissionPct?: number | null;
        venueName?: string | null;
      };
      out.push({
        key: `custom-${r.id}`,
        category: CUSTOM_LABEL[r.type] ?? "Property",
        title: r.title,
        characterName: r.characterName,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        reviewerNote: r.reviewerNote,
        description: r.description,
        customId: r.id,
        customType: r.type,
        subjectType: "request",
        subjectId: r.id,
        inviteRole: r.type === "employee_invite" ? det.role ?? null : null,
        inviteCommissionPct: r.type === "employee_invite" ? det.commissionPct ?? null : null,
        inviteVenueName: r.type === "employee_invite" ? det.venueName ?? null : null,
        approveCount: r.approveCount,
        rejectCount: r.rejectCount,
        voteThreshold: r.threshold,
      });
    }
    for (const r of (housing ?? []) as HousingRequest[]) {
      out.push({
        key: `housing-${r.id}`,
        category: "Lease",
        title: r.listingName,
        characterName: r.characterName,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        reviewerNote: r.reviewerNote,
      });
    }
    // New character submissions. /sheets is owner-scoped, so every row is the
    // player's own. Drafts aren't submitted requests yet, so skip them.
    for (const s of (sheets ?? []) as CharacterSheet[]) {
      if (s.status === "draft") continue;
      out.push({
        key: `sheet-${s.id}`,
        category: "Character",
        title: s.name,
        characterName: s.name,
        status: s.status,
        createdAt: s.createdAt,
        reviewedAt: s.decidedAt,
        reviewerNote: s.decisionNote,
        subjectType: "sheet",
        subjectId: s.id,
        respondTo: `/sheets/${s.id}`,
      });
    }
    // Edits to an existing character. /pending-edits returns ALL rows for
    // staff, so keep only the ones this player actually submitted.
    for (const e of (edits ?? []) as PendingEditSummary[]) {
      if (me && e.submittedBy !== me.id) continue;
      out.push({
        key: `edit-${e.id}`,
        category: "Character Edit",
        title: e.updateNote?.trim() ? e.updateNote : `Edit to ${e.characterName}`,
        characterName: e.characterName,
        status: e.status,
        createdAt: e.submittedAt,
        reviewedAt: e.decidedAt,
        reviewerNote: e.reviewComment,
        subjectType: "edit",
        subjectId: e.id,
        respondTo: `/pending-edits/${e.id}`,
      });
    }
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return out;
  }, [custom, housing, sheets, edits, me]);

  const visible = category === "All" ? rows : rows.filter((r) => r.category === category);
  const buckets = useMemo(() => {
    const b: Record<LifecycleBucket, HistoryRow[]> = { active: [], resolved: [], archive: [] };
    for (const r of visible) b[statusBucket(r.status)].push(r);
    return b;
  }, [visible]);
  const isLoading = loadingCustom || loadingHousing || loadingSheets || loadingEdits;

  const renderRow = (r: HistoryRow) => (
    <Fragment key={r.key}>
      <tr
        className="border-b border-border/30 hover:bg-card/80 align-top"
        data-testid={`row-my-request-${r.key}`}
      >
        <td className={`p-3 font-bold whitespace-nowrap ${categoryColor(r.category)}`}>
          <span className="inline-flex items-center gap-2">
            {isUnseen(r) ? (
              <span
                className="w-2 h-2 rounded-full bg-nc-magenta shadow-[0_0_6px_rgba(255,0,128,0.8)] shrink-0"
                title="New activity"
                data-testid={`dot-unseen-${r.key}`}
              />
            ) : null}
            {r.category.toUpperCase()}
          </span>
        </td>
        <td className="p-3">
          <div className="text-foreground">{r.title}</div>
          {r.customType && FIXER_VOTED_TYPES.has(r.customType) && r.approveCount != null ? (
            <div className="text-[11px] text-muted-foreground mt-0.5" data-testid={`votes-${r.key}`}>
              Votes: <span className="text-nc-green">{r.approveCount}</span>/{r.voteThreshold ?? "?"} approve
              {r.rejectCount ? (
                <> · <span className="text-destructive">{r.rejectCount}</span> reject</>
              ) : null}
            </div>
          ) : null}
          {r.customType === "stock_cost" && r.description ? (
            <div className="text-[11px] text-muted-foreground mt-0.5">{r.description}</div>
          ) : null}
          {r.customType === "employee_invite" ? (
            <div className="text-[11px] text-muted-foreground mt-0.5" data-testid={`invite-terms-${r.customId}`}>
              {r.inviteVenueName ?? "Venue"} · {r.inviteRole ?? "employee"}
              {r.inviteCommissionPct != null ? ` · ${r.inviteCommissionPct}% commission` : ""}
            </div>
          ) : null}
          {r.reviewerNote ? (
            <div className="text-[11px] text-muted-foreground italic mt-0.5">
              "{r.reviewerNote}"
            </div>
          ) : null}
        </td>
        <td className="p-3 text-muted-foreground whitespace-nowrap">{r.characterName}</td>
        <td className="p-3 text-muted-foreground whitespace-nowrap">
          {new Date(r.createdAt).toLocaleDateString()}
        </td>
        <td className="p-3 text-muted-foreground whitespace-nowrap">
          {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : "—"}
        </td>
        <td className="p-3">
          <RequestStatusBadge status={r.status} />
          {r.status === "changes_requested" && r.customId != null && r.customType !== "stock_cost" ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                className="rounded-none bg-nc-cyan text-background font-display text-[10px] tracking-widest"
                onClick={() => setEditing({ id: r.customId!, title: r.title, description: r.description ?? "" })}
                data-testid={`button-edit-resubmit-${r.customId}`}
              >
                <Pencil className="w-3 h-3 mr-1" /> EDIT & RESUBMIT
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={resubmit.isPending}
                className="rounded-none border-nc-cyan text-nc-cyan font-display text-[10px] tracking-widest"
                onClick={() => resubmit.mutate({ id: r.customId! })}
                data-testid={`button-resubmit-${r.customId}`}
              >
                <RotateCcw className="w-3 h-3 mr-1" /> RESUBMIT
              </Button>
            </div>
          ) : null}
          {r.respondTo && r.status === "changes_requested" ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                className="rounded-none bg-nc-cyan text-background font-display text-[10px] tracking-widest"
                onClick={() => navigate(r.respondTo!)}
                data-testid={`button-respond-${r.key}`}
              >
                <Pencil className="w-3 h-3 mr-1" /> VIEW &amp; RESPOND
              </Button>
            </div>
          ) : null}
          {r.customType === "stock_cost" && r.status === "pending" && r.customId != null ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                disabled={decide.isPending}
                className="rounded-none bg-nc-green text-background font-display text-[10px] tracking-widest"
                onClick={() => decide.mutate({ id: r.customId!, data: { decision: "approve" } })}
                data-testid={`button-stock-approve-${r.customId}`}
              >
                APPROVE
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                className="rounded-none border-destructive text-destructive font-display text-[10px] tracking-widest"
                onClick={() => decide.mutate({ id: r.customId!, data: { decision: "reject" } })}
                data-testid={`button-stock-reject-${r.customId}`}
              >
                REJECT
              </Button>
            </div>
          ) : null}
          {r.customType === "employee_invite" && r.status === "pending" && r.customId != null ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                disabled={decideInvite.isPending}
                className="rounded-none bg-nc-green text-background font-display text-[10px] tracking-widest"
                onClick={() => decideInvite.mutate({ id: r.customId!, data: { decision: "accept" } })}
                data-testid={`button-invite-accept-${r.customId}`}
              >
                ACCEPT
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={decideInvite.isPending}
                className="rounded-none border-destructive text-destructive font-display text-[10px] tracking-widest"
                onClick={() => decideInvite.mutate({ id: r.customId!, data: { decision: "deny" } })}
                data-testid={`button-invite-deny-${r.customId}`}
              >
                DENY
              </Button>
            </div>
          ) : null}
          {r.customType === "mission_participation" && r.status === "pending" && r.customId != null ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                disabled={decideParticipation.isPending}
                className="rounded-none bg-nc-green text-background font-display text-[10px] tracking-widest"
                onClick={() => decideParticipation.mutate({ id: r.customId!, data: { decision: "accept" } })}
                data-testid={`button-participation-accept-${r.customId}`}
              >
                ACCEPT
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={decideParticipation.isPending}
                className="rounded-none border-destructive text-destructive font-display text-[10px] tracking-widest"
                onClick={() => decideParticipation.mutate({ id: r.customId!, data: { decision: "deny" } })}
                data-testid={`button-participation-deny-${r.customId}`}
              >
                DECLINE
              </Button>
            </div>
          ) : null}
          {r.subjectType && r.subjectId != null ? (
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-none border-nc-cyan text-nc-cyan font-display text-[10px] tracking-widest"
                onClick={() => setDiscussing((cur) => (cur === r.key ? null : r.key))}
                data-testid={`button-discuss-${r.key}`}
              >
                <MessageSquare className="w-3 h-3 mr-1" /> DETAILS
                {discussing === r.key ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
              </Button>
            </div>
          ) : null}
        </td>
      </tr>
      {r.subjectType && r.subjectId != null && discussing === r.key ? (
        <tr className="border-b border-border/30" data-testid={`row-discuss-${r.key}`}>
          <td colSpan={6} className="p-3 bg-card/40">
            <div className="space-y-3">
              {r.description || (r.customType && FIXER_VOTED_TYPES.has(r.customType) && r.approveCount != null) ? (
                <div
                  className="font-mono text-xs text-muted-foreground space-y-1 border border-border/40 bg-background/40 p-3"
                  data-testid={`details-${r.key}`}
                >
                  {r.description ? <p className="whitespace-pre-wrap text-foreground">{r.description}</p> : null}
                  {r.customType && FIXER_VOTED_TYPES.has(r.customType) && r.approveCount != null ? (
                    <div>
                      Votes: <span className="text-nc-green">{r.approveCount}</span>/{r.voteThreshold ?? "?"} approve ·{" "}
                      <span className="text-destructive">{r.rejectCount ?? 0}</span> reject
                    </div>
                  ) : null}
                </div>
              ) : null}
              <ReviewCommentThread subjectType={r.subjectType} subjectId={r.subjectId} markSeenOnMount />
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );

  const renderSection = (bucket: LifecycleBucket) => {
    const sectionRows = buckets[bucket];
    return (
      <Card className="rounded-none border-border bg-card/50" key={bucket}>
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            {BUCKET_LABEL[bucket]}
            <span className="text-muted-foreground text-xs font-mono">({sectionRows.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sectionRows.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground font-mono text-xs">
              Nothing here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[760px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Title</th>
                    <th className="text-left p-3">Character</th>
                    <th className="text-left p-3">Submitted</th>
                    <th className="text-left p-3">Decided</th>
                    <th className="text-left p-3">Status</th>
                  </tr>
                </thead>
                <tbody>{sectionRows.map(renderRow)}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-my-requests-title"
        >
          <ClipboardList className="w-8 h-8 text-nc-magenta" /> MY REQUESTS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Every character, character edit, property, gun, cyberware, stock-cost, and lease request you've submitted — with the outcome and staff notes. When a fixer asks for changes, respond right here.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {CATEGORY_FILTERS.map((c) => (
          <Button
            key={c}
            type="button"
            size="sm"
            variant={category === c ? "default" : "outline"}
            className={`rounded-none font-display text-xs tracking-widest ${
              category === c ? "bg-nc-cyan text-background hover:bg-nc-cyan/80" : ""
            }`}
            onClick={() => setCategory(c)}
            data-testid={`filter-requests-${c.toLowerCase()}`}
          >
            {c.toUpperCase()}
          </Button>
        ))}
      </div>

      {!me ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-16 text-center text-muted-foreground font-mono text-sm">
            Log in to see your requests.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-16 text-center text-nc-cyan animate-pulse font-display">LOADING...</CardContent>
        </Card>
      ) : visible.length === 0 ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-16 text-center text-muted-foreground font-mono text-sm">
            {rows.length === 0 ? "You haven't submitted any requests yet." : "No requests in this category."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {(["active", "resolved", "archive"] as const).map((b) => renderSection(b))}
        </div>
      )}

      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="rounded-none border-nc-cyan bg-card">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">EDIT & RESUBMIT</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Title</label>
                <Input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className="rounded-none mt-1"
                  data-testid="input-edit-title"
                />
              </div>
              <div>
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Description</label>
                <Textarea
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={4}
                  className="rounded-none mt-1"
                  data-testid="input-edit-description"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-none font-display"
              onClick={() => setEditing(null)}
              data-testid="button-edit-cancel"
            >
              CANCEL
            </Button>
            <Button
              type="button"
              disabled={update.isPending || resubmit.isPending || !editing?.title.trim()}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              onClick={saveAndResubmit}
              data-testid="button-edit-save-resubmit"
            >
              SAVE & RESUBMIT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
