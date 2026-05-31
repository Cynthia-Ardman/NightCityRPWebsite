import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListLoreImportDrafts,
  useRunLoreImport,
  useUpdateLoreImportDraft,
  useApproveLoreImportDraft,
  useDiscardLoreImportDraft,
  getListLoreImportDraftsQueryKey,
  getListLoreQueryKey,
  type LoreImportDraft,
  type LoreImportDraftUpdate,
  LoreImportDraftUpdateProposedCategory,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Download, Inbox, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Category = (typeof LoreImportDraftUpdateProposedCategory)[keyof typeof LoreImportDraftUpdateProposedCategory];

export default function LoreImportReview() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useListLoreImportDrafts({ status: "pending" });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListLoreImportDraftsQueryKey() });
    qc.invalidateQueries({ queryKey: getListLoreQueryKey() });
  };

  const run = useRunLoreImport({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "Import scan complete",
          description: `Scanned ${res.scanned} · ${res.created} new drafts · ${res.duplicates} duplicates${res.errors.length ? ` · ${res.errors.length} errors` : ""}`,
        });
      },
      onError: (err) => toast({ title: "Import failed", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
    },
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <Link href="/directory/lore">
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-import-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> ALL LORE
        </Button>
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-import-title">
            <Download className="w-8 h-8 text-nc-yellow" /> LORE IMPORT QUEUE
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            Pull entries from the Discord lore forum and linked Google Docs, then review before publishing.
          </p>
        </div>
        <Button
          className="rounded-none bg-nc-yellow text-background font-display tracking-widest"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          data-testid="button-run-import"
        >
          {run.isPending ? "SCANNING..." : "RUN IMPORT SCAN"}
        </Button>
      </div>

      {isLoading ? (
        <div className="font-display text-nc-cyan animate-pulse">LOADING DRAFTS...</div>
      ) : !data?.length ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30">
          <Inbox className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="font-display text-xl">NO DRAFTS PENDING</h3>
          <p className="font-mono text-sm text-muted-foreground mt-2">Run an import scan to populate the queue.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((d) => (
            <DraftCard key={d.id} draft={d} onChanged={invalidate} />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({ draft, onChanged }: { draft: LoreImportDraft; onChanged: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(draft.proposedName);
  const [category, setCategory] = useState<Category>(draft.proposedCategory);
  const [fixer, setFixer] = useState(draft.proposedFixer ?? "");
  const [summary, setSummary] = useState(draft.summary ?? "");
  const [publicBody, setPublicBody] = useState(draft.publicBody);
  const [fixerBody, setFixerBody] = useState(draft.fixerBody ?? "");

  const update = useUpdateLoreImportDraft({
    mutation: {
      onSuccess: () => { onChanged(); toast({ title: "Draft saved" }); },
      onError: (err) => toast({ title: "Could not save", description: m(err), variant: "destructive" }),
    },
  });
  const approve = useApproveLoreImportDraft({
    mutation: {
      onSuccess: () => { onChanged(); toast({ title: "Published to lore directory" }); },
      onError: (err) => toast({ title: "Could not publish", description: m(err), variant: "destructive" }),
    },
  });
  const discard = useDiscardLoreImportDraft({
    mutation: {
      onSuccess: () => { onChanged(); toast({ title: "Draft discarded" }); },
      onError: (err) => toast({ title: "Could not discard", description: m(err), variant: "destructive" }),
    },
  });

  const saveFirst = (): LoreImportDraftUpdate => ({
    proposedName: name.trim(),
    proposedCategory: category,
    proposedFixer: fixer.trim() || null,
    summary: summary.trim() || null,
    publicBody,
    fixerBody: fixerBody.trim() || null,
  });

  const busy = update.isPending || approve.isPending || discard.isPending;

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid={`card-draft-${draft.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="font-display text-xl">{draft.proposedName}</CardTitle>
          {draft.suggestedMergeEntryId && (
            <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[10px]" data-testid={`badge-merge-${draft.id}`}>
              POSSIBLE DUPLICATE: {draft.suggestedMergeName}
            </Badge>
          )}
        </div>
        <CardDescription className="font-mono text-xs">Group: {draft.groupKey}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <F label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-none font-mono" data-testid={`input-draft-name-${draft.id}`} /></F>
          <F label="Category">
            <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
              <SelectTrigger className="rounded-none font-mono" data-testid={`select-draft-category-${draft.id}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="corporation">Corporation</SelectItem>
                <SelectItem value="gang">Gang</SelectItem>
                <SelectItem value="faction">Faction</SelectItem>
                <SelectItem value="misc">Miscellaneous</SelectItem>
              </SelectContent>
            </Select>
          </F>
          <F label="Story Lead"><Input value={fixer} onChange={(e) => setFixer(e.target.value)} className="rounded-none font-mono" data-testid={`input-draft-fixer-${draft.id}`} /></F>
        </div>
        <F label="Summary"><Input value={summary} onChange={(e) => setSummary(e.target.value)} className="rounded-none font-mono" data-testid={`input-draft-summary-${draft.id}`} /></F>
        <F label="Public Body"><Textarea value={publicBody} onChange={(e) => setPublicBody(e.target.value)} rows={6} className="rounded-none font-mono text-xs" data-testid={`input-draft-public-${draft.id}`} /></F>
        <F label="Fixer-Only Body"><Textarea value={fixerBody} onChange={(e) => setFixerBody(e.target.value)} rows={4} className="rounded-none font-mono text-xs" data-testid={`input-draft-fixer-body-${draft.id}`} /></F>

        {draft.sources.length > 0 && (
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Sources</Label>
            {draft.sources.map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 font-mono text-xs text-nc-cyan hover:underline" data-testid={`link-draft-source-${draft.id}-${i}`}>
                <ExternalLink className="w-3 h-3" /> {s.label}
              </a>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-3 border-t border-border/40">
          <Button
            variant="outline"
            className="rounded-none border-nc-cyan text-nc-cyan font-display"
            disabled={busy}
            onClick={() => update.mutate({ id: draft.id, data: saveFirst() })}
            data-testid={`button-draft-save-${draft.id}`}
          >
            {update.isPending ? "SAVING..." : "SAVE"}
          </Button>
          <Button
            className="rounded-none flex-1 bg-nc-green text-background font-display tracking-widest"
            disabled={busy}
            onClick={async () => {
              await update.mutateAsync({ id: draft.id, data: saveFirst() });
              approve.mutate({ id: draft.id });
            }}
            data-testid={`button-draft-approve-${draft.id}`}
          >
            {approve.isPending ? "PUBLISHING..." : "PUBLISH"}
          </Button>
          <Button
            variant="outline"
            className="rounded-none border-destructive text-destructive font-display"
            disabled={busy}
            onClick={() => discard.mutate({ id: draft.id })}
            data-testid={`button-draft-discard-${draft.id}`}
          >
            DISCARD
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{label}</Label>
      {children}
    </div>
  );
}

function m(err: unknown): string {
  return err instanceof Error ? err.message : "Please try again.";
}
