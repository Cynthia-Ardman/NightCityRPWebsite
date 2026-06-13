import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  useGetPendingEdit,
  useGetCharacter,
  useVotePendingEdit,
  useCancelPendingEdit,
  useOverridePendingEdit,
  useResubmitPendingEdit,
  useCloseReviewTicket,
  getGetPendingEditQueryKey,
  getListPendingEditsQueryKey,
  getGetCharacterPendingEditQueryKey,
  getGetCharacterQueryKey,
  type Character,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReviewerRoster } from "@/components/review/ReviewerRoster";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Check, X, Clock, CheckCircle2, XCircle, RotateCcw, ArrowLeft, ShieldCheck, MessageSquareWarning, Pencil, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import EditCharacterDialog from "@/components/EditCharacterDialog";
import ReviewCommentThread, { AwaitingVoteBanner } from "@/components/ReviewCommentThread";
import DiffValue from "@/components/DiffValue";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

function statusBadge(status: string) {
  if (status === "pending") return <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none font-mono text-xs animate-pulse"><Clock className="w-3 h-3 mr-1" /> PENDING</Badge>;
  if (status === "approved") return <Badge variant="outline" className="border-nc-green text-nc-green rounded-none font-mono text-xs"><CheckCircle2 className="w-3 h-3 mr-1" /> APPROVED</Badge>;
  if (status === "rejected") return <Badge variant="outline" className="border-destructive text-destructive rounded-none font-mono text-xs"><XCircle className="w-3 h-3 mr-1" /> REJECTED</Badge>;
  if (status === "changes_requested") return <Badge variant="outline" className="border-nc-magenta text-nc-magenta rounded-none font-mono text-xs"><MessageSquareWarning className="w-3 h-3 mr-1" /> CHANGES REQ</Badge>;
  if (status === "cancelled") return <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-xs">CANCELLED</Badge>;
  return <Badge variant="outline" className="rounded-none font-mono text-xs">{status}</Badge>;
}

// Render a single field's change. Defaults to the unified diff (only what
// changed is highlighted); reviewers can flip the whole page to the classic
// before/after columns via the toggle.
function FieldDiff({ field, before, after, view }: { field: string; before: unknown; after: unknown; view: "unified" | "split" }) {
  return (
    <div className="space-y-2" data-testid={`field-diff-${field}`}>
      <div className="font-display text-sm tracking-widest text-nc-cyan border-b border-border pb-1">
        {field.toUpperCase()}
      </div>
      <DiffValue before={before} after={after} view={view} />
    </div>
  );
}

