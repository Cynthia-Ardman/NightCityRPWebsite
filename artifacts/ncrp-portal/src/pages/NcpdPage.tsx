import { useState } from "react";
import { Link } from "wouter";
import {
  useNcpdSearchCharacters,
  getNcpdSearchCharactersQueryKey,
  useListNcpdReports,
  useListNcpdWarrants,
  getListNcpdWarrantsQueryKey,
  type NcpdCharacterSummary,
} from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import NcpdRecordPanel, { warrantStatusClass } from "@/components/NcpdRecordPanel";
import { Shield, FileText, AlertTriangle, Search } from "lucide-react";

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

const TAB_TRIGGER_CLASS =
  "flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]";

// NCPD hub — arrest reports feed, active warrants board, and a character
// lookup that opens the full per-character record. Access is gated to NCPD
// officers, the commissioner, fixers, and admins (both here and server-side).
export default function NcpdPage() {
  const me = useEffectiveMe();
  const canAccess = !!(me.data?.isNcpd || me.data?.isFixer || me.data?.isAdmin);

  if (me.isLoading) {
    return <div className="text-nc-cyan font-display animate-pulse py-12 text-center">VERIFYING CLEARANCE...</div>;
  }
  if (!canAccess) {
    return (
      <div className="max-w-7xl mx-auto py-12 text-center space-y-2">
        <Shield className="w-10 h-10 mx-auto text-destructive" />
        <p className="font-display tracking-widest text-destructive">ACCESS DENIED</p>
        <p className="font-mono text-sm text-muted-foreground">NCPD clearance required.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-ncpd-title">
          <Shield className="w-8 h-8 text-nc-cyan" /> NCPD DATABASE
        </h1>
        <p className="font-mono text-muted-foreground mt-2">Night City Police Department — internal records system.</p>
      </div>

      <Tabs defaultValue="warrants" className="w-full">
        <TabsList className="bg-card border border-border rounded-none p-0 h-auto flex overflow-x-auto w-full max-w-full no-scrollbar">
          <TabsTrigger value="warrants" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-warrants">
            <AlertTriangle className="w-4 h-4 mr-2 hidden sm:inline" /> Warrants
          </TabsTrigger>
          <TabsTrigger value="reports" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-reports">
            <FileText className="w-4 h-4 mr-2 hidden sm:inline" /> Reports
          </TabsTrigger>
          <TabsTrigger value="lookup" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-lookup">
            <Search className="w-4 h-4 mr-2 hidden sm:inline" /> Lookup
          </TabsTrigger>
        </TabsList>
        <div className="mt-6">
          <TabsContent value="warrants" className="outline-none focus:ring-0">
            <WarrantsBoard />
          </TabsContent>
          <TabsContent value="reports" className="outline-none focus:ring-0">
            <ReportsFeed />
          </TabsContent>
          <TabsContent value="lookup" className="outline-none focus:ring-0">
            <CharacterLookup />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

const WARRANT_FILTERS = ["open", "served", "revoked", "all"] as const;
type WarrantFilter = (typeof WARRANT_FILTERS)[number];

function WarrantsBoard() {
  // The board defaults to OPEN warrants — that is the actionable list an
  // officer walks in for; served/revoked stay one click away.
  const [filter, setFilter] = useState<WarrantFilter>("open");
  const params = filter === "all" ? undefined : { status: filter };
  const { data, isLoading } = useListNcpdWarrants(params, {
    query: { queryKey: getListNcpdWarrantsQueryKey(params) },
  });
  const rows = data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex gap-1 flex-wrap" data-testid="filter-warrant-status">
        {WARRANT_FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            className="rounded-none font-display uppercase text-xs"
            onClick={() => setFilter(f)}
            data-testid={`button-warrant-filter-${f}`}
          >
            {f}
          </Button>
        ))}
      </div>
      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SCANNING...</div>
      ) : !rows.length ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-8 font-mono text-muted-foreground text-center">
            {filter === "all" ? "No warrants on file." : `No ${filter} warrants on file.`}
          </CardContent>
        </Card>
      ) : (
        rows.map((w) => (
        <Card key={w.id} className="rounded-none border-border bg-card/50" data-testid={`card-ncpd-board-warrant-${w.id}`}>
          <CardContent className="py-4 flex items-start justify-between gap-3 flex-wrap">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={`rounded-none uppercase font-display text-[10px] ${warrantStatusClass(w.status)}`}>
                  {w.status}
                </Badge>
                <Link href={`/ncpd/characters/${w.characterId}`} className="font-display tracking-wider text-nc-cyan hover:underline">
                  {w.characterName ?? `Character #${w.characterId}`}
                </Link>
              </div>
              <p className="font-mono text-sm text-foreground/90">{w.reason}</p>
              <p className="font-mono text-xs text-muted-foreground">
                Issued {fmtDate(w.createdAt)}
                {w.issuedByName ? ` by ${w.issuedByName}` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
        ))
      )}
    </div>
  );
}

function ReportsFeed() {
  const { data, isLoading } = useListNcpdReports();
  const rows = data ?? [];
  if (isLoading) return <div className="text-nc-cyan font-display animate-pulse">SCANNING...</div>;
  if (!rows.length) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="py-8 font-mono text-muted-foreground text-center">No arrest reports on file.</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Card key={r.id} className="rounded-none border-border bg-card/50" data-testid={`card-ncpd-board-report-${r.id}`}>
          <CardContent className="py-4 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/ncpd/characters/${r.characterId}`} className="font-display tracking-wider text-nc-cyan hover:underline">
                {r.characterName ?? `Character #${r.characterId}`}
              </Link>
              <span className="font-display text-foreground">{r.title}</span>
            </div>
            {r.charges && (
              <p className="font-mono text-xs">
                <span className="text-muted-foreground uppercase">Charges:</span> <span className="text-nc-yellow">{r.charges}</span>
              </p>
            )}
            <p className="font-mono text-xs text-muted-foreground">
              Filed {fmtDate(r.createdAt)}
              {r.officerName ? ` by ${r.officerName}` : ""}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CharacterLookup() {
  const [q, setQ] = useState("");
  // Enable at 2+ chars for names, but allow single-character queries when the
  // input is numeric — officers look characters up by character number (e.g. "4").
  const trimmed = q.trim();
  const enabled = trimmed.length >= 2 || /^\d+$/.test(trimmed);
  const { data, isLoading } = useNcpdSearchCharacters(
    { q: q.trim() },
    { query: { enabled, queryKey: getNcpdSearchCharactersQueryKey({ q: q.trim() }) } },
  );
  const rows: NcpdCharacterSummary[] = data ?? [];
  return (
    <div className="space-y-4">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search characters by name…"
        className="rounded-none max-w-md"
        data-testid="input-ncpd-search"
      />
      {!enabled ? (
        <p className="font-mono text-sm text-muted-foreground">Enter at least 2 characters to search.</p>
      ) : isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SEARCHING...</div>
      ) : !rows.length ? (
        <p className="font-mono text-sm text-muted-foreground">No matches.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((c) => (
            <Link key={c.id} href={`/ncpd/characters/${c.id}`}>
              <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full" data-testid={`card-ncpd-char-${c.id}`}>
                <CardContent className="py-4 space-y-1">
                  <p className="font-display tracking-wider text-foreground">{c.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {c.kind.toUpperCase()}
                    {c.archetype ? ` · ${c.archetype}` : ""}
                    {c.archived ? " · ARCHIVED" : ""}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
