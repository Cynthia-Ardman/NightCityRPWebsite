import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useListGuidebook, type GuidebookPage } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Markdown from "@/components/Markdown";
import { BookMarked, Plus, Download, FileEdit, FileText, Crosshair } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

function snippet(body: string): string {
  const text = body.replace(/[#*_`>\-]/g, "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? text.slice(0, 180) + "…" : text;
}

export default function DirectoryGuidebook() {
  const { data: me } = useEffectiveMe();
  const isStaff = !!me && (me.isAdmin || me.isFixer);
  const isAdmin = !!me?.isAdmin;
  const [q, setQ] = useState("");

  const { data, isLoading } = useListGuidebook({ ...(q.trim() ? { q: q.trim() } : {}) });

  const sections = useMemo(
    () => (data?.sections ?? []).filter((s) => s.pages.length > 0),
    [data],
  );
  const totalPages = useMemo(
    () => (data?.sections ?? []).reduce((n, s) => n + s.pages.length, 0),
    [data],
  );

  // The Weapons reference is a code-defined page (not a DB row), so it isn't in
  // the API sections. Surface it as a static "Reference" card, hidden only when
  // an active search clearly doesn't match it.
  const term = q.trim().toLowerCase();
  const showWeaponsRef = !term || /gun|weapon|power|tech|smart|caliber|ammo|fire/.test(term);

  // Deep-link support: when arriving at /guidebook#<section-key> (e.g. from the
  // onboarding banner or the new-character help links), scroll the matching
  // section into view once the content has loaded.
  useEffect(() => {
    if (isLoading) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const el = document.getElementById(`guidebook-section-${hash}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [isLoading, sections]);

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-guidebook-title">
            <BookMarked className="w-8 h-8 text-nc-cyan" /> GUIDEBOOK
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            Everything you need to know about playing on Night City RP — onboarding, rules, systems and setup.
          </p>
        </div>
        {isStaff && (
          <div className="flex gap-2 flex-wrap">
            <Link href="/guidebook/mine">
              <Button variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-display" data-testid="button-guidebook-mine">
                <FileText className="w-4 h-4 mr-2" /> MY SUBMISSIONS
              </Button>
            </Link>
            {isAdmin && (
              <Link href="/guidebook/import">
                <Button variant="outline" className="rounded-none border-nc-yellow text-nc-yellow font-display" data-testid="button-guidebook-import">
                  <Download className="w-4 h-4 mr-2" /> IMPORT
                </Button>
              </Link>
            )}
            <Link href="/guidebook/new">
              <Button className="rounded-none bg-nc-cyan text-background font-display" data-testid="button-guidebook-new">
                <Plus className="w-4 h-4 mr-2" /> {isAdmin ? "NEW PAGE" : "PROPOSE PAGE"}
              </Button>
            </Link>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the guidebook..."
          className="rounded-none font-mono md:max-w-md"
          data-testid="input-guidebook-search"
        />
      </div>

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">LOADING GUIDEBOOK...</div>
      ) : sections.length === 0 && !showWeaponsRef ? (
        <Empty searching={!!q.trim()} />
      ) : (
        <div className="space-y-8">
          {showWeaponsRef && <ReferenceSection />}
          {sections.map((s) => (
            <section key={s.key} id={`guidebook-section-${s.key}`} className="scroll-mt-20" data-testid={`section-guidebook-${s.key}`}>
              <div className="border-l-2 border-nc-cyan pl-4 mb-4">
                <h2 className="font-display text-2xl tracking-widest text-foreground">{s.label.toUpperCase()}</h2>
                {s.description && <p className="font-mono text-xs text-muted-foreground mt-1">{s.description}</p>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {s.pages.map((p) => (
                  <PageCard key={p.id} page={p} isStaff={isStaff} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {!isLoading && sections.length > 0 && (
        <p className="font-mono text-[10px] text-muted-foreground/60 text-center pt-4">
          {totalPages} page{totalPages === 1 ? "" : "s"} on record
        </p>
      )}
    </div>
  );
}

function PageCard({ page, isStaff }: { page: GuidebookPage; isStaff: boolean }) {
  return (
    <Link href={`/guidebook/${page.id}`}>
      <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full flex flex-col" data-testid={`card-guidebook-${page.id}`}>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="font-display text-lg">{page.title}</CardTitle>
            {isStaff && page.editedSinceImport && (
              <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[10px] shrink-0" data-testid={`badge-guidebook-edited-${page.id}`}>
                <FileEdit className="w-3 h-3 mr-1" /> EDITED
              </Badge>
            )}
          </div>
          {page.description && (
            <CardDescription className="font-mono text-xs">{page.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="mt-auto">
          <p className="text-xs font-mono text-muted-foreground line-clamp-3">{snippet(page.body) || "No content yet."}</p>
          {isStaff && page.hasPendingImport && (
            <p className="font-mono text-[10px] text-nc-yellow mt-2" data-testid={`text-guidebook-conflict-${page.id}`}>
              Re-import awaiting review
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function ReferenceSection() {
  return (
    <section id="guidebook-section-reference" className="scroll-mt-20" data-testid="section-guidebook-reference">
      <div className="border-l-2 border-nc-cyan pl-4 mb-4">
        <h2 className="font-display text-2xl tracking-widest text-foreground">REFERENCE</h2>
        <p className="font-mono text-xs text-muted-foreground mt-1">Quick-reference guides for in-game systems.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/guidebook/weapons">
          <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full flex flex-col" data-testid="card-guidebook-weapons">
            <CardHeader>
              <CardTitle className="font-display text-lg flex items-center gap-2">
                <Crosshair className="w-5 h-5 text-nc-cyan" /> Weapons &amp; Guns
              </CardTitle>
              <CardDescription className="font-mono text-xs">
                Gun types, power tiers, restrictions and calibers explained.
              </CardDescription>
            </CardHeader>
            <CardContent className="mt-auto">
              <p className="text-xs font-mono text-muted-foreground line-clamp-3">
                How Power, Tech and Smart guns behave, what each power level means, and how to acquire restricted weapons.
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </section>
  );
}

function Empty({ searching }: { searching: boolean }) {
  return (
    <div className="py-20 text-center border border-dashed border-border bg-card/30">
      <BookMarked className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
      <h3 className="font-display text-xl">{searching ? "NO MATCHES" : "GUIDEBOOK IS EMPTY"}</h3>
      <p className="font-mono text-sm text-muted-foreground mt-2">
        {searching ? "Try a different search term." : "Run an import to populate the guidebook."}
      </p>
    </div>
  );
}
