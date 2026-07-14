import { Fragment, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useListMyCustomRequests,
  useListMyHousingRequests,
  useListMySheets,
  useListPendingEdits,
  useDecideStockCostRequest,
  useUpdateCustomRequest,
  useResubmitCustomRequest,
  useSubmitDraftCustomRequest,
  useDeleteDraftCustomRequest,
  useGetMyUnseen,
  getListMyCustomRequestsQueryKey,
  getListPendingEditsQueryKey,
  getGetMyUnseenQueryKey,
  type CustomRequest,
  type HousingRequest,
  type CharacterSheet,
  type PendingEditSummary,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { statusBucket, BUCKET_LABEL } from "@/lib/reviewLifecycle";
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
import { ClipboardList, RotateCcw, Pencil, Trash2, MessageSquare, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import ReviewCommentThread from "@/components/ReviewCommentThread";
import MultiImageUpload from "@/components/MultiImageUpload";
import PendingEditDiffInline from "@/components/PendingEditDiffInline";

// Custom-request types that are decided by the PLAYER rather than submitted
// by them (employment invites, mission-participation confirmations). They are
// rendered on the Inbox page — see Inbox.tsx — so this page filters them out.
const INBOX_REQUEST_TYPES = new Set<CustomRequest["type"]>([
  "employee_invite",
  "mission_participation",
]);

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
    | "Item"
    | "Store"
    | "Clinic"
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
  // Reference images on custom requests, editable alongside title/description.
  imageUrls?: string[];
  // Set for custom requests the owner can act on directly (stock-cost).
  customId?: number;
  customType?: CustomRequest["type"];
  // Venue (store/ripperdoc) request content, surfaced so the draft editor can
  // resume an incomplete venue draft (these are required to submit it).
  purpose?: string | null;
  location?: string | null;
  // Review-subject identity for the discussion thread + unread dots. Housing
  // leases aren't part of the review pipeline, so they leave these unset.
  subjectType?: "request" | "edit" | "sheet";
  subjectId?: number;
  // Set for character sheets / edits: where the player goes to read the
  // reviewer's note and resubmit. Inline resubmit isn't possible for these
  // (they have full forms / diffs), so we link to their detail page.
  respondTo?: string;
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
  "item",
  "store",
  "ripperdoc",
  "venue_stock",
]);

