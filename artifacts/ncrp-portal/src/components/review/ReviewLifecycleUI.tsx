import type { ReactNode } from "react";
import {
  useCloseReviewTicket,
  useReopenReviewTicket,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { BUCKET_LABEL, type LifecycleBucket } from "@/lib/reviewLifecycle";

// Tiny magenta dot flagging a ticket the current reviewer hasn't opened since
// its last activity. Driven by /review/unseen-ids.
export function UnseenDot({ show, testid }: { show: boolean; testid: string }) {
  if (!show) return null;
  return (
    <span
      className="w-2.5 h-2.5 rounded-full bg-nc-magenta shadow-[0_0_6px_rgba(255,0,128,0.8)] shrink-0"
      title="New activity"
      data-testid={testid}
    />
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
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs tracking-widest"
        disabled={actions.busy}
        onClick={() => actions.close.mutate({ subjectType, id })}
        data-testid={`button-close-${subjectType}-${id}`}
      >
        CLOSE TICKET
      </Button>
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">{children}</div>
      )}
    </section>
  );
}
