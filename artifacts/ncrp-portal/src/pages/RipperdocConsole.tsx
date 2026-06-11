import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetCharacterMedical,
  getGetCharacterMedicalQueryKey,
  useListMyRipperdocs,
  useGetRipperdoc,
  getGetRipperdocQueryKey,
  getGetCharacterCyberwareQueryKey,
  useGetCharacterCyberware,
  useCreateInstallOwnedOffer,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Syringe, Search, Activity, Plus, Trash2, Stethoscope, Wallet } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Redirect } from "wouter";
import ErrorBoundary from "@/components/ErrorBoundary";
import CyberwareActionDialog from "@/components/CyberwareActionDialog";
import RemoveCyberwareDialog from "@/components/RemoveCyberwareDialog";

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
  ownerName?: string | null;
  legacyDiscordUsername?: string | null;
}

// Cyberpsychosis band → accent colour for the at-a-glance risk readout.
const BAND_COLOR: Record<string, string> = {
  none: "text-nc-green",
  medium: "text-nc-yellow",
  high: "text-nc-magenta",
  extreme: "text-destructive",
  exempt: "text-muted-foreground",
};

// Standalone ripperdoc workstation. Gated to users with the RIPPERDOC
// (or ADMIN) Discord role — the backend enforces it on the checkup +
// medical endpoints, this page just hides the link/route for everyone
// else so we don't surface a 403 wall to random players.
export default function RipperdocConsole() {
  const { data: me, isLoading: meLoading } = useEffectiveMe();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [level, setLevel] = useState<Level | "">("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clinicId, setClinicId] = useState<number | null>(null);
  // Stock item chosen to install onto the current patient; opening the
  // existing CyberwareActionDialog with the patient pre-locked.
  const [installStock, setInstallStock] = useState<{ id: number; name: string; price: number; quantity: number } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  // Optional install fee per owned (uninstalled) cyberware item, keyed by
  // inventory item id. Defaults to 0 (free fitting).
  const [installFees, setInstallFees] = useState<Record<number, number>>({});

  // Character directory — filter client-side on name for the picker so a doc
  // can type a partial street name without round-tripping.
  const { data: charsResp, isLoading: charsLoading } = useQuery<DirectoryChar[]>({
    queryKey: ["ripperdoc-directory"],
    queryFn: async () => {
      const r = await fetch("/api/directory/characters?limit=500", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load characters");
      const body = await r.json();
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
    if (!q) return allChars.slice(0, 50);
    return allChars
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.ownerName ?? "").toLowerCase().includes(q) ||
          (c.legacyDiscordUsername ?? "").toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [allChars, search]);

  // Group the results by player so searching a player surfaces all of their
  // characters together under one header.
  const grouped = useMemo(() => {
    const map = new Map<string, DirectoryChar[]>();
    for (const c of filtered) {
      const player = c.ownerName?.trim() || c.legacyDiscordUsername?.trim() || "Unclaimed";
      const list = map.get(player) ?? [];
      list.push(c);
      map.set(player, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const selected = selectedId ? allChars.find((c) => c.id === selectedId) : null;

  // Consolidated medical record (derived band, installed chrome, checkup +
  // meds history) — role-gated so a doc can read any patient.
  const { data: medical, isLoading: medicalLoading } = useGetCharacterMedical(selectedId ?? 0, {
    query: {
      enabled: !!selectedId,
      queryKey: getGetCharacterMedicalQueryKey(selectedId ?? 0),
    },
  });

  // Clinics this doc operates — install/remove route through the existing
  // venue-scoped approval flow, so they need a clinic to act as.
  const { data: clinics } = useListMyRipperdocs();
  const myClinics = clinics ?? [];
  const venueId = clinicId ?? myClinics[0]?.id ?? null;
  const { data: clinic } = useGetRipperdoc(venueId ?? 0, {
    query: { enabled: !!venueId, queryKey: getGetRipperdocQueryKey(venueId ?? 0) },
  });
  const stock = clinic?.stock ?? [];

  const refreshPatient = () => {
    if (selectedId) qc.invalidateQueries({ queryKey: getGetCharacterMedicalQueryKey(selectedId) });
    if (venueId && selectedId)
      qc.invalidateQueries({ queryKey: getGetCharacterCyberwareQueryKey(venueId, selectedId) });
    if (venueId) qc.invalidateQueries({ queryKey: getGetRipperdocQueryKey(venueId) });
  };

  // CWP capacity + the patient's UNINSTALLED cyberware (owned but not yet
  // fitted). Drives the "install from patient inventory" list below.
  const { data: cyberStatus } = useGetCharacterCyberware(venueId ?? 0, selectedId ?? 0, {
    query: {
      enabled: !!venueId && !!selectedId,
      queryKey: getGetCharacterCyberwareQueryKey(venueId ?? 0, selectedId ?? 0),
    },
  });
  const uninstalled = cyberStatus?.uninstalled ?? [];

  // Offer to fit a piece the patient already owns. Leaves a PENDING offer the
  // player confirms in My Offers; the optional fee is charged on their approval.
  const installOwned = useCreateInstallOwnedOffer({
    mutation: {
      onSuccess: () => {
        setFeedback(
          `Install offer sent to ${selected?.name ?? "patient"} — they confirm it (and any fee) in My Offers.`,
        );
        setError(null);
        refreshPatient();
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : String(err));
        setFeedback(null);
      },
    },
  });

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
      refreshPatient();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
      setFeedback(null);
    },
  });

  if (meLoading) return <div className="text-nc-cyan font-mono animate-pulse">AUTHENTICATING...</div>;
  if (!me) return <Redirect to="/" />;
  if (!me.isRipperdoc && !me.isAdmin) return <Redirect to="/" />;

  const band = medical?.band ?? null;
  const presetBuyer = selected ? { id: selected.id, name: selected.name } : null;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-display font-bold text-nc-cyan flex items-center gap-3">
          <Syringe className="w-7 h-7" /> RIPPERDOC CONSOLE
        </h1>
        <p className="text-sm text-muted-foreground font-mono">
          Pull up a patient's chrome, checkup &amp; meds history, record a checkup, and install or remove cyberware.
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
            <ErrorBoundary>
            <Input
              placeholder="Search by player or character name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-none font-mono"
              data-testid="input-ripperdoc-search"
            />
            <div className="max-h-80 overflow-y-auto border border-border/60">
              {charsLoading && (
                <div className="p-3 text-xs font-mono text-muted-foreground">SCANNING DIRECTORY...</div>
              )}
              {!charsLoading && filtered.length === 0 && (
                <div className="p-3 text-xs font-mono text-muted-foreground">NO_MATCHES.</div>
              )}
              {grouped.map(([player, chars]) => (
                <div key={player} className="border-b border-border/40 last:border-b-0">
                  <div
                    className="px-3 py-1.5 text-[10px] font-display tracking-widest uppercase text-nc-magenta bg-card/60 sticky top-0"
                    data-testid={`group-ripperdoc-player-${player}`}
                  >
                    {player}
                  </div>
                  <div className="divide-y divide-border/40">
                    {chars.map((c) => {
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
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            </ErrorBoundary>
          </CardContent>
        </Card>

        <Card className="rounded-none border-border bg-card/50">
          <CardHeader className="border-b border-border">
            <CardTitle className="font-display tracking-widest text-nc-magenta text-sm">
              CHECKUP
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            <ErrorBoundary>
            {!selected ? (
              <div className="text-sm font-mono text-muted-foreground">
                SELECT_PATIENT_FROM_LEFT.
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="font-display text-lg text-foreground">{selected.name}</div>
                  <div className="flex items-center gap-2 text-sm font-mono" data-testid="text-derived-band">
                    <span className="text-muted-foreground uppercase text-xs">Cyberpsychosis band</span>
                    {medicalLoading ? (
                      <span className="text-muted-foreground animate-pulse">…</span>
                    ) : (
                      <>
                        <span className={`uppercase font-display ${BAND_COLOR[band ?? "none"] ?? "text-foreground"}`}>
                          {band ?? "—"}
                        </span>
                        <span className="text-muted-foreground text-xs">({medical?.usedCwp ?? 0} CWP)</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">
                    LAST_CHECKUP: {medical?.lastCheckupAt ? new Date(medical.lastCheckupAt).toLocaleString() : "—"}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">
                    WEEKS_SINCE_CHECKUP:{" "}
                    {/* No checkup on record → count from the character's creation
                        date (an implicit initial checkup), matching the billing
                        logic, instead of showing the max streak. */}
                    {(() => {
                      const eff = medical?.lastCheckupAt ?? medical?.createdAt ?? null;
                      if (!eff) return "—";
                      const weeks = Math.max(
                        1,
                        Math.floor((Date.now() - new Date(eff).getTime()) / (7 * 86400000)) + 1,
                      );
                      return medical?.lastCheckupAt ? weeks : `${weeks} (since creation)`;
                    })()}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/70">
                    Band is auto-derived from chrome CWP (0-6 none · 7-9 medium · 10-12 high · 13+ extreme). The level buttons below only update the legacy/cosmetic tag.
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-mono text-nc-cyan">LEGACY LEVEL TAG (OPTIONAL)</Label>
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
            </ErrorBoundary>
          </CardContent>
        </Card>
      </div>

      {selected && (
        <ErrorBoundary>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Installed cyberware + install/remove actions */}
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader className="border-b border-border flex flex-row items-center justify-between gap-2">
                <CardTitle className="font-display tracking-widest text-nc-cyan text-sm flex items-center gap-2">
                  <Activity className="w-4 h-4" /> CHROME
                </CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!venueId}
                    onClick={() => setRemoveOpen(true)}
                    className="rounded-none border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground font-display text-xs"
                    data-testid="button-console-remove"
                  >
                    <Trash2 className="w-3 h-3 mr-1" /> REMOVE
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {myClinics.length === 0 && (
                  <div className="text-[11px] font-mono text-nc-yellow border border-nc-yellow/40 bg-nc-yellow/5 p-2" data-testid="text-no-clinic">
                    You don't operate a clinic, so installs/removals are unavailable. View-only.
                  </div>
                )}
                {myClinics.length > 1 && (
                  <div>
                    <Label className="text-[10px] font-mono text-muted-foreground uppercase">Operating as</Label>
                    <select
                      value={venueId ?? ""}
                      onChange={(e) => setClinicId(Number(e.target.value))}
                      className="w-full rounded-none border border-border bg-background px-2 py-1.5 font-mono text-sm"
                      data-testid="select-console-clinic"
                    >
                      {myClinics.map((cl) => (
                        <option key={cl.id} value={cl.id}>{cl.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <Label className="text-[10px] font-mono text-muted-foreground uppercase">Installed ({medical?.usedCwp ?? 0} CWP)</Label>
                  {medicalLoading ? (
                    <div className="text-xs font-mono text-muted-foreground py-2 animate-pulse">LOADING_CHROME...</div>
                  ) : (medical?.installed.length ?? 0) === 0 ? (
                    <div className="text-xs font-mono text-muted-foreground py-2" data-testid="text-no-chrome">No installed cyberware.</div>
                  ) : (
                    <div className="space-y-1 max-h-64 overflow-y-auto border border-border/60 p-1 mt-1">
                      {medical!.installed.map((it) => (
                        <div key={it.id} className="flex justify-between gap-2 px-2 py-1.5 text-xs font-mono border-b border-border/30 last:border-b-0" data-testid={`row-chrome-${it.id}`}>
                          <span className="truncate">{it.name}{it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : ""}</span>
                          <span className="text-nc-yellow shrink-0">{it.cwp} CWP</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {venueId && (
                  <div>
                    <Label className="text-[10px] font-mono text-muted-foreground uppercase flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Install from clinic stock
                    </Label>
                    {stock.length === 0 ? (
                      <div className="text-xs font-mono text-muted-foreground py-2" data-testid="text-no-stock">No cyberware in this clinic's stock.</div>
                    ) : (
                      <div className="space-y-1 max-h-56 overflow-y-auto border border-border/60 p-1 mt-1">
                        {stock.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            disabled={s.quantity <= 0}
                            onClick={() => setInstallStock({ id: s.id, name: s.name, price: s.price, quantity: s.quantity })}
                            className="w-full text-left rounded-none border border-border/50 px-2 py-1.5 text-xs font-mono hover:border-nc-magenta/60 transition-colors disabled:opacity-40"
                            data-testid={`button-install-stock-${s.id}`}
                          >
                            <div className="flex justify-between gap-2">
                              <span className="truncate">{s.name}</span>
                              <span className="text-nc-yellow shrink-0">€${s.price.toLocaleString()} · x{s.quantity}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {venueId && (
                  <div>
                    <Label className="text-[10px] font-mono text-muted-foreground uppercase flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Install from patient inventory
                    </Label>
                    {uninstalled.length === 0 ? (
                      <div className="text-xs font-mono text-muted-foreground py-2" data-testid="text-no-owned-cyberware">
                        Patient owns no uninstalled cyberware.
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-56 overflow-y-auto border border-border/60 p-1 mt-1">
                        {uninstalled.map((u) => (
                          <div
                            key={u.id}
                            className="rounded-none border border-border/50 px-2 py-1.5 text-xs font-mono space-y-1.5"
                            data-testid={`row-owned-cyberware-${u.id}`}
                          >
                            <div className="flex justify-between gap-2">
                              <span className="truncate">{u.name}{u.quantity && u.quantity > 1 ? ` ×${u.quantity}` : ""}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                min={0}
                                value={installFees[u.id] ?? ""}
                                placeholder="Fee (optional)"
                                onChange={(e) =>
                                  setInstallFees((prev) => ({ ...prev, [u.id]: Math.max(0, Number(e.target.value) || 0) }))
                                }
                                className="rounded-none font-mono h-8 text-xs"
                                data-testid={`input-owned-fee-${u.id}`}
                              />
                              <Button
                                size="sm"
                                disabled={installOwned.isPending || !selectedId}
                                onClick={() => {
                                  if (!venueId || !selectedId) return;
                                  installOwned.mutate({
                                    id: venueId,
                                    data: {
                                      installItemId: u.id,
                                      buyerCharacterId: selectedId,
                                      price: Math.max(0, installFees[u.id] ?? 0),
                                    },
                                  });
                                }}
                                className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display text-xs shrink-0"
                                data-testid={`button-install-owned-${u.id}`}
                              >
                                <Plus className="w-3 h-3 mr-1" /> OFFER
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] font-mono text-muted-foreground/70 mt-1">
                      Sends a pending install offer the patient confirms in My Offers. Any fee is charged on their approval.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Checkup history */}
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader className="border-b border-border">
                <CardTitle className="font-display tracking-widest text-nc-magenta text-sm flex items-center gap-2">
                  <Stethoscope className="w-4 h-4" /> CHECKUP HISTORY
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {medicalLoading ? (
                  <div className="text-xs font-mono text-muted-foreground py-2 animate-pulse">LOADING...</div>
                ) : (medical?.checkups.length ?? 0) === 0 ? (
                  <div className="text-xs font-mono text-muted-foreground py-2" data-testid="text-no-checkups">No checkups on record.</div>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {medical!.checkups.map((ch) => (
                      <div key={ch.id} className="border-b border-border/30 pb-2 last:border-b-0" data-testid={`row-checkup-${ch.id}`}>
                        <div className="text-xs font-mono text-foreground">
                          {ch.createdAt ? new Date(ch.createdAt).toLocaleString() : "—"}
                        </div>
                        <div className="text-[11px] font-mono text-muted-foreground">
                          {ch.actorName ? `by ${ch.actorName}` : ""}{ch.level ? ` · level: ${ch.level}` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Meds / cyberware payment history */}
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader className="border-b border-border">
                <CardTitle className="font-display tracking-widest text-nc-yellow text-sm flex items-center gap-2">
                  <Wallet className="w-4 h-4" /> MEDS &amp; CHROME PAYMENTS
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {medicalLoading ? (
                  <div className="text-xs font-mono text-muted-foreground py-2 animate-pulse">LOADING...</div>
                ) : (medical?.medsPayments.length ?? 0) === 0 ? (
                  <div className="text-xs font-mono text-muted-foreground py-2" data-testid="text-no-payments">No meds or cyberware payments on record.</div>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {medical!.medsPayments.map((p) => (
                      <div key={p.id} className="flex justify-between gap-2 border-b border-border/30 pb-2 last:border-b-0" data-testid={`row-payment-${p.id}`}>
                        <div className="min-w-0">
                          <div className="text-xs font-mono text-foreground truncate">{p.memo || p.kind}</div>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"}
                          </div>
                        </div>
                        <span className={`text-xs font-mono shrink-0 ${p.amount < 0 ? "text-destructive" : "text-nc-green"}`}>
                          {p.amount < 0 ? "" : "+"}€${p.amount.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </ErrorBoundary>
      )}

      {installStock && venueId && (
        <CyberwareActionDialog
          venueId={venueId}
          stock={installStock}
          presetBuyer={presetBuyer}
          lockBuyer
          onClose={() => setInstallStock(null)}
          onDone={() => {
            refreshPatient();
            setInstallStock(null);
          }}
        />
      )}
      {removeOpen && venueId && (
        <RemoveCyberwareDialog
          venueId={venueId}
          presetTarget={presetBuyer}
          lockTarget
          onClose={() => setRemoveOpen(false)}
          onDone={() => {
            refreshPatient();
            setRemoveOpen(false);
          }}
        />
      )}
    </div>
  );
}
