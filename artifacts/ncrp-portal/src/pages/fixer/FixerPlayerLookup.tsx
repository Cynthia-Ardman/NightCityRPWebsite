import { useEffect, useState } from "react";
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
  HeartPulse,
  Activity,
  ArrowLeft,
  FileEdit,
  FileX,
  Globe,
} from "lucide-react";

// Player-facing labels for custom-request (proposal) types.
const REQUEST_TYPE_LABEL: Record<string, string> = {
  property: "OFF-MAP HOUSING",
  gun: "GUN",
  cyberware: "CYBERWARE",
  item: "ITEM",
  store: "STORE",
  ripperdoc: "RIPPERDOC",
  venue_stock: "VENUE STOCK",
  stock_cost: "STOCK COST",
  employee_invite: "EMPLOYEE INVITE",
  mission_participation: "MISSION PARTICIPATION",
};

function fmt(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

// Imported attendance dates are calendar dates ("YYYY-MM-DD") with no time.
// Render them literally so a viewer's timezone can't shift the day.
function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
    undefined,
    { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" },
  );
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

  // Deep-link support: /fixer/players?userId=<id> opens that player's dossier
  // directly (used by the VRChat player search on the analytics page).
  useEffect(() => {
    const userId = new URLSearchParams(window.location.search).get("userId");
    if (userId) setSelectedId(userId);
  }, []);

  const searchParams = { q: query ?? undefined };
  const { data: results, isFetching: searching } = useSearchFixerPlayers(searchParams, {
    query: { queryKey: getSearchFixerPlayersQueryKey(searchParams), enabled: !!query },
  });

  const { data: profile, isFetching: loadingProfile } = useGetFixerPlayerActivity(selectedId ?? "", {
    query: { queryKey: getGetFixerPlayerActivityQueryKey(selectedId ?? ""), enabled: !!selectedId },
  });

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6 pb-12">
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

              {/* Character-sheet drafts (unsubmitted) */}
              <Section icon={<FileEdit className="w-4 h-4" />} title="CHARACTER DRAFTS" count={profile.drafts.length}>
                {profile.drafts.length === 0 ? (
                  <Empty>No unsubmitted drafts.</Empty>
                ) : (
                  <RowList>
                    {profile.drafts.map((d) => (
                      <Row key={d.id} testId={`row-draft-${d.id}`} when={fmt(d.createdAt)} href={`/sheets/${d.id}`}>
                        <span className="text-foreground">{d.name || "Untitled draft"}</span>
                        <Badge variant="outline" className="rounded-none text-nc-yellow border-nc-yellow ml-2 text-[10px]">
                          DRAFT
                        </Badge>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Section>

              {/* Rejected proposals (custom requests) — click to open in the review queue */}
              <Section icon={<FileX className="w-4 h-4" />} title="REJECTED PROPOSALS" count={profile.rejectedRequests.length}>
                {profile.rejectedRequests.length === 0 ? (
                  <Empty>No rejected proposals.</Empty>
                ) : (
                  <RowList>
                    {profile.rejectedRequests.map((r) => (
                      <Row key={r.id} testId={`row-rejected-request-${r.id}`} when={fmt(r.reviewedAt || r.createdAt)} href={`/requests?focus=${r.id}`}>
                        <span className="text-foreground break-words">{r.title}</span>
                        <Badge variant="outline" className="rounded-none text-nc-cyan border-nc-cyan ml-2 text-[10px]">
                          {REQUEST_TYPE_LABEL[r.type] ?? r.type.toUpperCase()}
                        </Badge>
                        <Badge variant="outline" className="rounded-none text-nc-magenta border-nc-magenta ml-2 text-[10px]">
                          REJECTED
                        </Badge>
                        {r.reviewerNote ? (
                          <span className="block w-full text-xs text-muted-foreground italic mt-0.5 break-words">"{r.reviewerNote}"</span>
                        ) : null}
                      </Row>
                    ))}
                  </RowList>
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

              {/* Cyberware checkup history (who performed each checkup + per-char status) */}
              <Section icon={<HeartPulse className="w-4 h-4" />} title="CYBERWARE CHECKUPS" count={profile.checkups.length}>
                {(() => {
                  // Per-character checkup status summary (only characters with
                  // any checkup signal — skip chars that never had chrome).
                  const withStatus = profile.characters.filter(
                    (c) => c.lastCheckupAt != null || (c.checkupStreak ?? 0) > 0,
                  );
                  return (
                    <>
                      {withStatus.length > 0 && (
                        <div className="flex flex-wrap gap-2 font-mono text-xs mb-3">
                          {withStatus.map((c) => (
                            <Badge
                              key={c.id}
                              variant="outline"
                              className="rounded-none border-border text-muted-foreground"
                              data-testid={`chip-checkup-status-${c.id}`}
                            >
                              <span className="text-foreground mr-1">{c.name}:</span>
                              last {fmt(c.lastCheckupAt)}
                              {(c.checkupStreak ?? 0) > 0 && (
                                <span className="text-nc-magenta ml-1">
                                  · {c.checkupStreak} wk{(c.checkupStreak ?? 0) === 1 ? "" : "s"} missed
                                </span>
                              )}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {profile.checkups.length === 0 ? (
                        <Empty>No recorded checkups.</Empty>
                      ) : (
                        <RowList>
                          {profile.checkups.map((ck) => (
                            <Row
                              key={ck.id}
                              testId={`row-checkup-${ck.id}`}
                              when={fmt(ck.createdAt)}
                              href={ck.characterId != null ? `/characters/${ck.characterId}` : undefined}
                            >
                              {ck.characterName && <span className="text-nc-cyan">{ck.characterName}</span>}
                              <span className="text-foreground"> · checkup</span>
                              {ck.actorName && <span className="text-muted-foreground"> · by {ck.actorName}</span>}
                              {ck.level && <span className="text-nc-yellow"> · band: {ck.level}</span>}
                            </Row>
                          ))}
                        </RowList>
                      )}
                    </>
                  );
                })()}
              </Section>

              {/* Meds / cyberware charge history (weekly meds bills, install fees) */}
              <Section icon={<Stethoscope className="w-4 h-4" />} title="MEDS / CYBERWARE CHARGES" count={profile.medsCharges.length}>
                {profile.medsCharges.length === 0 ? (
                  <Empty>No cyberware charges.</Empty>
                ) : (
                  <RowList>
                    {profile.medsCharges.map((m) => (
                      <Row
                        key={m.id}
                        testId={`row-medscharge-${m.id}`}
                        when={fmt(m.createdAt)}
                        href={m.characterId != null ? `/characters/${m.characterId}` : undefined}
                      >
                        <span className={m.amount < 0 ? "text-destructive" : "text-nc-green"}>{eddies(m.amount)}</span>
                        {m.characterName && <span className="text-nc-cyan"> · {m.characterName}</span>}
                        <span className="text-muted-foreground"> · {m.kind}</span>
                        {m.memo && <span className="text-muted-foreground/70"> · {m.memo}</span>}
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

              {/* Imported mission appearances (from the community attendance sheet) */}
              {profile.historicalAppearances && (
                <Section
                  icon={<CalendarCheck className="w-4 h-4" />}
                  title="MISSION APPEARANCES (IMPORTED)"
                  count={profile.historicalAppearances.count}
                >
                  {profile.historicalAppearances.dates.length === 0 ? (
                    <Empty>No imported appearance dates.</Empty>
                  ) : (
                    <RowList>
                      {profile.historicalAppearances.dates.map((d, i) => (
                        <Row key={`appearance-${i}`} testId={`row-appearance-${i}`} when={fmtDate(d)}>
                          <span className="text-foreground">Mission appearance</span>
                        </Row>
                      ))}
                    </RowList>
                  )}
                </Section>
              )}

              {/* VRChat instance attendance (from imported VRCX gamelogs) */}
              {profile.vrchatAttendance && (
                <Section
                  icon={<Globe className="w-4 h-4" />}
                  title="VRCHAT ATTENDANCE"
                  count={profile.vrchatAttendance.totalVisits}
                >
                  <div className="font-mono text-xs text-muted-foreground mb-2" data-testid="text-vr-attendance-summary">
                    {profile.vrchatAttendance.vrchatUsername ?? profile.vrchatAttendance.vrchatUserId}
                    {" · "}
                    {profile.vrchatAttendance.matchKind === "linked" ? "linked via #vrchat-username" : "matched by display name"}
                    {" · "}
                    {profile.vrchatAttendance.totalVisits} visits · {profile.vrchatAttendance.totalHours.toLocaleString()}h total
                  </div>
                  {profile.vrchatAttendance.visits.length === 0 ? (
                    <Empty>No recorded instance visits.</Empty>
                  ) : (
                    <RowList>
                      {profile.vrchatAttendance.visits.map((v) => (
                        <Row key={v.id} testId={`row-vr-visit-${v.id}`} when={fmt(v.joinedAt)}>
                          <span className="text-foreground">{v.worldName}</span>
                          <span className="text-nc-cyan"> · {Math.round(v.durationMs / 60_000)}m</span>
                          {!v.leftAt && <span className="text-muted-foreground"> · open at import</span>}
                        </Row>
                      ))}
                    </RowList>
                  )}
                </Section>
              )}

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
                      const counterpartyHref =
                        t.counterpartyCharacterId != null ? `/characters/${t.counterpartyCharacterId}` : venueHref;
                      const counterpartyLabel =
                        t.counterpartyName ?? t.counterpartyCharacterName ?? t.counterpartyVenueName;
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
                          {counterpartyLabel &&
                            (counterpartyHref ? (
                              <>
                                {" · "}
                                <Link
                                  href={counterpartyHref}
                                  className="text-muted-foreground hover:text-nc-cyan hover:underline cursor-pointer"
                                  data-testid={
                                    t.counterpartyCharacterId != null
                                      ? `link-wallet-counterparty-character-${t.id}`
                                      : `link-wallet-venue-${t.id}`
                                  }
                                >
                                  {counterpartyLabel}
                                </Link>
                              </>
                            ) : (
                              <span className="text-muted-foreground"> · {counterpartyLabel}</span>
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
