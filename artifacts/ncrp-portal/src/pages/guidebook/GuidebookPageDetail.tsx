import { Link, useParams, useLocation, Redirect } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { extractToc } from "@/lib/markdownToc";
import { List } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetGuidebookPage, useDeleteGuidebookPage, getListGuidebookQueryKey } from "@workspace/api-client-react";
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
import Markdown from "@/components/Markdown";
import FaqAccordion from "@/components/FaqAccordion";
import BecomeNpcButton from "@/components/BecomeNpcButton";
import { Pencil, Trash2, ArrowLeft, ExternalLink, FileEdit } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiError";

export default function GuidebookPageDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useGetGuidebookPage(Number(id));
  const { data: me } = useEffectiveMe();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isAdmin = !!me?.isAdmin;
  const isStaff = !!me && (me.isAdmin || me.isFixer);

  const del = useDeleteGuidebookPage({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListGuidebookQueryKey() });
        toast({ title: "Guidebook page deleted" });
        navigate("/guidebook");
      },
      onError: (err) =>
        toast({ title: "Could not delete", description: apiErrorMessage(err, "Try again."), variant: "destructive" }),
    },
  });

  // Table of contents from the page's markdown headings; anchors are rendered
  // by <Markdown headingAnchors> with the same slug rules, so ids always match.
  const toc = useMemo(() => extractToc(data?.body ?? ""), [data?.body]);
  const showToc = toc.length >= 3 && data?.slug !== "faq";

  // Deep-link support: /guidebook/:id#<heading-id> scrolls to that heading once
  // the body has rendered.
  useEffect(() => {
    if (!data) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const t = window.setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => window.clearTimeout(t);
  }, [data]);

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">GUIDEBOOK PAGE NOT FOUND</div>;

  // The legacy "Schedule & Events" page is retired — its content now lives on the
  // Calendar. Redirect any visit (direct URL, guidebook list, channel-mention
  // link) regardless of the per-environment page id, keyed on the stable slug.
  if (data.slug === "schedule-events") return <Redirect to="/directory/calendar" replace />;

  const sources = data.sources ?? [];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href="/guidebook">
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-guidebook-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> GUIDEBOOK
        </Button>
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-guidebook-name">{data.title}</h1>
          {data.description && (
            <p className="font-mono text-sm text-muted-foreground mt-2">{data.description}</p>
          )}
          {isStaff && data.editedSinceImport && (
            <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[10px] mt-2" data-testid="badge-guidebook-edited">
              <FileEdit className="w-3 h-3 mr-1" /> EDITED ON SITE
            </Badge>
          )}
        </div>
        {isStaff && (
          <div className="flex gap-2 shrink-0">
            <Link href={`/guidebook/${data.id}/edit`}>
              <Button className="rounded-none bg-nc-cyan text-background font-display" data-testid="button-guidebook-edit">
                <Pencil className="w-4 h-4 mr-2" /> {isAdmin ? "EDIT" : "PROPOSE EDIT"}
              </Button>
            </Link>
            {isAdmin && (
              <Button
                variant="outline"
                className="rounded-none border-destructive text-destructive font-display"
                onClick={() => setConfirmDelete(true)}
                data-testid="button-guidebook-delete"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      {data.slug === "npc-acting" && <BecomeNpcButton variant="guidebook" />}

      {data.images.length > 0 && (
        <div className="space-y-3">
          {data.images.map((src, i) => (
            <div key={i} className="border border-nc-cyan/20 bg-card/30 p-1">
              <img
                src={src}
                alt={`${data.title} ${i + 1}`}
                className="w-full max-h-[32rem] object-contain"
                loading="lazy"
                data-testid={`img-guidebook-${i}`}
              />
            </div>
          ))}
        </div>
      )}

      <div className={showToc ? "lg:grid lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-6 lg:items-start" : undefined}>
        {showToc && (
          <nav
            aria-label="On this page"
            className="mb-4 lg:mb-0 lg:order-2 lg:sticky lg:top-20 border border-nc-cyan/30 bg-card/40 p-4"
            data-testid="nav-guidebook-toc"
          >
            <p className="font-display text-xs tracking-widest text-nc-cyan flex items-center gap-2 mb-2">
              <List className="w-3.5 h-3.5" /> ON THIS PAGE
            </p>
            <ul className="space-y-1">
              {toc.map((h) => (
                <li key={h.id} style={{ paddingLeft: `${Math.max(0, h.level - 1) * 12}px` }}>
                  <a
                    href={`#${h.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                      history.replaceState(null, "", `#${h.id}`);
                    }}
                    className="font-mono text-xs text-muted-foreground hover:text-nc-cyan transition-colors block"
                    data-testid={`link-toc-${h.id}`}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <Card className="rounded-none border-border bg-card/50 lg:order-1 min-w-0">
          <CardContent className="py-6">
            {data.body?.trim() ? (
              <div data-testid="text-guidebook-body">
                {data.slug === "faq" ? (
                  <FaqAccordion body={data.body} />
                ) : (
                  <Markdown headingAnchors className="font-mono text-sm leading-relaxed text-foreground/90">
                    {data.body}
                  </Markdown>
                )}
              </div>
            ) : (
              <span className="font-mono text-sm text-muted-foreground italic">No content recorded.</span>
            )}
          </CardContent>
        </Card>
      </div>

      {isStaff && sources.length > 0 && (
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
                data-testid={`link-guidebook-source-${i}`}
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
            <DialogTitle className="font-display tracking-widest text-destructive">DELETE — {data.title.toUpperCase()}</DialogTitle>
            <DialogDescription className="font-mono text-xs">This permanently removes the guidebook page. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="rounded-none font-display" onClick={() => setConfirmDelete(false)}>CANCEL</Button>
            <Button
              variant="outline"
              className="rounded-none font-display tracking-widest border-destructive text-destructive hover:bg-destructive/10"
              disabled={del.isPending}
              onClick={() => del.mutate({ id: data.id })}
              data-testid="button-confirm-guidebook-delete"
            >
              {del.isPending ? "DELETING..." : "DELETE"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
