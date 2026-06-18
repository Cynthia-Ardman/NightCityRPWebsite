import { useState, type ReactNode } from "react";
import {
  useCloseReviewTicket,
  useReopenReviewTicket,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { BUCKET_LABEL, type LifecycleBucket } from "@/lib/reviewLifecycle";
import { SheetCloseDialog } from "@/components/review/SheetCloseDialog";

// Prominent "NEW" pill flagging a ticket the current reviewer hasn't opened
// since its last activity (a new comment or vote). Driven by /review/unseen-ids.
// Deliberately a labeled pill, not a bare dot, so reviewers can scan a column
// of cards and immediately see which ones need attention without opening each.
export function UnseenDot({ show, testid }: { show: boolean; testid: string }) {
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-none border border-nc-magenta bg-nc-magenta/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-nc-magenta shadow-[0_0_6px_rgba(255,0,128,0.6)] shrink-0"
      title="New activity since you last opened this ticket"
      data-testid={testid}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-nc-magenta animate-pulse" />
      NEW
    </span>
  );
}

// Shared close/reopen mutations. Close commits any staged effects + archives;
// Reopen sends an approved/rejected ticket back to pending (votes reset).
export function useReviewTicketActions(invalidate: () => void) {
  const { toast } = useToast();
  const onError = (err: unknown) => {
    const msg =
      (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
      (err instanceof Error ? err.message : "Please try again.");
    toast({ title: "Action failed", description: msg, variant: "destructive" });
  };
  const close = useCloseReviewTicket({
    mutation: { onSuccess: () => { invalidate(); toast({ title: "Ticket closed & archived" }); }, onError },
  });
  const reopen = useReopenReviewTicket({
    mutation: { onSuccess: () => { invalidate(); toast({ title: "Ticket reopened — back to pending" }); }, onError },
  });
  return { close, reopen, busy: close.isPending || reopen.isPending };
}

// Close-with-message dialog (Tickety-style). Opens from the CLOSE & APPLY /
// CLOSE TICKET button and lets the reviewer attach an OPTIONAL note before the
// ticket is finalized. For custom requests that note is DM'd to the player
// along with the approve/reject decision; for edits/sheets it's recorded in the
// audit trail only. The close mutation itself is owned by the caller (so its
// onSuccess/onError + invalidation stay in one place) — we just gate it behind
// a confirmation that collects the message.
type CloseTicketDialogProps = {
  subjectType: "edit" | "request" | "sheet";
  id: number;
  status: string;
  close: ReturnType<typeof useCloseReviewTicket>;
  disabled?: boolean;
  triggerClassName?: string;
  triggerLabel?: string;
  onClosed?: () => void;
};

// Dispatcher: sheets close through a dedicated dialog because closing an
// approved sheet materializes the character, and custom (non-catalog)
// cyberware/guns require mechanical attributes the generic note-only dialog
// can't collect (the server 400s without them). Centralizing the routing here
// means every sheet-close entry point (queue lifecycle, ready-to-apply panel)
// gets the right dialog with no per-call-site branching.
export function CloseTicketDialog(props: CloseTicketDialogProps) {
  if (props.subjectType === "sheet") {
    const { subjectType: _ignored, ...rest } = props;
    return <SheetCloseDialog {...rest} />;
  }
  return <GenericCloseTicketDialog {...props} />;
}

function GenericCloseTicketDialog({
  subjectType,
  id,
  status,
  close,
  disabled,
  triggerClassName,
  triggerLabel,
  onClosed,
}: CloseTicketDialogProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const pendingApply = status === "approved";
  const notifiesPlayer = subjectType === "request";
  const defaultLabel = pendingApply ? "CLOSE & APPLY" : "CLOSE TICKET";
  const busy = close.isPending;

  const submit = () => {
    const trimmed = note.trim();
    close.mutate(
      { subjectType, id, data: trimmed ? { note: trimmed } : undefined },
      {
        onSuccess: () => {
          setOpen(false);
          setNote("");
          onClosed?.();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        if (!o) setNote("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          className={
            triggerClassName ??
            "rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs tracking-widest"
          }
          disabled={disabled}
          data-testid={`button-close-${subjectType}-${id}`}
        >
          {triggerLabel ?? defaultLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none border-border bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan uppercase">
            {pendingApply ? "Close & apply" : "Close ticket"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs leading-snug">
            {pendingApply
              ? "Finalizes the request and creates the lease / item / character."
              : "Archives this ticket as resolved."}
            {notifiesPlayer
              ? " Your message below is DM'd to the player with the decision."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`close-note-${subjectType}-${id}`} className="text-xs font-mono tracking-widest">
            {notifiesPlayer ? "MESSAGE TO PLAYER (OPTIONAL)" : "CLOSING NOTE (OPTIONAL)"}
          </Label>
          <Textarea
            id={`close-note-${subjectType}-${id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={4}
            className="rounded-none font-mono text-sm"
            placeholder={
              pendingApply
                ? "e.g. Approved — welcome to your new place!"
                : notifiesPlayer
                  ? "e.g. Rejected because ..."
                  : "Optional note for the audit trail"
            }
            data-testid={`input-close-note-${subjectType}-${id}`}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="rounded-none font-display text-xs tracking-widest"
            disabled={busy}
            onClick={() => setOpen(false)}
            data-testid={`button-cancel-close-${subjectType}-${id}`}
          >
            CANCEL
          </Button>
          <Button
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs tracking-widest"
            disabled={busy}
            onClick={submit}
            data-testid={`button-confirm-close-${subjectType}-${id}`}
          >
            {busy ? "WORKING..." : defaultLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Footer actions for resolved tickets: always offer Close; offer Reopen only
// for approved/rejected (cancelled is terminal-but-closeable, never reopenable).
export function LifecycleActions({
  subjectType,
  id,
  status,
  actions,
}: {
  subjectType: "edit" | "request" | "sheet";
  id: number;
  status: string;
  actions: ReturnType<typeof useReviewTicketActions>;
}) {
  // An APPROVED ticket is decided but its effect (the lease / inventory item /
  // new character) is NOT applied until the ticket is closed. Make that explicit
  // so staff don't assume "Approved" means done — that gap is why approved
  // off-map properties never showed up on a character.
  const pendingApply = status === "approved";
  return (
    <div className="space-y-2">
      {pendingApply ? (
        <p
          className="font-mono text-[11px] text-nc-yellow leading-snug"
          data-testid={`hint-close-to-apply-${subjectType}-${id}`}
        >
          Approved but not applied yet — click "Close &amp; apply" to finalize and create it.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <CloseTicketDialog
          subjectType={subjectType}
          id={id}
          status={status}
          close={actions.close}
          disabled={actions.busy}
        />
        {(status === "approved" || status === "rejected") && (
        <Button
          variant="outline"
          className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display text-xs tracking-widest"
          disabled={actions.busy}
          onClick={() => actions.reopen.mutate({ subjectType, id })}
          data-testid={`button-reopen-${subjectType}-${id}`}
        >
          REOPEN
        </Button>
        )}
      </div>
    </div>
  );
}

// Section wrapper rendering a labelled bucket of cards, or a quiet empty note.
export function BucketSection({
  bucket,
  count,
  children,
}: {
  bucket: LifecycleBucket;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" data-testid={`section-${bucket}`}>
      <h3 className="font-display tracking-widest text-nc-cyan text-sm flex items-center gap-2">
        {BUCKET_LABEL[bucket]}
        <span className="text-muted-foreground text-xs font-mono">({count})</span>
      </h3>
      {count === 0 ? (
        <p className="text-muted-foreground font-mono text-xs italic">Nothing here.</p>
      ) : (
        children
      )}
    </section>
  );
}