export default function PendingEditDetail() {
  const { id } = useParams();
  const editId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [voteNote, setVoteNote] = useState("");
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [editOpen, setEditOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeNote, setCloseNote] = useState("");

  const { data: edit, isLoading } = useGetPendingEdit(editId);
  const me = useEffectiveMe();
  // Reviewers reach this detail from the unified /requests queue (Character
  // Edits tab), so "back to queue" returns them there on the right tab.
  // Players (submitters) have their own flat /pending-edits list.
  const isReviewer = !!(me.data?.isFixer || me.data?.isCsApprover || me.data?.isAdmin);
  const queueHref = isReviewer ? "/requests?tab=edits" : "/pending-edits";
  // The submitter can amend their own edit in place while it is still pending
  // (the backend upserts the same review row and clears prior votes). This is
  // distinct from canResubmit, which only applies after changes were requested.
  const canAmend =
    !!me.data?.id && !!edit && edit.submittedBy === me.data.id && edit.status === "pending";
  // Pull the live character so the submitter can edit-and-resubmit (after
  // changes) or amend (while pending) in place.
  const { data: character } = useGetCharacter(edit?.characterId ?? 0, {
    query: {
      enabled: !!edit?.characterId && (!!edit?.canResubmit || canAmend),
      queryKey: getGetCharacterQueryKey(edit?.characterId ?? 0),
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetPendingEditQueryKey(editId) });
    qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
    if (edit?.characterId) {
      qc.invalidateQueries({ queryKey: getGetCharacterPendingEditQueryKey(edit.characterId) });
      qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(edit.characterId) });
    }
  };

  const vote = useVotePendingEdit({
    mutation: {
      onSuccess: (r) => {
        toast({
          title: `Vote recorded: ${r.status === "pending" ? `${r.approveCount}/${r.threshold} approvals` : r.status}`,
        });
        setVoteNote("");
        invalidate();
      },
      onError: (err) => {
        const msg = (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? "Vote failed";
        toast({ title: "Vote failed", description: msg, variant: "destructive" });
      },
    },
  });

  const cancel = useCancelPendingEdit({
    mutation: {
      onSuccess: () => {
        toast({ title: "Edit cancelled" });
        invalidate();
        navigate(queueHref);
      },
      onError: (err) => {
        const msg = (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? "Cancel failed";
        toast({ title: "Cancel failed", description: msg, variant: "destructive" });
      },
    },
  });

  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? fallback;

  const override = useOverridePendingEdit({
    mutation: {
      onSuccess: () => { toast({ title: "Edit approved via override" }); invalidate(); },
      onError: (err) => toast({ title: "Override failed", description: errMsg(err, "Override failed"), variant: "destructive" }),
    },
  });

  const resubmit = useResubmitPendingEdit({
    mutation: {
      onSuccess: () => { toast({ title: "Resubmitted to the review queue" }); invalidate(); },
      onError: (err) => toast({ title: "Resubmit failed", description: errMsg(err, "Resubmit failed"), variant: "destructive" }),
    },
  });

  const closeTicket = useCloseReviewTicket({
    mutation: {
      onSuccess: () => {
        toast({ title: "Changes applied & ticket closed" });
        setCloseOpen(false);
        setCloseNote("");
        invalidate();
        navigate(queueHref);
      },
      onError: (err) => toast({ title: "Close failed", description: errMsg(err, "Close failed"), variant: "destructive" }),
    },
  });

  if (isLoading) return <div className="p-8 font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!edit) return <div className="p-8 font-display text-destructive">NOT FOUND</div>;

  const diff = (edit.proposedDiff ?? {}) as Record<string, unknown>;
  const before = (edit.before ?? {}) as Record<string, unknown>;
  const fields = Object.keys(diff);
  // Pre-fill the edit dialog with the player's previously-proposed values
  // (live character merged with their pending diff) so they amend, not redo.
  const mergedCharacter = character ? ({ ...character, ...diff } as Character) : null;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <Link href={queueHref}>
        <a className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground hover:text-nc-cyan">
          <ArrowLeft className="w-3 h-3" /> BACK TO QUEUE
        </a>
      </Link>

      <div className="border-b border-border pb-4 flex items-start justify-between gap-4">
        <div className="space-y-2 min-w-0 flex-1">
          <h1 className="font-display text-3xl tracking-widest text-nc-cyan truncate">
            EDIT: {edit.characterName}
          </h1>
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
            <span>by {edit.submitterName ?? "(unknown)"}</span>
            <span>·</span>
            <span>{new Date(edit.submittedAt).toLocaleString()}</span>
            <span>·</span>
            <Link href={`/characters/${edit.characterId}`}>
              <a className="text-nc-cyan hover:underline">VIEW CHARACTER</a>
            </Link>
          </div>
          {edit.updateNote && (
            <div className="font-mono text-sm text-foreground/80 italic border-l-2 border-nc-cyan pl-3 mt-2">
              "{edit.updateNote}"
            </div>
          )}
        </div>
        {statusBadge(edit.status)}
      </div>

      <AwaitingVoteBanner show={!!edit.canVote && !(edit.myVote && edit.myVote.vote)} />

      {/* Apply & close — appears once all approvals are in (status approved).
          Any reviewer can commit the diff and archive the ticket. */}
      {edit.canClose && (
        <Card className="rounded-none border-nc-green bg-nc-green/5">
          <CardContent className="pt-6 space-y-3">
            <p className="font-mono text-sm text-foreground/80">
              All approvals are in. Applying will commit these changes to{" "}
              <span className="text-nc-cyan">{edit.characterName}</span> and archive this ticket.
            </p>
            <Button
              onClick={() => setCloseOpen(true)}
              disabled={closeTicket.isPending}
              className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display tracking-widest"
              data-testid="button-apply-close"
            >
              <Lock className="w-4 h-4 mr-1" /> APPLY CHANGES &amp; CLOSE TICKET
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tally */}
      <Card className="rounded-none border-border bg-card/30">
        <CardHeader className="pb-2">
          <CardTitle className="font-display text-sm tracking-widest text-nc-cyan">VOTE TALLY</CardTitle>
        </CardHeader>
        <CardContent className="font-mono text-sm space-y-1">
          <div>
            <span className="text-nc-green">{edit.approveCount}</span> approve ·{" "}
            <span className="text-destructive">{edit.rejectCount}</span> reject ·{" "}
            threshold <span className="text-nc-cyan">{edit.threshold}</span> of {edit.eligibleVoterCount} eligible reviewers
          </div>
          {edit.decisionSummary && (
            <div className="text-xs text-muted-foreground italic">{edit.decisionSummary}</div>
          )}
          {edit.eligibleReviewers && edit.eligibleReviewers.length > 0 && (
            <ReviewerRoster
              className="pt-3 border-t border-border/40"
              eligibleReviewers={edit.eligibleReviewers}
              voters={edit.votes.map((v) => ({ id: v.voterId, vote: v.vote }))}
            />
          )}
        </CardContent>
      </Card>

      {/* Diff */}
      <div className="space-y-6">
        {fields.length === 0 ? (
          <div className="font-mono text-sm text-muted-foreground italic">No changed fields recorded.</div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-2">
              <div className="font-mono text-xs text-muted-foreground">
                {fields.length} changed field{fields.length === 1 ? "" : "s"} —{" "}
                <span className="text-destructive">red</span> removed, <span className="text-nc-green">green</span> added.
              </div>
              <div className="flex border border-border" role="group" aria-label="Diff view">
                <button
                  type="button"
                  onClick={() => setDiffView("unified")}
                  className={`px-3 py-1 font-display text-[11px] tracking-widest ${diffView === "unified" ? "bg-nc-cyan text-background" : "text-muted-foreground hover:text-nc-cyan"}`}
                  data-testid="button-diff-unified"
                >
                  CHANGES
                </button>
                <button
                  type="button"
                  onClick={() => setDiffView("split")}
                  className={`px-3 py-1 font-display text-[11px] tracking-widest ${diffView === "split" ? "bg-nc-cyan text-background" : "text-muted-foreground hover:text-nc-cyan"}`}
                  data-testid="button-diff-split"
                >
                  SIDE-BY-SIDE
                </button>
              </div>
            </div>
            {fields.map((f) => <FieldDiff key={f} field={f} before={before[f]} after={diff[f]} view={diffView} />)}
          </>
        )}
      </div>

      {/* Vote panel */}
      {edit.canVote && (
        <Card className="rounded-none border-nc-cyan bg-card/40">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-sm tracking-widest text-nc-cyan">YOUR VOTE</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {edit.myVote && edit.myVote.vote ? (
              <div className="font-mono text-xs text-muted-foreground">
                Current vote: <span className={edit.myVote.vote === "approve" ? "text-nc-green" : "text-destructive"}>
                  {edit.myVote.vote.toUpperCase()}
                </span>
                {edit.myVote.note ? <span className="italic"> — "{edit.myVote.note}"</span> : null}
              </div>
            ) : null}
            <Textarea
              value={voteNote}
              onChange={(e) => setVoteNote(e.target.value)}
              placeholder="Optional comment for the player..."
              rows={2}
              maxLength={2000}
              data-testid="input-vote-note"
            />
            <div className="flex gap-2">
              <Button
                onClick={() => vote.mutate({ id: editId, data: { vote: "approve", note: voteNote || undefined } })}
                disabled={vote.isPending}
                className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display"
                data-testid="button-approve"
              >
                <Check className="w-4 h-4 mr-1" /> APPROVE
              </Button>
              <Button
                onClick={() => vote.mutate({ id: editId, data: { vote: "reject", note: voteNote || undefined } })}
                disabled={vote.isPending}
                variant="destructive"
                className="rounded-none font-display"
                data-testid="button-reject"
              >
                <X className="w-4 h-4 mr-1" /> REJECT
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reviewer comment when changes are requested */}
      {edit.status === "changes_requested" && edit.reviewComment && (
        <Card className="rounded-none border-nc-magenta bg-card/40">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-sm tracking-widest text-nc-magenta">CHANGES REQUESTED</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm text-foreground/80 italic">
            "{edit.reviewComment}"
          </CardContent>
        </Card>
      )}

      {/* Two-way discussion thread (player <-> reviewers). Never blocks approval. */}
      <ReviewCommentThread subjectType="edit" subjectId={editId} />

      {/* Admin override */}
      {edit.canOverride && (
        <div className="border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => override.mutate({ id: editId, data: { decision: "approve" } })}
              disabled={override.isPending}
              className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display"
              data-testid="button-override"
            >
              <ShieldCheck className="w-4 h-4 mr-1" /> ADMIN OVERRIDE — APPROVE NOW
            </Button>
            <Button
              onClick={() => override.mutate({ id: editId, data: { decision: "deny" } })}
              disabled={override.isPending}
              variant="outline"
              className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display"
              data-testid="button-override-deny"
            >
              <X className="w-4 h-4 mr-1" /> ADMIN OVERRIDE — DENY NOW
            </Button>
          </div>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Bypasses the majority vote and resolves the edit immediately. Records you as the override decider.
          </p>
        </div>
      )}

      {/* Resubmit (submitter, after changes requested) */}
      {edit.canResubmit && (
        <div className="border-t border-border pt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setEditOpen(true)}
              disabled={!mergedCharacter}
              className="rounded-none bg-nc-magenta text-foreground hover:bg-nc-magenta/80 font-display"
              data-testid="button-edit-resubmit"
            >
              <Pencil className="w-4 h-4 mr-1" /> EDIT &amp; RESUBMIT
            </Button>
            <Button
              onClick={() => resubmit.mutate({ id: editId })}
              disabled={resubmit.isPending}
              variant="outline"
              className="rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display"
              data-testid="button-resubmit"
            >
              <RotateCcw className="w-4 h-4 mr-1" /> RESUBMIT AS-IS
            </Button>
          </div>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Use <span className="text-nc-magenta">EDIT &amp; RESUBMIT</span> to make the requested changes — your update amends this same review. Or resubmit as-is to send it back unchanged. Either way, prior votes are cleared.
          </p>
        </div>
      )}

      {/* Amend (submitter, while still pending) — update the edit in place */}
      {canAmend && (
        <div className="border-t border-border pt-4 space-y-2">
          <Button
            onClick={() => setEditOpen(true)}
            disabled={!mergedCharacter}
            className="rounded-none bg-nc-magenta text-foreground hover:bg-nc-magenta/80 font-display"
            data-testid="button-amend-edit"
          >
            <Pencil className="w-4 h-4 mr-1" /> AMEND THIS EDIT
          </Button>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Change what you proposed while it's still under review — your update amends this same ticket. Prior votes are cleared so reviewers re-tally against the new content.
          </p>
        </div>
      )}

      {mergedCharacter && (
        <EditCharacterDialog character={mergedCharacter} open={editOpen} onOpenChange={setEditOpen} />
      )}

      {/* Apply & close confirmation — optional reviewer note before committing. */}
      <Dialog open={closeOpen} onOpenChange={(o) => { if (!closeTicket.isPending) setCloseOpen(o); }}>
        <DialogContent className="rounded-none border-nc-green bg-card">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-green">
              APPLY CHANGES &amp; CLOSE TICKET
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              This commits the approved edit to <span className="text-nc-cyan">{edit.characterName}</span> and archives
              the ticket. Add an optional note for the record.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
            placeholder="Optional note (e.g. why you're applying these changes)..."
            rows={3}
            maxLength={2000}
            data-testid="input-close-note"
          />
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-none font-display text-xs"
              onClick={() => setCloseOpen(false)}
              disabled={closeTicket.isPending}
              data-testid="button-close-cancel"
            >
              CANCEL
            </Button>
            <Button
              className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
              onClick={() => closeTicket.mutate({ subjectType: "edit", id: editId, data: { note: closeNote.trim() || undefined } })}
              disabled={closeTicket.isPending}
              data-testid="button-close-confirm"
            >
              <Lock className="w-4 h-4 mr-1" /> APPLY &amp; CLOSE
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel (submitter only, while still pending) */}
      {edit.status === "pending" && (
        <div className="border-t border-border pt-4">
          <Button
            variant="outline"
            className="rounded-none font-display text-xs"
            onClick={() => cancel.mutate({ id: editId })}
            disabled={cancel.isPending}
            data-testid="button-cancel-edit"
          >
            <RotateCcw className="w-3 h-3 mr-1" /> WITHDRAW THIS EDIT
          </Button>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Submitters or admins can withdraw a pending edit. You can resubmit at any time.
          </p>
        </div>
      )}

      {/* Vote history */}
      {edit.votes.length > 0 && (
        <Card className="rounded-none border-border bg-card/30">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-sm tracking-widest text-nc-cyan">VOTES CAST</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {edit.votes.map((v) => (
              <div key={v.id} className="flex items-center gap-3 font-mono text-xs" data-testid={`vote-row-${v.id}`}>
                <Avatar className="h-6 w-6 rounded-none border border-border">
                  <AvatarImage src={v.voterAvatarUrl ?? ""} />
                  <AvatarFallback className="bg-background text-nc-cyan rounded-none text-[10px]">
                    {(v.voterName ?? "?").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-foreground">{v.voterName ?? v.voterId}</span>
                <span className={v.vote === "approve" ? "text-nc-green" : "text-destructive"}>
                  {v.vote === "approve" ? "APPROVED" : "REJECTED"}
                </span>
                <span className="text-muted-foreground">{new Date(v.votedAt).toLocaleString()}</span>
                {v.note && <span className="italic text-foreground/70 truncate">"{v.note}"</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
