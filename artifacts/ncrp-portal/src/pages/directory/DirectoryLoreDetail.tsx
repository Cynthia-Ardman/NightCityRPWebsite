import { Link, useParams } from "wouter";
import { useGetLore, useDeleteLore, getListLoreQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Pencil, Lock, ExternalLink, Trash2, ArrowLeft } from "lucide-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useToast } from "@/hooks/use-toast";

const CATEGORY_BADGE: Record<string, string> = {
  corporation: "border-nc-cyan text-nc-cyan",
  gang: "border-destructive text-destructive",
  faction: "border-nc-yellow text-nc-yellow",
  misc: "border-muted-foreground text-muted-foreground",
};

export default function DirectoryLoreDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useGetLore(Number(id));
  const { data: me } = useAuthMe();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isAdmin = !!me?.isAdmin;
  const isStaff = !!me && (me.isAdmin || me.isFixer);

  const del = useDeleteLore({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListLoreQueryKey() });
        toast({ title: "Lore entry deleted" });
        navigate("/directory/lore");
      },
      onError: (err) =>
        toast({ title: "Could not delete", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" }),
    },
  });

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">LORE ENTRY NOT FOUND</div>;

  const sources = data.sources ?? [];

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <Link href="/directory/lore">
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-lore-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> ALL LORE
        </Button>
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Badge variant="outline" className={`rounded-none uppercase ${CATEGORY_BADGE[data.category]}`}>{data.category}</Badge>
          <h1 className="text-4xl font-display mt-2" data-testid="text-lore-name">{data.name}</h1>
          {data.aliases.length > 0 && (
            <p className="font-mono text-xs text-muted-foreground mt-1">a.k.a. {data.aliases.join(", ")}</p>
          )}
          {data.responsibleFixer && (
            <p className="font-mono text-xs text-nc-cyan mt-2" data-testid="text-lore-lead">STORY LEAD: {data.responsibleFixer}</p>
          )}
        </div>
        {isStaff && (
          <div className="flex gap-2 shrink-0">
            <Link href={`/directory/lore/${data.id}/edit`}>
              <Button className="rounded-none bg-nc-cyan text-background font-display" data-testid="button-lore-edit">
                <Pencil className="w-4 h-4 mr-2" /> {isAdmin ? "EDIT" : "PROPOSE EDIT"}
              </Button>
            </Link>
            {isAdmin && (
              <Button
                variant="outline"
                className="rounded-none border-destructive text-destructive font-display"
                onClick={() => setConfirmDelete(true)}
                data-testid="button-lore-delete"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      {data.summary && (
        <p className="font-mono text-sm text-foreground/90 border-l-2 border-nc-cyan pl-4" data-testid="text-lore-summary">{data.summary}</p>
      )}

      {data.imageUrl && (
        <div className="border border-nc-cyan/20 bg-card/30 p-1">
          <img
            src={data.imageUrl}
            alt={data.name}
            className="w-full max-h-[32rem] object-contain"
            loading="lazy"
            data-testid="img-lore-detail"
          />
        </div>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">OVERVIEW</CardTitle></CardHeader>
        <CardContent className="font-mono text-sm whitespace-pre-wrap leading-relaxed" data-testid="text-lore-public-body">
          {data.publicBody?.trim() ? data.publicBody : <span className="text-muted-foreground italic">No public information recorded.</span>}
        </CardContent>
      </Card>

      {data.canViewFixer ? (
        data.fixerBody?.trim() ? (
          <Card className="rounded-none border-nc-yellow/40 bg-nc-yellow/5">
            <CardHeader>
              <CardTitle className="font-display tracking-widest text-nc-yellow flex items-center gap-2">
                <Lock className="w-4 h-4" /> FIXER-ONLY
              </CardTitle>
            </CardHeader>
            <CardContent className="font-mono text-sm whitespace-pre-wrap leading-relaxed" data-testid="text-lore-fixer-body">
              {data.fixerBody}
            </CardContent>
          </Card>
        ) : null
      ) : data.hasFixerContent ? (
        <Card className="rounded-none border-dashed border-nc-yellow/30 bg-card/30">
          <CardContent className="py-6 font-mono text-xs text-muted-foreground flex items-center gap-2" data-testid="text-lore-fixer-locked">
            <Lock className="w-4 h-4 text-nc-yellow" /> This entry has fixer-only intel. Restricted to staff.
          </CardContent>
        </Card>
      ) : null}

      {data.canViewFixer && sources.length > 0 && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader><CardTitle className="font-display tracking-widest">SOURCES</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {sources.map((s, i) => (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 font-mono text-xs text-nc-cyan hover:underline"
                data-testid={`link-lore-source-${i}`}
              >
                <ExternalLink className="w-3 h-3" /> {s.label}
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="rounded-none border-destructive/40 bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-destructive">DELETE — {data.name.toUpperCase()}</DialogTitle>
            <DialogDescription className="font-mono text-xs">This permanently removes the lore entry. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="rounded-none font-display" onClick={() => setConfirmDelete(false)}>CANCEL</Button>
            <Button
              variant="outline"
              className="rounded-none font-display tracking-widest border-destructive text-destructive hover:bg-destructive/10"
              disabled={del.isPending}
              onClick={() => del.mutate({ id: data.id })}
              data-testid="button-confirm-lore-delete"
            >
              {del.isPending ? "DELETING..." : "DELETE"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
