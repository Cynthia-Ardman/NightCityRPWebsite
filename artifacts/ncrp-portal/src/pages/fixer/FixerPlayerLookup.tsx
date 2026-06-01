import { useState } from "react";
import { Link } from "wouter";
import {
  useSearchFixerPlayers,
  getSearchFixerPlayersQueryKey,
  useGetFixerPlayerActivity,
  getGetFixerPlayerActivityQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  User,
  ScrollText,
  Coins,
  Briefcase,
  Drama,
  CalendarCheck,
  Store,
  Stethoscope,
  Activity,
  ArrowLeft,
} from "lucide-react";

function fmt(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function eddies(n: number): string {
  const sign = n < 0 ? "-" : "+";
  return `${sign}€$${Math.abs(n).toLocaleString()}`;
}

// Map a known audit/activity target to its detail route. Returns null for
// target types that have no dedicated detail page, so the row stays plain text.
function targetHref(
  targetType: string | null | undefined,
  targetId: string | number | null | undefined,
): string | null {
  if (!targetType || targetId == null || targetId === "") return null;
  switch (targetType) {
    case "character":
      return `/characters/${targetId}`;
    case "sheet":
      return `/sheets/${targetId}`;
    case "mission":
      return `/missions/${targetId}`;
    case "store":
      return `/directory/stores/${targetId}`;
    case "ripperdoc":
      return `/directory/ripperdocs/${targetId}`;
    case "lore_entry":
      return `/directory/lore/${targetId}`;
    default:
      return null;
  }
}

export default function FixerPlayerLookup() {
  const [qInput, setQInput] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const searchParams = { q: query ?? undefined };
  const { data: results, isFetching: searching } = useSearchFixerPlayers(searchParams, {
    query: { queryKey: getSearchFixerPlayersQueryKey(searchParams), enabled: !!query },
  });

  const { data: profile, isFetching: loadingProfile } = useGetFixerPlayerActivity(selectedId ?? "", {
    query: { queryKey: getGetFixerPlayerActivityQueryKey(selectedId ?? ""), enabled: !!selectedId },
  });

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-display tracking-widest text-nc-cyan">PLAYER DOSSIER</h1>
        <p className="text-sm text-muted-foreground font-mono mt-1">
          Look up a player and review everything they've done across the portal — edits, attends, transactions,
          venues, and notable events. Read-only. Fixer/admin only.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-4">
          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              setSelectedId(null);
              setQuery(qInput.trim() || null);
            }}
          >
            <div className="sm:col-span-10">
              <Label className="text-xs font-mono">PLAYER OR CHARACTER NAME</Label>
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="e.g. discord name or character name"
                data-testid="input-player-q"
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={!qInput.trim()}
                className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
                data-testid="button-player-search"
              >
                <Search className="w-4 h-4 mr-2" /> SEARCH
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {searching && <div className="text-nc-cyan font-mono animate-pulse">Scanning the net...</div>}

      {/* Search results (hidden once a player is selected) */}
      {!selectedId && results && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest">MATCHES ({results.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {results.length === 0 ? (
              <div className="text-muted-foreground font-mono italic">No players match.</div>
            ) : (
              <div className="space-y-2 font-mono text-sm" data-testid="list-players">
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className="w-full text-left flex items-center gap-3 border border-border/40 hover:border-nc-cyan p-2 cursor-pointer"
                    data-testid={`row-player-${p.id}`}
                  >
                    {p.avatarUrl ? (
                      <img src={p.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
                    ) : (
                      <User className="w-8 h-8 text-nc-cyan p-1" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground">
                        {p.globalName || p.username}
                        {p.globalName && <span className="text-muted-foreground"> ({p.username})</span>}
                      </div>
                      {p.characterNames.length > 0 && (
                        <div className="text-xs text-muted-foreground truncate">{p.characterNames.join(", ")}</div>
                      )}
                    </div>
                    {(p.roles ?? []).slice(0, 3).map((r) => (
                      <Badge key={r} variant="outline" className="rounded-none text-nc-yellow border-nc-yellow text-[10px]">
                        {r}
                      </Badge>
                    ))}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selectedId && (
        <div className="space-y-4">
          <Button
            variant="outline"
            className="rounded-none font-display"
            onClick={() => setSelectedId(null)}
            data-testid="button-back-to-results"
          >
            <ArrowLeft className="w-4 h-4 mr-2" /> BACK TO RESULTS
          </Button>

          {loadingProfile && <div className="text-nc-cyan font-mono animate-pulse">Pulling dossier...</div>}

          {profile && (
            <>
              <Card className="rounded-none border-border bg-card/50">
                <CardContent className="p-4 flex items-center gap-4">
                  {profile.player.avatarUrl ? (
                    <img src={profile.player.avatarUrl} alt="" className="w-14 h-14 rounded-full" />
                  ) : (
                    <User className="w-14 h-14 text-nc-cyan p-2" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-2xl text-nc-cyan break-words" data-testid="text-player-name">
                      {profile.player.globalName || profile.player.username}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      @{profile.player.username} · last seen {fmt(profile.player.lastSeenAt)}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(profile.player.roles ?? []).map((r) => (
                        <Badge key={r} variant="outline" className="rounded-none text-nc-yellow border-nc-yellow text-[10px]">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Characters */}
              <Section icon={<User className="w-4 h-4" />} title="CHARACTERS" count={profile.characters.length}>
                {profile.characters.length === 0 ? (
                  <Empty>No characters owned.</Empty>
                ) : (
                  <div className="flex flex-wrap gap-2 font-mono text-sm">
                    {profile.characters.map((c) => (
                      <Link
                        key={c.id}
                        href={`/characters/${c.id}`}
                        data-testid={`chip-character-${c.id}`}
                      >
                        <Badge
                          variant="outline"
                          className="rounded-none border-border text-foreground hover:border-nc-cyan hover:text-nc-cyan cursor-pointer"
                        >
                          {c.name}
                          {c.archived && <span className="text-destructive ml-1">(archived)</span>}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                )}
              </Section>

              {/* Owned venues */}
              <Section icon={<Store className="w-4 h-4" />} title="STORES" count={profile.stores.length}>
                {profile.stores.length === 0 ? (
                  <Empty>No stores owned.</Empty>
                ) : (
                  <RowList>
                    {profile.stores.map((s) => (
                      <Row key={s.id} testId={`row-store-${s.id}`} when={fmt(s.createdAt)} href={`/directory/stores/${s.id}`}>
                        <span className="text-foreground">{s.name}</span>
                        {s.location && <span className="text-muted-foreground"> · {s.location}</span>}
                        <span className="text-nc-yellow"> · €${s.balance.toLocaleString()}</span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              <Section icon={<Stethoscope className="w-4 h-4" />} title="RIPPERDOCS" count={profile.ripperdocs.length}>
                {profile.ripperdocs.length === 0 ? (
                  <Empty>No ripperdocs owned.</Empty>
                ) : (
                  <RowList>
                    {profile.ripperdocs.map((r) => (
                      <Row key={r.id} testId={`row-ripperdoc-${r.id}`} when={fmt(r.createdAt)} href={`/directory/ripperdocs/${r.id}`}>
                        <span className="text-foreground">{r.name}</span>
                        {r.location && <span className="text-muted-foreground"> · {r.location}</span>}
                        <span className="text-nc-yellow"> · €${r.balance.toLocaleString()}</span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              {/* Mission participation */}
              <Section icon={<Briefcase className="w-4 h-4" />} title="MISSION PARTICIPATION" count={profile.missions.length}>
                {profile.missions.length === 0 ? (
                  <Empty>No mission assignments.</Empty>
                ) : (
                  <RowList>
                    {profile.missions.map((m) => (
                      <Row
                        key={m.id}
                        testId={`row-mission-${m.id}`}
                        when={fmt(m.missionStartAt || m.createdAt)}
                        href={m.missionId != null ? `/missions/${m.missionId}` : undefined}
                      >
                        <span className="text-foreground">{m.missionTitle ?? `Mission #${m.missionId ?? "?"}`}</span>
                        {m.characterName && <span className="text-nc-cyan"> · {m.characterName}</span>}
                        <span className="text-muted-foreground"> · {m.paymentStatus}</span>
                        {m.payAmount != null && <span className="text-nc-yellow"> · €${m.payAmount.toLocaleString()}</span>}
                        {m.attendanceCreditedAt && <span className="text-nc-cyan"> · attended</span>}
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              {/* Actor payments */}
              <Section icon={<Drama className="w-4 h-4" />} title="ACTOR / SESSION PAYOUTS" count={profile.actorPayments.length}>
                {profile.actorPayments.length === 0 ? (
                  <Empty>No actor payouts.</Empty>
                ) : (
                  <RowList>
                    {profile.actorPayments.map((a) => (
                      <Row key={a.id} testId={`row-actorpay-${a.id}`} when={fmt(a.missionDate || a.paidAt || a.createdAt)}>
                        <span className="text-foreground">{a.missionName ?? a.eventType ?? "Event"}</span>
                        {a.characterName && <span className="text-nc-cyan"> · {a.characterName}</span>}
                        <span className="text-muted-foreground"> · {a.paymentStatus}</span>
                        <span className="text-nc-yellow"> · €${a.amount.toLocaleString()}</span>
                        {a.fixerName && <span className="text-muted-foreground"> · by {a.fixerName}</span>}
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              {/* Attendance claims */}
              <Section icon={<CalendarCheck className="w-4 h-4" />} title="WEEKLY ATTENDS" count={profile.attendanceClaims.length}>
                {profile.attendanceClaims.length === 0 ? (
                  <Empty>No weekly attend claims.</Empty>
                ) : (
                  <RowList>
                    {profile.attendanceClaims.map((a) => (
                      <Row key={a.id} testId={`row-attend-${a.id}`} when={fmt(a.claimedAt)}>
                        <span className="text-foreground">Week of {a.weekStart}</span>
                        <span className="text-nc-yellow"> · €${a.amount.toLocaleString()}</span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              {/* Wallet transactions */}
              <Section icon={<Coins className="w-4 h-4" />} title="WALLET TRANSACTIONS" count={profile.walletTransactions.length}>
                {profile.walletTransactions.length === 0 ? (
                  <Empty>No wallet transactions.</Empty>
                ) : (
                  <RowList>
                    {profile.walletTransactions.map((t) => {
                      const venueHref =
                        t.counterpartyVenueKind === "store" && t.counterpartyVenueId != null
                          ? `/directory/stores/${t.counterpartyVenueId}`
                          : t.counterpartyVenueKind === "ripperdoc" && t.counterpartyVenueId != null
                            ? `/directory/ripperdocs/${t.counterpartyVenueId}`
                            : null;
                      const venueLabel = t.counterpartyName ?? t.counterpartyVenueName;
                      return (
                        <Row key={t.id} testId={`row-wallet-${t.id}`} when={fmt(t.createdAt)}>
                          <span className={t.amount < 0 ? "text-destructive" : "text-nc-green"}>{eddies(t.amount)}</span>
                          <span className="text-muted-foreground"> · {t.kind}</span>
                          {t.characterName &&
                            (t.characterId != null ? (
                              <>
                                {" · "}
                                <Link
                                  href={`/characters/${t.characterId}`}
                                  className="text-nc-cyan hover:underline cursor-pointer"
                                  data-testid={`link-wallet-character-${t.id}`}
                                >
                                  {t.characterName}
                                </Link>
                              </>
                            ) : (
                              <span className="text-nc-cyan"> · {t.characterName}</span>
                            ))}
                          {venueLabel &&
                            (venueHref ? (
                              <>
                                {" · "}
                                <Link
                                  href={venueHref}
                                  className="text-muted-foreground hover:text-nc-cyan hover:underline cursor-pointer"
                                  data-testid={`link-wallet-venue-${t.id}`}
                                >
                                  {venueLabel}
                                </Link>
                              </>
                            ) : (
                              <span className="text-muted-foreground"> · {venueLabel}</span>
                            ))}
                          {t.memo && <span className="text-muted-foreground/70"> · {t.memo}</span>}
                        </Row>
                      );
                    })}
                  </RowList>
                )}
              </Section>

              {/* Audit log */}
              <Section icon={<ScrollText className="w-4 h-4" />} title="AUDIT LOG" count={profile.auditEntries.length}>
                {profile.auditEntries.length === 0 ? (
                  <Empty>No audit entries.</Empty>
                ) : (
                  <RowList>
                    {profile.auditEntries.map((a) => (
                      <Row
                        key={a.id}
                        testId={`row-audit-${a.id}`}
                        when={fmt(a.createdAt)}
                        href={targetHref(a.targetType, a.targetId)}
                      >
                        <Badge variant="outline" className="rounded-none text-nc-magenta border-nc-magenta mr-2 text-[10px]">
                          {a.category}/{a.action}
                        </Badge>
                        <span className="text-muted-foreground">{a.message ?? `${a.targetType ?? ""} ${a.targetId ?? ""}`}</span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              {/* Activity feed */}
              <Section icon={<Activity className="w-4 h-4" />} title="ACTIVITY EVENTS" count={profile.activityEvents.length}>
                {profile.activityEvents.length === 0 ? (
                  <Empty>No activity events.</Empty>
                ) : (
                  <RowList>
                    {profile.activityEvents.map((e) => (
                      <Row key={e.id} testId={`row-activity-${e.id}`} when={fmt(e.createdAt)}>
                        <Badge variant="outline" className="rounded-none text-nc-cyan border-nc-cyan mr-2 text-[10px]">
                          {e.kind}
                        </Badge>
                        <span className="text-muted-foreground">{e.message}</span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="pb-2">
        <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
          <span className="text-nc-cyan">{icon}</span>
          {title} <span className="text-muted-foreground">({count})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function RowList({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1 font-mono text-sm">{children}</div>;
}

function Row({
  children,
  when,
  testId,
  href,
}: {
  children: React.ReactNode;
  when: string;
  testId?: string;
  href?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/30 pb-1" data-testid={testId}>
      {href ? (
        <Link href={href} className="min-w-0 break-words hover:text-nc-cyan hover:underline cursor-pointer">
          {children}
        </Link>
      ) : (
        <div className="min-w-0 break-words">{children}</div>
      )}
      <span className="text-xs text-muted-foreground whitespace-nowrap">{when}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground font-mono italic text-sm">{children}</div>;
}