const CUSTOM_LABEL: Record<CustomRequest["type"], HistoryRow["category"]> = {
  property: "Property",
  gun: "Gun",
  cyberware: "Cyberware",
  item: "Item",
  store: "Store",
  ripperdoc: "Clinic",
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
  "Item",
  "Store",
  "Clinic",
  "Stock",
  "Venue Stock",
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
    case "Item":
      return "text-nc-magenta";
    case "Store":
      return "text-nc-cyan";
    case "Clinic":
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

export default function MySubmissions() {
  const { data: me } = useAuthMe();
  const { data: custom, isLoading: loadingCustom } = useListMyCustomRequests();
  const { data: housing, isLoading: loadingHousing } = useListMyHousingRequests();
  const { data: sheets, isLoading: loadingSheets } = useListMySheets();
  // Fetch the player's OWN edits across EVERY lifecycle bucket. /pending-edits is
  // staff-scoped for reviewers (its default view is open edits + anything decided
  // in the last 7 days), so a reviewer's own OLD terminal edit (e.g. a cancelled
  // edit decided over a week ago) would never come back from the default list —
  // yet /review/my-unseen still counts it, leaving a stuck "1" badge with no row
  // to open and clear. Pulling active + resolved + archive and merging guarantees
  // every edit my-unseen can count is actually rendered here. (For non-reviewers
  // the bucket param is ignored server-side and each call returns all own edits,
  // so the merge simply de-dupes.)
  const { data: editsActive, isLoading: loadingEditsActive } = useListPendingEdits(
    { bucket: "active" },
    { query: { queryKey: getListPendingEditsQueryKey({ bucket: "active" }) } },
  );
  const { data: editsResolved, isLoading: loadingEditsResolved } = useListPendingEdits(
    { bucket: "resolved" },
    { query: { queryKey: getListPendingEditsQueryKey({ bucket: "resolved" }) } },
  );
  const { data: editsArchive, isLoading: loadingEditsArchive } = useListPendingEdits(
    { bucket: "archive" },
    { query: { queryKey: getListPendingEditsQueryKey({ bucket: "archive" }) } },
  );
  const edits = useMemo(() => {
    const byId = new Map<number, PendingEditSummary>();
    for (const list of [editsActive, editsResolved, editsArchive]) {
      for (const e of (list ?? []) as PendingEditSummary[]) byId.set(e.id, e);
    }
    return Array.from(byId.values());
  }, [editsActive, editsResolved, editsArchive]);
  const loadingEdits = loadingEditsActive || loadingEditsResolved || loadingEditsArchive;
  const [, navigate] = useLocation();
  const [category, setCategory] = useState<HistoryRow["category"] | "All">("All");
  const qc = useQueryClient();
  const { toast } = useToast();
  // mode "resubmit" = changes_requested flow (edit then send back to queue);
  // mode "save" = still-pending in-queue edit (save only, votes reset server-side).
  const [editing, setEditing] = useState<{ id: number; title: string; description: string; mode: "save" | "resubmit"; isVenue?: boolean; purpose?: string; location?: string; imageUrls: string[] } | null>(null);
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
  const update = useUpdateCustomRequest();
  const resubmit = useResubmitCustomRequest({
    mutation: {
      onSuccess: () => { toast({ title: "Resubmitted for review" }); invalidateMine(); },
      onError: (err) => toast({ title: "Resubmit failed", description: errMsg(err, "Resubmit failed"), variant: "destructive" }),
    },
  });
  const submitDraft = useSubmitDraftCustomRequest({
    mutation: {
      onSuccess: () => { toast({ title: "Submitted for review" }); invalidateMine(); },
      onError: (err) => toast({ title: "Could not submit", description: errMsg(err, "Submit failed"), variant: "destructive" }),
    },
  });
  const deleteDraft = useDeleteDraftCustomRequest({
    mutation: {
      onSuccess: () => { toast({ title: "Draft deleted" }); invalidateMine(); },
      onError: (err) => toast({ title: "Could not delete", description: errMsg(err, "Delete failed"), variant: "destructive" }),
    },
  });

  // Save the edited title/description. In "resubmit" mode (changes_requested) we
  // also send it back to the queue; resubmit is allowed even with no edits. In
  // "save" mode (still pending) we only persist — the server resets prior votes
  // so the next round judges the edited content.
  const saveEditing = async () => {
    if (!editing) return;
    try {
      const data: Record<string, unknown> = { title: editing.title, description: editing.description, imageUrls: editing.imageUrls };
      if (editing.isVenue) {
        data.purpose = editing.purpose ?? "";
        data.location = editing.location ?? "";
      }
      await update.mutateAsync({ id: editing.id, data });
      if (editing.mode === "resubmit") {
        await resubmit.mutateAsync({ id: editing.id });
      } else {
        toast({ title: "Request updated" });
        invalidateMine();
      }
      setEditing(null);
    } catch (err) {
      toast({ title: "Could not save", description: errMsg(err, "Save failed"), variant: "destructive" });
    }
  };

  const rows = useMemo<HistoryRow[]>(() => {
    const out: HistoryRow[] = [];
    for (const r of (custom ?? []) as CustomRequest[]) {
      // Player-decided rows (invites / participation) live on the Inbox page.
      if (INBOX_REQUEST_TYPES.has(r.type)) continue;
      const det = (r.details ?? {}) as {
        purpose?: string | null;
        location?: string | null;
      };
      const isVenue = r.type === "store" || r.type === "ripperdoc";
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
        imageUrls: r.imageUrls ?? (r.imageUrl ? [r.imageUrl] : []),
        customId: r.id,
        customType: r.type,
        purpose: isVenue ? det.purpose ?? null : null,
        location: isVenue ? det.location ?? null : null,
        subjectType: "request",
        subjectId: r.id,
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
  // The player view collapses to two sections: Active (needs action) and
  // Resolved (decided). The shared lifecycle still distinguishes "archive"
  // (closed) for staff, so fold it into Resolved here.
  const buckets = useMemo(() => {
    const b: Record<"active" | "resolved", HistoryRow[]> = { active: [], resolved: [] };
    for (const r of visible) {
      (statusBucket(r.status) === "active" ? b.active : b.resolved).push(r);
    }
    return b;
  }, [visible]);
  const isLoading = loadingCustom || loadingHousing || loadingSheets || loadingEdits;

  const renderRow = (r: HistoryRow) => (
    <Fragment key={r.key}>
      <tr
        className="border-b border-border/30 hover:bg-card/80 align-top cursor-pointer"
        onClick={() => setDiscussing((cur) => (cur === r.key ? null : r.key))}
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
        <td className="p-3" onClick={(e) => e.stopPropagation()}>
          <RequestStatusBadge status={r.status} stagedApproval={!!r.subjectType} />
          {r.status === "changes_requested" && r.customId != null && r.customType !== "stock_cost" ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                className="rounded-none bg-nc-cyan text-background font-display text-[10px] tracking-widest"
                onClick={() => setEditing({ id: r.customId!, title: r.title, description: r.description ?? "", mode: "resubmit", isVenue: r.customType === "store" || r.customType === "ripperdoc", purpose: r.purpose ?? "", location: r.location ?? "", imageUrls: r.imageUrls ?? [] })}
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
          {/* Draft: the player's private work-in-progress. Submit promotes it to
              the review queue (server re-validates), Edit amends title/description
              in place, Delete discards it. */}
          {r.status === "draft" && r.customId != null ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                disabled={submitDraft.isPending}
                className="rounded-none bg-nc-cyan text-background font-display text-[10px] tracking-widest"
                onClick={() => submitDraft.mutate({ id: r.customId! })}
                data-testid={`button-submit-draft-${r.customId}`}
              >
                <RotateCcw className="w-3 h-3 mr-1" /> SUBMIT
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-none border-nc-cyan text-nc-cyan font-display text-[10px] tracking-widest"
                onClick={() => setEditing({ id: r.customId!, title: r.title, description: r.description ?? "", mode: "save", isVenue: r.customType === "store" || r.customType === "ripperdoc", purpose: r.purpose ?? "", location: r.location ?? "", imageUrls: r.imageUrls ?? [] })}
                data-testid={`button-edit-draft-${r.customId}`}
              >
                <Pencil className="w-3 h-3 mr-1" /> EDIT
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={deleteDraft.isPending}
                className="rounded-none border-destructive text-destructive font-display text-[10px] tracking-widest"
                onClick={() => deleteDraft.mutate({ id: r.customId! })}
                data-testid={`button-delete-draft-${r.customId}`}
              >
                <Trash2 className="w-3 h-3 mr-1" /> DELETE
              </Button>
            </div>
          ) : null}
          {/* Still-pending player proposal: let the submitter amend it in place
              while it sits in the fixer queue (saving resets any votes already
              cast). Only the fixer-voted proposal types carry an editable
              title/description; owner/player-decision rows are excluded. */}
          {r.status === "pending" && r.customId != null && r.customType && FIXER_VOTED_TYPES.has(r.customType) ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                className="rounded-none bg-nc-cyan text-background font-display text-[10px] tracking-widest"
                onClick={() => setEditing({ id: r.customId!, title: r.title, description: r.description ?? "", mode: "save", isVenue: r.customType === "store" || r.customType === "ripperdoc", purpose: r.purpose ?? "", location: r.location ?? "", imageUrls: r.imageUrls ?? [] })}
                data-testid={`button-edit-pending-${r.customId}`}
              >
                <Pencil className="w-3 h-3 mr-1" /> EDIT
              </Button>
            </div>
          ) : null}
          {r.respondTo && (r.status === "pending" || r.status === "changes_requested") ? (
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                size="sm"
                className="rounded-none bg-nc-cyan text-background font-display text-[10px] tracking-widest"
                onClick={() => navigate(r.respondTo!)}
                data-testid={`button-respond-${r.key}`}
              >
                <Pencil className="w-3 h-3 mr-1" /> VIEW &amp; EDIT
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
        </td>
      </tr>
      {discussing === r.key ? (
        <tr className="border-b border-border/30" data-testid={`row-discuss-${r.key}`}>
          <td colSpan={6} className="p-3 bg-card/40">
            <div className="space-y-3">
              <div
                className="font-mono text-xs text-muted-foreground space-y-1 border border-border/40 bg-background/40 p-3"
                data-testid={`details-${r.key}`}
              >
                <div><span className="text-nc-cyan">CHARACTER:</span> {r.characterName}</div>
                <div><span className="text-nc-cyan">SUBMITTED:</span> {new Date(r.createdAt).toLocaleString()}</div>
                {r.reviewedAt ? (
                  <div><span className="text-nc-cyan">DECIDED:</span> {new Date(r.reviewedAt).toLocaleString()}</div>
                ) : null}
                {r.description ? <p className="whitespace-pre-wrap text-foreground pt-1">{r.description}</p> : null}
                {r.reviewerNote ? <p className="italic pt-1">Staff note: "{r.reviewerNote}"</p> : null}
                {r.customType && FIXER_VOTED_TYPES.has(r.customType) && r.approveCount != null ? (
                  <div>
                    Votes: <span className="text-nc-green">{r.approveCount}</span>/{r.voteThreshold ?? "?"} approve ·{" "}
                    <span className="text-destructive">{r.rejectCount ?? 0}</span> reject
                  </div>
                ) : null}
              </div>
              {/* Character edits carry a before/after diff so the player can see
                  exactly what their edit proposed without leaving this page. */}
              {r.subjectType === "edit" && r.subjectId != null ? (
                <div className="border border-border/40 bg-background/40 p-3">
                  <div className="font-display text-[11px] tracking-widest text-nc-cyan mb-2">WHAT CHANGED</div>
                  <PendingEditDiffInline editId={r.subjectId} />
                </div>
              ) : null}
              {r.respondTo ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-none border-nc-cyan text-nc-cyan font-display text-[10px] tracking-widest"
                  onClick={() => navigate(r.respondTo!)}
                  data-testid={`button-view-full-${r.key}`}
                >
                  <ExternalLink className="w-3 h-3 mr-1" /> VIEW FULL DETAILS
                </Button>
              ) : null}
              {r.subjectType && r.subjectId != null ? (
                <ReviewCommentThread subjectType={r.subjectType} subjectId={r.subjectId} markSeenOnMount />
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );

  const renderSection = (bucket: "active" | "resolved") => {
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
          data-testid="text-my-submissions-title"
        >
          <ClipboardList className="w-8 h-8 text-nc-magenta" /> MY SUBMISSIONS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Everything you've sent out for review — characters, character edits, property, gun, cyberware, stock-cost, and lease requests — with the outcome and staff notes. When a fixer asks for changes, respond right here. Things waiting on <em>your</em> decision live in your Inbox.
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
          {(["active", "resolved"] as const).map((b) => renderSection(b))}
        </div>
      )}

      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="rounded-none border-nc-cyan bg-card">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">{editing?.mode === "save" ? "EDIT REQUEST" : "EDIT & RESUBMIT"}</DialogTitle>
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
              <div>
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Reference Images (optional)</label>
                <div className="mt-1">
                  <MultiImageUpload
                    value={editing.imageUrls}
                    onChange={(urls) => setEditing({ ...editing, imageUrls: urls })}
                    testIdPrefix="edit-request-image"
                    alt="request reference"
                  />
                </div>
              </div>
              {editing.isVenue && (
                <>
                  <div>
                    <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Purpose</label>
                    <Input
                      value={editing.purpose ?? ""}
                      onChange={(e) => setEditing({ ...editing, purpose: e.target.value })}
                      className="rounded-none mt-1"
                      data-testid="input-edit-purpose"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Location</label>
                    <Input
                      value={editing.location ?? ""}
                      onChange={(e) => setEditing({ ...editing, location: e.target.value })}
                      className="rounded-none mt-1"
                      data-testid="input-edit-location"
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
              data-testid="button-edit-cancel"
            >
              CANCEL
            </Button>
            <Button
              type="button"
              disabled={update.isPending || resubmit.isPending || !editing?.title.trim()}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              onClick={saveEditing}
              data-testid="button-edit-save-resubmit"
            >
              {editing?.mode === "save" ? "SAVE CHANGES" : "SAVE & RESUBMIT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
