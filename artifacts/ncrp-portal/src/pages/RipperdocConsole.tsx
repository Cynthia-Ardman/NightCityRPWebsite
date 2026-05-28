import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Syringe, Search } from "lucide-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Redirect } from "wouter";

const LEVELS = ["none", "medium", "high", "extreme"] as const;
type Level = typeof LEVELS[number];

interface CheckupResult {
  characterId: number;
  lastCheckupAt: string | null;
  checkupStreak: number;
  cyberwareLevel: Level;
}

interface DirectoryChar {
  id: number;
  name: string;
  cyberwareLevel?: Level | null;
  checkupStreak?: number | null;
  lastCheckupAt?: string | null;
  archived?: boolean | null;
}

// Standalone ripperdoc workstation. Gated to users with the RIPPERDOC
// (or ADMIN) Discord role — the backend enforces it on the checkup
// endpoint, this page just hides the link/route for everyone else so we
// don't surface a 403 wall to random players.
export default function RipperdocConsole() {
  const { data: me, isLoading: meLoading } = useAuthMe();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [level, setLevel] = useState<Level | "">("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Character directory is paged by the existing useListAllCharacters
  // hook; we filter client-side on name for the picker so a doc can type
  // a partial street name without round-tripping.
  const { data: charsResp, isLoading: charsLoading } = useQuery<DirectoryChar[]>({
    queryKey: ["ripperdoc-directory"],
    queryFn: async () => {
      const r = await fetch("/api/directory/characters?limit=500", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load characters");
      const body = await r.json();
      // Tolerate either {items:[...]} (paged) or a bare array shape.
      const list = Array.isArray(body) ? body : body.items ?? [];
      return list as DirectoryChar[];
    },
  });
  const allChars = useMemo<DirectoryChar[]>(
    () => (charsResp ?? []).filter((c) => !c.archived),
    [charsResp],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allChars.slice(0, 30);
    return allChars
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 30);
  }, [allChars, search]);

  const selected = selectedId ? allChars.find((c) => c.id === selectedId) : null;

  const checkup = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("Pick a character first");
      const r = await fetch(`/api/admin/characters/${selectedId}/checkup`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(level ? { cyberwareLevel: level } : {}),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      return body as CheckupResult;
    },
    onSuccess: (res) => {
      setFeedback(
        `Checkup recorded for ${selected?.name ?? "character"} · level: ${res.cyberwareLevel} · streak reset.`,
      );
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
      setFeedback(null);
    },
  });

  if (meLoading) return <div className="text-nc-cyan font-mono animate-pulse">AUTHENTICATING...</div>;
  if (!me) return <Redirect to="/" />;
  if (!me.isRipperdoc && !me.isAdmin) return <Redirect to="/" />;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-display font-bold text-nc-cyan flex items-center gap-3">
          <Syringe className="w-7 h-7" /> RIPPERDOC CONSOLE
        </h1>
        <p className="text-sm text-muted-foreground font-mono">
          Record a chrome checkup, reset the patient's missed-meds streak, and re-band their cyberware risk.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader className="border-b border-border">
            <CardTitle className="font-display tracking-widest text-nc-cyan text-sm flex items-center gap-2">
              <Search className="w-4 h-4" /> PATIENT
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-3">
            <Input
              placeholder="Search by character name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-none font-mono"
              data-testid="input-ripperdoc-search"
            />
            <div className="max-h-80 overflow-y-auto border border-border/60 divide-y divide-border/40">
              {charsLoading && (
                <div className="p-3 text-xs font-mono text-muted-foreground">SCANNING DIRECTORY...</div>
              )}
              {!charsLoading && filtered.length === 0 && (
                <div className="p-3 text-xs font-mono text-muted-foreground">NO_MATCHES.</div>
              )}
              {filtered.map((c) => {
                const active = selectedId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(c.id);
                      setLevel((c.cyberwareLevel as Level) ?? "");
                      setFeedback(null);
                      setError(null);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm font-mono flex items-center justify-between gap-2 transition-colors ${
                      active ? "bg-nc-cyan/15 text-nc-cyan" : "hover:bg-card text-foreground"
                    }`}
                    data-testid={`row-ripperdoc-char-${c.id}`}
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs text-muted-foreground uppercase">
                      {c.cyberwareLevel ?? "none"}
                    </span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-none border-border bg-card/50">
          <CardHeader className="border-b border-border">
            <CardTitle className="font-display tracking-widest text-nc-magenta text-sm">
              CHECKUP
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            {!selected ? (
              <div className="text-sm font-mono text-muted-foreground">
                SELECT_PATIENT_FROM_LEFT.
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="font-display text-lg text-foreground">{selected.name}</div>
                  <div className="text-xs font-mono text-muted-foreground">
                    LAST_CHECKUP: {selected.lastCheckupAt ? new Date(selected.lastCheckupAt).toLocaleString() : "—"}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">
                    MISSED_STREAK: {selected.checkupStreak ?? 0} · CURRENT_LEVEL: {selected.cyberwareLevel ?? "none"}
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-mono text-nc-cyan">CYBERWARE LEVEL</Label>
                  <div className="grid grid-cols-4 gap-1 mt-1">
                    {LEVELS.map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLevel(l)}
                        className={`px-2 py-2 text-xs font-display tracking-widest uppercase border rounded-none ${
                          level === l
                            ? "bg-nc-cyan/20 text-nc-cyan border-nc-cyan"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                        data-testid={`button-level-${l}`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground mt-1">
                    Weekly cap: none=0 · medium=€$2K · high=€$5K · extreme=€$10K
                  </div>
                </div>

                <Button
                  type="button"
                  disabled={checkup.isPending}
                  onClick={() => checkup.mutate()}
                  className="w-full rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
                  data-testid="button-record-checkup"
                >
                  {checkup.isPending ? "RECORDING..." : "RECORD CHECKUP"}
                </Button>

                {feedback && (
                  <div className="text-xs font-mono text-nc-cyan border border-nc-cyan/40 bg-nc-cyan/5 p-2">
                    {feedback}
                  </div>
                )}
                {error && (
                  <div className="text-xs font-mono text-destructive border border-destructive/40 bg-destructive/5 p-2">
                    ERR: {error}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
