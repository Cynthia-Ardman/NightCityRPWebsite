import { formatDate } from "@/lib/format";
import { apiErrorMessage } from "@/lib/apiError";
import { useState } from "react";
import { Link } from "wouter";
import {
  useListNcpdReports,
  useListNcpdWarrants,
  getListNcpdWarrantsQueryKey,
  useListNcpdOfficers,
  useCreateNcpdWarrant,
  useCreateNcpdFine,
  useListNcpdFines,
  getListNcpdFinesQueryKey,
  getGetNcpdRecordQueryKey,
  type NcpdCharacterSummary,
  type NcpdOfficerCharacter,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import NcpdRecordPanel, { warrantStatusClass } from "@/components/NcpdRecordPanel";
import NcpdCaseBoard from "@/components/NcpdCaseBoard";
import NcpdCharacterSearch from "@/components/NcpdCharacterSearch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Shield, FileText, AlertTriangle, Search, Users, Star, UserSearch, FolderOpen, Plus, X, Banknote } from "lucide-react";

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return formatDate(d);
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
          <TabsTrigger value="cases" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-cases">
            <FolderOpen className="w-4 h-4 mr-2 hidden sm:inline" /> Cases
          </TabsTrigger>
          <TabsTrigger value="fines" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-fines">
            <Banknote className="w-4 h-4 mr-2 hidden sm:inline" /> Fines
          </TabsTrigger>
          <TabsTrigger value="lookup" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-lookup">
            <Search className="w-4 h-4 mr-2 hidden sm:inline" /> Lookup
          </TabsTrigger>
          <TabsTrigger value="officers" className={TAB_TRIGGER_CLASS} data-testid="tab-ncpd-officers">
            <Users className="w-4 h-4 mr-2 hidden sm:inline" /> Officers
          </TabsTrigger>
        </TabsList>
        <div className="mt-6">
          <TabsContent value="warrants" className="outline-none focus:ring-0">
            <WarrantsBoard />
          </TabsContent>
          <TabsContent value="reports" className="outline-none focus:ring-0">
            <ReportsFeed />
          </TabsContent>
          <TabsContent value="cases" className="outline-none focus:ring-0">
            <NcpdCaseBoard />
          </TabsContent>
          <TabsContent value="fines" className="outline-none focus:ring-0">
            <IssueFineSection />
          </TabsContent>
          <TabsContent value="lookup" className="outline-none focus:ring-0">
            <CharacterLookup />
          </TabsContent>
          <TabsContent value="officers" className="outline-none focus:ring-0">
            <OfficersRoster />
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
  const [creating, setCreating] = useState(false);
  const params = filter === "all" ? undefined : { status: filter };
  const { data, isLoading } = useListNcpdWarrants(params, {
    query: { queryKey: getListNcpdWarrantsQueryKey(params) },
  });
  const rows = data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex gap-1 flex-wrap items-center" data-testid="filter-warrant-status">
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
        <div className="flex-1" />
        <Button
          size="sm"
          className="rounded-none font-display uppercase text-xs border border-nc-cyan bg-transparent text-nc-cyan hover:bg-nc-cyan/10"
          onClick={() => setCreating(true)}
          data-testid="button-ncpd-new-warrant"
        >
          <Plus className="w-4 h-4 mr-1" /> NEW WARRANT
        </Button>
      </div>
      <NewWarrantDialog open={creating} onOpenChange={setCreating} />
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

// New Warrant dialog on the warrants board: pick a suspect via the shared
// character/player search, then fill in reason + optional internal notes.
function NewWarrantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [selected, setSelected] = useState<NcpdCharacterSummary | null>(null);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const create = useCreateNcpdWarrant();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const reset = () => {
    setSelected(null);
    setReason("");
    setNotes("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="rounded-none border-nc-cyan/40 max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" /> NEW WARRANT
          </DialogTitle>
        </DialogHeader>
        {!selected ? (
          <div className="space-y-3">
            <p className="font-mono text-sm text-muted-foreground">
              Search for the suspect by character name, player name, or character number.
            </p>
            <NcpdCharacterSearch autoFocus onSelect={(c) => setSelected(c)} />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 border border-border bg-black/20 p-3 flex-wrap">
              <div>
                <p className="font-display tracking-wider text-foreground" data-testid="text-warrant-suspect">
                  {selected.name}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {selected.kind.toUpperCase()}
                  {selected.archetype ? ` · ${selected.archetype}` : ""}
                  {selected.ownerName ? ` · Player: ${selected.ownerName}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="rounded-none font-display text-xs"
                onClick={() => setSelected(null)}
                data-testid="button-warrant-change-suspect"
              >
                <X className="w-4 h-4 mr-1" /> CHANGE
              </Button>
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-xs uppercase">Reason</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-none"
                data-testid="input-new-warrant-reason"
              />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-xs uppercase">Internal notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="rounded-none"
                data-testid="input-new-warrant-notes"
              />
            </div>
            <Button
              className="rounded-none font-display w-full"
              disabled={!reason.trim() || create.isPending}
              onClick={() => {
                create.mutate(
                  { data: { characterId: selected.id, reason: reason.trim(), notes: notes.trim() || null } },
                  {
                    onSuccess: () => {
                      // Invalidate every filter variant of the board list.
                      void queryClient.invalidateQueries({ queryKey: ["/api/ncpd/warrants"] });
                      toast({ title: "Warrant issued", description: `Warrant issued on ${selected.name}.` });
                      onOpenChange(false);
                      reset();
                    },
                    onError: (e: unknown) =>
                      toast({
                        title: "Could not issue warrant",
                        description: apiErrorMessage(e, "Could not issue warrant"),
                        variant: "destructive",
                      }),
                  },
                );
              }}
              data-testid="button-new-warrant-submit"
            >
              {create.isPending ? "ISSUING..." : "ISSUE WARRANT"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Fines tab on the NCPD hub: pick a subject via the shared character/player
// search (a player-name match lists all their characters), then enter an
// amount + memo. Uses the same create-fine endpoint as the character dossier,
// so the fine lands on the character's record and the owner pays it from
// their Inbox exactly like a dossier-issued fine.
function IssueFineSection() {
  const [selected, setSelected] = useState<NcpdCharacterSummary | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const create = useCreateNcpdFine();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const amt = Number(amount);
  const amtValid = Number.isSafeInteger(amt) && amt > 0;

  const reset = () => {
    setSelected(null);
    setAmount("");
    setMemo("");
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="py-5 space-y-4">
          <div className="flex items-center gap-2">
            <Banknote className="w-5 h-5 text-nc-cyan" />
            <p className="font-display tracking-widest text-nc-cyan">ISSUE FINE</p>
          </div>
          {!selected ? (
            <div className="space-y-3">
              <p className="font-mono text-sm text-muted-foreground">
                Search for the subject by character name, player name, or character number. A fine is always issued
                against a specific character.
              </p>
              <NcpdCharacterSearch onSelect={(c) => setSelected(c)} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 border border-border bg-black/20 p-3 flex-wrap">
                <div>
                  <p className="font-display tracking-wider text-foreground" data-testid="text-fine-subject">
                    {selected.name}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {selected.kind.toUpperCase()}
                    {selected.archetype ? ` · ${selected.archetype}` : ""}
                    {selected.ownerName ? ` · Player: ${selected.ownerName}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-none font-display text-xs"
                  onClick={() => setSelected(null)}
                  data-testid="button-fine-change-subject"
                >
                  <X className="w-4 h-4 mr-1" /> CHANGE
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-xs uppercase">Amount (€$)</Label>
                <Input
                  type="number"
                  min={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="rounded-none"
                  data-testid="input-hub-fine-amount"
                />
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-xs uppercase">Memo</Label>
                <Input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="e.g. Illegal weapon possession"
                  className="rounded-none"
                  data-testid="input-hub-fine-memo"
                />
              </div>
              <Button
                className="rounded-none font-display w-full"
                disabled={!amtValid || !memo.trim() || create.isPending}
                onClick={() => {
                  const name = selected.name;
                  create.mutate(
                    { data: { characterId: selected.id, amount: amt, reason: memo.trim() } },
                    {
                      onSuccess: () => {
                        // Refresh the character's dossier record (fines list) if cached.
                        void queryClient.invalidateQueries({ queryKey: getGetNcpdRecordQueryKey(selected.id) });
                        void queryClient.invalidateQueries({ queryKey: getListNcpdFinesQueryKey() });
                        toast({ title: "Fine issued", description: `Fine of €$${amt.toLocaleString()} issued to ${name}.` });
                        reset();
                      },
                      onError: (e: unknown) =>
                        toast({
                          title: "Could not issue fine",
                          description: apiErrorMessage(e, "Could not issue fine"),
                          variant: "destructive",
                        }),
                    },
                  );
                }}
                data-testid="button-hub-fine-submit"
              >
                {create.isPending ? "ISSUING..." : "ISSUE FINE"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <FineHistorySection />
    </div>
  );
}

// Full fine ledger below the issue form: every fine ever issued, newest first,
// with subject (character + player), amount, memo and payment status.
function FineHistorySection() {
  const { data, isLoading, isError } = useListNcpdFines();
  const fines = data ?? [];
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardContent className="py-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="font-display tracking-widest text-nc-cyan">FINE HISTORY</p>
          <p className="font-mono text-xs text-muted-foreground">{fines.length} FINE{fines.length === 1 ? "" : "S"} ON RECORD</p>
        </div>
        {isLoading ? (
          <p className="font-mono text-sm text-muted-foreground animate-pulse">LOADING LEDGER...</p>
        ) : isError ? (
          <p className="font-mono text-sm text-destructive">Could not load the fine ledger. Try again shortly.</p>
        ) : fines.length === 0 ? (
          <p className="font-mono text-sm text-muted-foreground">No fines have been issued yet.</p>
        ) : (
          <div className="space-y-2">
            {fines.map((f) => (
              <div
                key={f.id}
                className="border border-border bg-black/20 p-3 flex items-start justify-between gap-3 flex-wrap"
                data-testid={`row-fine-${f.id}`}
              >
                <div className="min-w-0 space-y-1">
                  <p className="font-display tracking-wider text-foreground break-words">
                    <Link href={`/ncpd/characters/${f.characterId}`} className="hover:text-nc-cyan">
                      {f.characterName ?? `Character #${f.characterId}`}
                    </Link>
                    {f.ownerName ? (
                      <span className="font-mono text-xs text-muted-foreground"> · Player: {f.ownerName}</span>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground"> · Unclaimed character</span>
                    )}
                  </p>
                  <p className="font-mono text-sm text-muted-foreground break-words">{f.reason}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    Issued {fmtDate(f.createdAt)}
                    {f.officerName ? ` by ${f.officerName}` : ""}
                    {f.status === "paid" && f.paidAt ? ` · Paid ${fmtDate(f.paidAt)}` : ""}
                  </p>
                </div>
                <div className="text-right space-y-1 shrink-0">
                  <p className="font-display text-nc-cyan">€${f.amount.toLocaleString()}</p>
                  <Badge
                    variant="outline"
                    className={
                      "rounded-none font-mono text-[10px] uppercase " +
                      (f.status === "paid"
                        ? "border-nc-green/60 text-nc-green"
                        : f.status === "void"
                          ? "border-muted-foreground/50 text-muted-foreground"
                          : "border-destructive/60 text-destructive")
                    }
                    data-testid={`badge-fine-status-${f.id}`}
                  >
                    {f.status === "paid" ? "PAID" : f.status === "void" ? "VOIDED" : "UNPAID"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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
  // Shared search: character name, character number, or player name (player
  // matches group all of that player's characters).
  return <NcpdCharacterSearch />;
}

function OfficerCharacterCard({ ch }: { ch: NcpdOfficerCharacter }) {
  return (
    <Link href={`/ncpd/characters/${ch.id}`}>
      <Card
        className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full"
        data-testid={`card-ncpd-officer-char-${ch.id}`}
      >
        <CardContent className="p-3 flex gap-3 items-center">
          {ch.portraitUrl ? (
            <img
              src={ch.portraitUrl}
              alt={ch.name}
              className="w-16 h-16 object-cover border border-nc-cyan/40 shrink-0"
              data-testid={`img-ncpd-officer-char-${ch.id}`}
            />
          ) : (
            <div className="w-16 h-16 border border-border bg-black/30 flex items-center justify-center shrink-0">
              <UserSearch className="w-6 h-6 text-muted-foreground/50" />
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-display tracking-wider text-foreground truncate">{ch.name}</p>
            <p className="font-mono text-xs text-muted-foreground truncate">
              {ch.archetype ? ch.archetype : "—"}
            </p>
            {(ch.lifeStatus !== "active" || ch.archived) && (
              <div className="flex items-center gap-1 flex-wrap">
                {ch.lifeStatus !== "active" && (
                  <Badge
                    variant="outline"
                    className={`rounded-none uppercase font-display text-[10px] ${
                      ch.lifeStatus === "dead" ? "border-destructive text-destructive" : "border-nc-yellow text-nc-yellow"
                    }`}
                  >
                    {ch.lifeStatus}
                  </Badge>
                )}
                {ch.archived && (
                  <Badge variant="outline" className="rounded-none uppercase font-display text-[10px] border-muted-foreground text-muted-foreground">
                    archived
                  </Badge>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function OfficersRoster() {
  const { data, isLoading } = useListNcpdOfficers();
  const officers = data ?? [];
  if (isLoading) return <div className="text-nc-cyan font-display animate-pulse">LOADING ROSTER...</div>;
  if (!officers.length) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="py-8 font-mono text-muted-foreground text-center">No officers on the roster.</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      {officers.map((o) => (
        <div key={o.userId} className="space-y-3" data-testid={`section-ncpd-officer-${o.userId}`}>
          <div className="flex items-center gap-3">
            {o.avatarUrl ? (
              <img src={o.avatarUrl} alt={o.displayName} className="w-9 h-9 rounded-full border border-border shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-full border border-border bg-black/30 flex items-center justify-center shrink-0">
                <Shield className="w-4 h-4 text-muted-foreground/50" />
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display tracking-wider text-foreground" data-testid={`text-ncpd-officer-name-${o.userId}`}>
                {o.displayName}
              </span>
              <Badge
                variant="outline"
                className={`rounded-none uppercase font-display text-[10px] ${
                  o.isCommissioner ? "border-nc-yellow text-nc-yellow" : "border-nc-cyan text-nc-cyan"
                }`}
              >
                {o.isCommissioner && <Star className="w-3 h-3 mr-1" />}
                {o.isCommissioner ? "Commissioner" : "Officer"}
              </Badge>
            </div>
          </div>
          {o.characters.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {o.characters.map((ch) => (
                <OfficerCharacterCard key={ch.id} ch={ch} />
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground pl-12">No NCPD characters on file.</p>
          )}
        </div>
      ))}
    </div>
  );
}
