import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListGuidebookImportReview,
  useRunGuidebookImport,
  useApplyGuidebookImportConflict,
  useDismissGuidebookImportConflict,
  getListGuidebookImportReviewQueryKey,
  getListGuidebookQueryKey,
  type GuidebookImportConflict,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Download, Inbox } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function GuidebookImportReview() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useListGuidebookImportReview();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListGuidebookImportReviewQueryKey() });
    qc.invalidateQueries({ queryKey: getListGuidebookQueryKey() });
  };

  const run = useRunGuidebookImport({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "Import complete",
          description: `${res.created} new · ${res.updated} updated · ${res.conflicts} conflict(s) · ${res.unchanged} unchanged${res.errors ? ` · ${res.errors} error(s)` : ""}`,
        });
      },
      onError: (err) => toast({ title: "Import failed", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
    },
  });

  const conflicts = (data ?? []) as GuidebookImportConflict[];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href="/guidebook">
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-guidebook-import-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> GUIDEBOOK
        </Button>
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-guidebook-import-title">
            <Download className="w-8 h-8 text-nc-yellow" /> GUIDEBOOK IMPORT
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            Pull the latest content from the linked Discord channels. Pages edited on the site won't be overwritten until you review the re-import below.
          </p>
        </div>
        <Button
          className="rounded-none bg-nc-yellow text-background font-display tracking-widest"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          data-testid="button-run-guidebook-import"
        >
          {run.isPending ? "IMPORTING..." : "RUN IMPORT"}
        </Button>
      </div>

      {run.data && run.data.sources.length > 0 && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader><CardTitle className="font-display tracking-widest text-sm">LAST RUN</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {run.data.sources.map((s, i) => (
              <div key={i} className="font-mono text-xs flex items-center gap-2" data-testid={`row-import-source-${i}`}>
                <span className={statusColor(s.status)}>{s.status.toUpperCase()}</span>
                <span className="text-foreground">{s.title}</span>
                <span className="text-muted-foreground">({s.sourceLabel})</span>
                {s.error && <span className="text-destructive">— {s.error}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="font-display text-xl tracking-widest mb-3">RE-IMPORT CONFLICTS</h2>
        {isLoading ? (
          <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>
        ) : conflicts.length === 0 ? (
          <div className="py-16 text-center border border-dashed border-border bg-card/30">
            <Inbox className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display text-xl">NO CONFLICTS</h3>
            <p className="font-mono text-sm text-muted-foreground mt-2">
              Edited pages with a fresh re-import will appear here for review.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {conflicts.map((c) => (
              <ConflictCard key={c.id} conflict={c} onChanged={invalidate} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "created": return "text-nc-green";
    case "updated": return "text-nc-cyan";
    case "conflict": return "text-nc-yellow";
    case "error": return "text-destructive";
    default: return "text-muted-foreground";
  }
}

function ConflictCard({ conflict, onChanged }: { conflict: GuidebookImportConflict; onChanged: () => void }) {
  const { toast } = useToast();

  const apply = useApplyGuidebookImportConflict({
    mutation: {
      onSuccess: () => { onChanged(); toast({ title: "Re-import applied", description: "The live page now matches Discord." }); },
      onError: (err) => toast({ title: "Could not apply", description: m(err), variant: "destructive" }),
    },
  });
  const dismiss = useDismissGuidebookImportConflict({
    mutation: {
      onSuccess: () => { onChanged(); toast({ title: "Re-import dismissed", description: "On-site edits kept." }); },
      onError: (err) => toast({ title: "Could not dismiss", description: m(err), variant: "destructive" }),
    },
  });

  const busy = apply.isPending || dismiss.isPending;

  return (
    <Card className="rounded-none border-nc-yellow/40 bg-card/50" data-testid={`card-guidebook-conflict-${conflict.id}`}>
      <CardHeader>
        <CardTitle className="font-display text-lg">{conflict.title}</CardTitle>
        <CardDescription className="font-mono text-xs">
          Section: {conflict.section}
          {conflict.incomingSourceLabel ? ` · Source: ${conflict.incomingSourceLabel}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Current (on site)</Label>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-words max-h-72 overflow-y-auto border border-border bg-background/40 p-3" data-testid={`text-conflict-current-${conflict.id}`}>
              {conflict.currentBody || "(empty)"}
            </pre>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-widest font-display text-nc-yellow">Incoming (Discord)</Label>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-words max-h-72 overflow-y-auto border border-nc-yellow/30 bg-background/40 p-3" data-testid={`text-conflict-incoming-${conflict.id}`}>
              {conflict.incomingBody || "(empty)"}
            </pre>
          </div>
        </div>

        <div className="flex gap-2 pt-3 border-t border-border/40">
          <Button
            className="rounded-none flex-1 bg-nc-yellow text-background font-display tracking-widest"
            disabled={busy}
            onClick={() => apply.mutate({ id: conflict.id })}
            data-testid={`button-conflict-apply-${conflict.id}`}
          >
            {apply.isPending ? "APPLYING..." : "OVERWRITE WITH IMPORT"}
          </Button>
          <Button
            variant="outline"
            className="rounded-none flex-1 border-nc-cyan text-nc-cyan font-display tracking-widest"
            disabled={busy}
            onClick={() => dismiss.mutate({ id: conflict.id })}
            data-testid={`button-conflict-dismiss-${conflict.id}`}
          >
            {dismiss.isPending ? "..." : "KEEP SITE EDITS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function m(err: unknown): string {
  return err instanceof Error ? err.message : "Please try again.";
}
