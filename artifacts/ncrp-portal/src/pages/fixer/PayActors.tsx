import { useState } from "react";
import { Link } from "wouter";
import {
  useGetActorPayouts,
  useCreateActorPayout,
  useSearchMissionActors,
  getSearchMissionActorsQueryKey,
  getGetActorPayoutsQueryKey,
  type ArchiveUser,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Search, X, Users, ChevronDown, ChevronRight } from "lucide-react";

const PRESETS = ["Sunday Session", "Open Social Lobby", "Open Chaos Lobby"];

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function errOf(e: unknown): string | null {
  if (!e) return null;
  const anyErr = e as { response?: { data?: { error?: string } }; message?: string };
  return anyErr.response?.data?.error ?? anyErr.message ?? "Something went wrong.";
}

function todayInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export default function PayActors() {
  const qc = useQueryClient();
  const { data: payouts, isLoading } = useGetActorPayouts();
  const create = useCreateActorPayout({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetActorPayoutsQueryKey() }),
    },
  });

  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState(todayInput());
  const [amount, setAmount] = useState(0);
  const [selected, setSelected] = useState<ArchiveUser[]>([]);
  const [search, setSearch] = useState("");
  const [openEvents, setOpenEvents] = useState<Record<string, boolean>>({});

  const searchParams = { q: search || undefined };
  const { data: results, isFetching: searching } = useSearchMissionActors(searchParams, {
    query: {
      queryKey: getSearchMissionActorsQueryKey(searchParams),
      enabled: search.trim().length > 0,
    },
  });

  const selectedIds = selected.map((u) => u.id);
  const addActor = (u: ArchiveUser) => {
    setSelected((prev) => (prev.some((x) => x.id === u.id) ? prev : [...prev, u]));
    setSearch("");
  };
  const removeActor = (id: string) => setSelected((prev) => prev.filter((x) => x.id !== id));

  const createErr = errOf(create.error);
  const canSubmit =
    eventName.trim().length > 0 && selectedIds.length > 0 && amount > 0 && !create.isPending;

  const submit = () => {
    create.mutate(
      {
        data: {
          eventName: eventName.trim(),
          eventType: null,
          eventDate: eventDate ? new Date(eventDate).toISOString() : null,
          userIds: selectedIds,
          amount,
        },
      },
      {
        onSuccess: () => {
          setSelected([]);
          setAmount(0);
          setSearch("");
        },
      },
    );
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-pay-actors-title">
          <Users className="w-7 h-7 text-nc-magenta" /> PAY ACTORS
        </h1>
        <Link href="/fixer" className="text-nc-magenta font-mono text-xs hover:underline">
          ← fixer hub
        </Link>
      </div>

      <p className="font-mono text-xs text-muted-foreground">
        Pay actors / NPCs for events that aren't formal missions — regular sessions, open social
        lobbies, and the like. Give it a label and date, pick who acted, and pay them. These payouts
        also show up under ACTOR PAYMENTS on the reports page.
      </p>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            New Payout
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 font-mono text-sm">
          <div className="flex flex-wrap gap-3">
            <div className="flex-1 min-w-[16rem] space-y-1">
              <Label className="text-xs">EVENT LABEL</Label>
              <Input
                list="actor-event-presets"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder="e.g. Sunday Session"
                className="rounded-none"
                data-testid="input-event-name"
              />
              <datalist id="actor-event-presets">
                {PRESETS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">DATE</Label>
              <Input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="rounded-none w-44"
                data-testid="input-event-date"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">ACTOR FEE €$</Label>
              <Input
                type="number"
                min={0}
                value={amount || ""}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="rounded-none w-40"
                data-testid="input-actor-amount"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">SEARCH USERS</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="name…"
                className="rounded-none pl-8"
                data-testid="input-actor-search"
              />
            </div>
            {search.trim().length > 0 && (
              <div className="border border-border/60 divide-y divide-border/40 max-h-56 overflow-y-auto">
                {searching && <div className="px-3 py-2 text-muted-foreground text-xs">Searching…</div>}
                {!searching && (results?.length ?? 0) === 0 && (
                  <div className="px-3 py-2 text-muted-foreground text-xs">No users found.</div>
                )}
                {results?.map((u) => {
                  const isSelected = selectedIds.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => addActor(u)}
                      disabled={isSelected}
                      className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid={`actor-result-${u.id}`}
                    >
                      <span className="text-foreground">{u.globalName ?? u.username}</span>
                      {isSelected && <span className="text-muted-foreground text-xs">added</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="list-selected-actors">
              {selected.map((u) => (
                <span
                  key={u.id}
                  className="inline-flex items-center gap-1 border border-border px-2 py-1 text-xs text-foreground"
                  data-testid={`chip-actor-${u.id}`}
                >
                  {u.globalName ?? u.username}
                  <button type="button" onClick={() => removeActor(u.id)} data-testid={`remove-actor-${u.id}`}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-pay-actors"
            >
              {create.isPending ? "PAYING..." : "PAY ACTORS"}
            </Button>
            {create.data && (
              <span className="text-xs text-muted-foreground" data-testid="text-pay-result">
                {create.data.result.live
                  ? `Paid ${create.data.result.paid}, failed ${create.data.result.failed}.`
                  : `Simulated ${create.data.result.simulated} (Test mode — no real payout).`}
              </span>
            )}
          </div>
          {createErr && (
            <div className="text-destructive text-xs" data-testid="text-pay-actors-error">{createErr}</div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Recent Payouts
          </CardTitle>
        </CardHeader>
        <CardContent className="font-mono text-sm">
          {isLoading ? (
            <div className="text-nc-cyan animate-pulse">Loading…</div>
          ) : !payouts || payouts.length === 0 ? (
            <p className="text-muted-foreground text-xs" data-testid="text-no-payouts">
              No non-mission actor payouts yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {payouts.map((ev) => {
                const isOpen = !!openEvents[ev.key];
                return (
                  <li key={ev.key} data-testid={`row-payout-${ev.key}`}>
                    <button
                      type="button"
                      onClick={() => setOpenEvents((s) => ({ ...s, [ev.key]: !s[ev.key] }))}
                      className="w-full flex items-center justify-between py-2 text-left hover:bg-accent/20"
                    >
                      <span className="flex items-center gap-2">
                        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <span className="text-foreground">{ev.eventName ?? "—"}</span>
                        <span className="text-muted-foreground text-xs">{fmtDateTime(ev.eventDate)}</span>
                      </span>
                      <span className="flex items-center gap-3 text-xs">
                        <span className="text-muted-foreground">{ev.actorCount} actor{ev.actorCount === 1 ? "" : "s"}</span>
                        <span className="text-nc-yellow">€$ {ev.totalPaid.toLocaleString()}</span>
                      </span>
                    </button>
                    {isOpen && (
                      <ul className="pl-6 pb-2 space-y-1">
                        {ev.actors.map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center justify-between text-xs"
                            data-testid={`row-payout-actor-${a.id}`}
                          >
                            <span className="text-muted-foreground">
                              {a.userName ?? a.userId}
                              {a.paymentStatus !== "paid" && (
                                <span className="text-yellow-500"> · {a.paymentStatus}</span>
                              )}
                            </span>
                            <span className="text-nc-yellow/80">€$ {a.amount.toLocaleString()}</span>
                          </li>
                        ))}
                        {ev.fixerName && (
                          <li className="text-muted-foreground/70 text-[11px] pt-1">paid by {ev.fixerName}</li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
