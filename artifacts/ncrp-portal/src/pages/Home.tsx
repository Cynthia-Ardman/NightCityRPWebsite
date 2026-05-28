import { useGetDashboardSummary, useGetRecentActivity, useListMyCharacters, useGetUpcomingBills } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Link } from "wouter";
import { Activity, Users, Store, Wallet, Clock, ArrowRight, Skull, Receipt, Home as HomeIcon, Syringe, FileText, ShieldCheck, LogIn, Cpu, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export default function Home() {
  const { data: user, isLoading: userLoading } = useAuthMe();

  if (userLoading) {
    return <div className="h-full flex items-center justify-center text-nc-cyan animate-pulse font-display text-2xl">LOADING_SYS_DATA...</div>;
  }

  if (!user) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-background/80 z-0" />
        <div className="relative z-10 max-w-3xl text-center space-y-8 p-6">
          <h1 className="text-6xl md:text-8xl font-display font-bold text-nc-cyan glitch-hover tracking-tighter" data-testid="text-hero-title">
            NIGHT CITY RP
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground font-mono" data-testid="text-hero-subtitle">
            The premier Cyberpunk roleplay experience. Manage your characters, eddies, and empire.
          </p>
          <div className="pt-8">
            <Button asChild size="lg" className="h-16 px-12 text-xl font-display bg-nc-magenta hover:bg-nc-magenta/80 text-foreground rounded-none shadow-[0_0_20px_rgba(255,0,255,0.4)] transition-all hover:shadow-[0_0_40px_rgba(255,0,255,0.6)]" data-testid="button-login-hero">
              <a href="/api/auth/discord/login">
                CONNECT TO SUBNET <ArrowRight className="ml-3 h-6 w-6" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <Dashboard />;
}

function Dashboard() {
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: characters, isLoading: charsLoading } = useListMyCharacters();
  // We'll skip recent activity if the hook isn't fully implemented or we just use characters

  if (summaryLoading || charsLoading) {
    return <div className="h-full flex items-center justify-center text-nc-cyan animate-pulse font-display text-2xl">SYNCING_DASHBOARD...</div>;
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-dashboard-title">SYS_OVERVIEW</h1>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={Users} label="Total Characters" value={summary.characterCount} color="cyan" href="/characters" />
          <StatCard icon={Wallet} label="Total Eddies" value={`€$${summary.totalEddies.toLocaleString()}`} color="yellow" href="/characters" />
          <StatCard icon={Store} label="Open Shops" value={summary.openShops} color="magenta" href="/stores" />
          <StatCard icon={Activity} label="Pending Sheets" value={summary.pendingSheets} color="red" href="/sheets/pending" />
        </div>
      )}

      {/* Layout flipped: characters live on /characters, so on the dashboard they
          collapse to a compact left-rail list. Bills / attendance / system logs
          are the actual reason you visit the dashboard, so they get the wide
          column. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="space-y-4 lg:order-1">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-display font-bold text-foreground" data-testid="text-my-chars-title">MY_CHARACTERS</h2>
            <Button asChild variant="outline" size="sm" className="border-nc-cyan text-nc-cyan rounded-none hover:bg-nc-cyan/10 h-7 px-2 text-xs">
              <Link href="/characters">VIEW_ALL</Link>
            </Button>
          </div>

          <Card className="rounded-none border-border bg-card/50">
            <CardContent className="p-0">
              {(!characters || characters.length === 0) ? (
                <div className="p-4 text-center text-muted-foreground font-mono text-xs">NO_CHARACTERS_FOUND.</div>
              ) : (
                <div className="divide-y divide-border/50 max-h-[640px] overflow-y-auto">
                  {characters.map(char => (
                    <Link key={char.id} href={`/characters/${char.id}`}>
                      <div className="p-2 flex items-center gap-3 hover:bg-nc-cyan/5 cursor-pointer group" data-testid={`row-dashboard-char-${char.id}`}>
                        <Avatar className="h-10 w-10 border border-border rounded-none group-hover:border-nc-cyan transition-colors shrink-0">
                          <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ''} className="object-cover" />
                          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
                            {char.name.substring(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="font-display text-sm truncate group-hover:text-nc-cyan transition-colors">{char.name}</div>
                          <div className="text-[10px] font-mono text-muted-foreground uppercase truncate">
                            {char.kind} · {char.archetype || 'UNKNOWN'}
                          </div>
                        </div>
                        <div className="text-[10px] font-mono shrink-0 flex flex-col items-end gap-0.5">
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <span className={`w-1.5 h-1.5 rounded-full ${char.isActive ? 'bg-nc-cyan' : 'bg-muted'}`} />
                            {char.isActive ? 'ACTIVE' : 'STANDBY'}
                          </span>
                          {char.approved && <span className="text-nc-cyan">APPROVED</span>}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6 lg:order-2">
          <AttendCard />
          <UpcomingBillsCard />
          <SystemLogsCard />
        </div>
      </div>
    </div>
  );
}

interface SystemLogRow {
  id: number;
  category: string;
  action: string;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  message: string | null;
  createdAt: string;
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return s <= 1 ? "just now" : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function iconForLog(row: SystemLogRow) {
  // Category-then-action shaping. Keep this synced with audit categories
  // wired in the API: auth | wallet | character | sheet | shop | inventory |
  // housing | attendance | admin | mission.
  if (row.category === "auth") return { Icon: LogIn, color: "text-nc-cyan" };
  if (row.category === "wallet") return { Icon: Wallet, color: "text-nc-yellow" };
  if (row.category === "housing") return { Icon: HomeIcon, color: "text-nc-yellow" };
  if (row.category === "sheet") return { Icon: FileText, color: "text-nc-cyan" };
  if (row.category === "shop") return { Icon: Store, color: "text-nc-magenta" };
  if (row.category === "attendance") return { Icon: Clock, color: "text-nc-cyan" };
  if (row.category === "mission") return { Icon: Activity, color: "text-nc-magenta" };
  if (row.category === "admin") return { Icon: ShieldCheck, color: "text-destructive" };
  if (row.category === "character") {
    if (/cyber|chrome/i.test(row.action) || /cyber|chrome/i.test(row.message ?? "")) {
      return { Icon: Cpu, color: "text-nc-magenta" };
    }
    return { Icon: Users, color: "text-nc-cyan" };
  }
  if (row.category === "inventory") return { Icon: Receipt, color: "text-nc-yellow" };
  return { Icon: Skull, color: "text-muted-foreground" };
}

function summarizeLog(row: SystemLogRow): string {
  if (row.message) return row.message;
  const who = row.actorName ?? "system";
  const verb = row.action.replace(/_/g, " ");
  return `${who} ${verb}`.trim();
}

function SystemLogsCard() {
  const { data, isLoading } = useQuery<SystemLogRow[]>({
    queryKey: ["me-system-log"],
    queryFn: async () => {
      const r = await fetch("/api/me/system-log?limit=15", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });
  return (
    <div className="space-y-3">
      <h2 className="text-2xl font-display font-bold text-foreground" data-testid="text-system-logs-title">SYSTEM_LOGS</h2>
      <Card className="rounded-none border-border bg-card/50 min-h-[200px]">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 font-mono text-sm text-nc-cyan animate-pulse">SYNCING_FEED...</div>
          ) : !data || data.length === 0 ? (
            <div className="p-4 font-mono text-sm text-muted-foreground">No recent activity.</div>
          ) : (
            <div className="divide-y divide-border/50 max-h-[420px] overflow-y-auto">
              {data.map((row) => {
                const { Icon, color } = iconForLog(row);
                return (
                  <div key={row.id} className="p-3 text-sm font-mono text-muted-foreground flex gap-3" data-testid={`row-system-log-${row.id}`}>
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground break-words">{summarizeLog(row)}</div>
                      <div className="text-xs opacity-50 mt-1 flex gap-2">
                        <span className="uppercase tracking-widest">{row.category}</span>
                        <span>·</span>
                        <span>{relTime(row.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface NpcRow {
  id: number;
  name: string;
  archetype: string | null;
  portraitUrl: string | null;
  portraitUrls?: string[] | null;
  ownerId?: string | null;
  ownerName?: string | null;
}

// Staff-only NPC roster card. ADMIN/FIXER see the top NPCs by recency so the
// dashboard makes it obvious who's been imported / claimed. Players don't
// see this panel — their assigned NPCs (if any) already render in
// MY_CHARACTERS via /characters (which filters by ownerId).
function NpcConsolePanel() {
  const { data: user } = useAuthMe();
  const isStaff = Boolean(user?.isAdmin || user?.isFixer);
  // /api/directory/characters returns a raw NpcRow[] (see directory.ts:121),
  // not the { items, total } envelope this card originally expected.
  // Crashing the dashboard with "n.items is undefined" otherwise.
  const { data, isLoading } = useQuery<NpcRow[]>({
    queryKey: ["dashboard-npcs"],
    queryFn: async () => {
      const r = await fetch("/api/directory/characters?scope=npc&limit=8", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: isStaff,
  });
  const items = (data ?? []).slice(0, 8);
  if (!isStaff) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-display font-bold text-foreground flex items-center gap-2" data-testid="text-npcs-title">
          <UserCog className="w-5 h-5 text-nc-magenta" /> NPCS
        </h2>
        <Button asChild variant="outline" size="sm" className="border-nc-magenta text-nc-magenta rounded-none hover:bg-nc-magenta/10">
          <Link href="/characters?scope=npc">MANAGE</Link>
        </Button>
      </div>
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 font-mono text-sm text-nc-cyan animate-pulse">LOADING_NPCS...</div>
          ) : items.length === 0 ? (
            <div className="p-4 font-mono text-sm text-muted-foreground">
              No NPCs yet. Run the importer or use Admin → Maintenance to load them.
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {items.map((npc) => (
                <Link key={npc.id} href={`/characters/${npc.id}`}>
                  <div className="p-3 flex items-center gap-3 hover:bg-nc-magenta/5 cursor-pointer" data-testid={`row-npc-${npc.id}`}>
                    <Avatar className="h-14 w-14 border border-border rounded-none">
                      <AvatarImage src={npc.portraitUrl || npc.portraitUrls?.[0] || ""} className="object-cover" />
                      <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display text-lg">
                        {npc.name.substring(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-sm truncate">{npc.name}</div>
                      <div className="text-xs font-mono text-muted-foreground truncate">
                        {npc.archetype || "—"} {npc.ownerName ? `· ${npc.ownerName}` : ""}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface AttendInfo {
  weekStart: string;
  payout: number;
  claimed: boolean;
  claimedAt: string | null;
  windowOpen: boolean;
  nextWindowOpensAt: string | null;
  windowHint: string;
  history: Array<{ weekStart: string; amount: number; claimedAt: string }>;
}

// Weekly attendance claim card on the home dashboard. The button is just
// a thin wrapper over POST /attendance/claim — the server is the source
// of truth for whether the user has already claimed this week (the
// UNIQUE (userId, weekStart) index in attendance_claims enforces it),
// the UI just disables the button on the obvious case so users don't
// burn UB roundtrips clicking 'CLAIM' five times in a row.
function AttendCard() {
  const qc = useQueryClient();
  const queryKey = ["attendance-me"] as const;
  const { data, isLoading } = useQuery<AttendInfo>({
    queryKey,
    queryFn: async () => {
      const r = await fetch("/api/attendance/me", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load attendance");
      return r.json();
    },
  });
  const claim = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/attendance/claim", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) throw new Error(body.error ?? `HTTP ${r.status}`);
      return body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  if (isLoading) return null;
  if (!data) return null;

  const windowOpen = data.windowOpen;
  const disabled = data.claimed || claim.isPending || !windowOpen;
  const buttonLabel = data.claimed
    ? "CLAIMED ✓"
    : claim.isPending
      ? "CLAIMING..."
      : !windowOpen
        ? "WINDOW CLOSED"
        : "CLAIM";
  return (
    <Card className="rounded-none border-nc-yellow/40 bg-nc-yellow/5">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-display tracking-widest text-nc-yellow text-sm">WEEKLY ATTENDANCE</div>
            <div className="text-xs text-muted-foreground font-mono mt-1">
              WEEK_OF {data.weekStart} · €${data.payout.toLocaleString()}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/80 mt-1 uppercase tracking-widest">
              {data.windowHint}
            </div>
          </div>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => claim.mutate()}
            className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest disabled:opacity-50"
            data-testid="button-attend-claim"
          >
            {buttonLabel}
          </Button>
        </div>
        {!windowOpen && !data.claimed && data.nextWindowOpensAt && (
          <div className="text-xs font-mono text-muted-foreground" data-testid="text-attend-next-window">
            NEXT_WINDOW: {new Date(data.nextWindowOpensAt).toLocaleString()}
          </div>
        )}
        {data.claimedAt && (
          <div className="text-xs font-mono text-muted-foreground">
            LAST_CLAIM: {new Date(data.claimedAt).toLocaleString()}
          </div>
        )}
        {claim.error instanceof Error && (
          <div className="text-xs font-mono text-destructive">ERR: {claim.error.message}</div>
        )}
      </CardContent>
    </Card>
  );
}

function formatDueDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.max(0, Math.round((d.getTime() - now.getTime()) / 86_400_000));
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days === 0) return `today (${dateStr})`;
  if (days === 1) return `in 1 day (${dateStr})`;
  return `in ${days} days (${dateStr})`;
}

function UpcomingBillsCard() {
  const { data, isLoading } = useGetUpcomingBills();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-display font-bold text-foreground flex items-center gap-2" data-testid="text-bills-title">
          <Receipt className="w-5 h-5 text-nc-yellow" /> UPCOMING_BILLS
        </h2>
      </div>
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-4 space-y-4">
          {isLoading ? (
            <div className="font-mono text-sm text-nc-cyan animate-pulse">CALCULATING...</div>
          ) : !data ? (
            <div className="font-mono text-sm text-muted-foreground">No bill data.</div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 text-center border border-border/50 p-3 bg-background/40">
                <div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Next Rent</div>
                  <div className="font-display text-lg text-nc-yellow" data-testid="text-bills-next-rent">€${data.totals.nextRent.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Meds / wk</div>
                  <div className="font-display text-lg text-destructive" data-testid="text-bills-meds-weekly">€${data.totals.nextMedsWeekly.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">~ / mo</div>
                  <div className="font-display text-lg text-foreground" data-testid="text-bills-monthly-estimate">€${data.totals.monthlyEstimate.toLocaleString()}</div>
                </div>
              </div>

              <BillSection
                icon={HomeIcon}
                color="text-nc-yellow"
                title="MONTHLY RENT"
                emptyHint="No PCs eligible for monthly rent."
                items={data.rent.map((r) => ({
                  key: `rent-${r.characterId}`,
                  primary: r.characterName,
                  secondary: `Due ${formatDueDate(r.dueAt)}`,
                  amount: r.amount,
                  to: `/characters/${r.characterId}`,
                }))}
              />

              <BillSection
                icon={Syringe}
                color="text-destructive"
                title="CYBERPSYCHOSIS MEDS (WEEKLY)"
                emptyHint="No character has 7+ chrome — no meds owed."
                items={data.meds.map((m) => ({
                  key: `meds-${m.anchorCharacterId ?? "player"}`,
                  primary: `Household bill${m.anchorCharacterName ? ` · top: ${m.anchorCharacterName}` : ""}`,
                  secondary: `${m.level} band · ${m.maxChromeCount} chrome · week ${m.weeksUnpaid}${m.multiplier > 1 ? ` · household x${m.multiplier}` : ""} · due ${formatDueDate(m.dueAt)}`,
                  amount: m.amount,
                  to: m.anchorCharacterId ? `/characters/${m.anchorCharacterId}` : undefined,
                }))}
              />

              {(data.cyberwareStatus.household > 0 || data.meds.length > 0) && (
                <div className="space-y-1 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-mono">
                  <div className="text-[10px] uppercase tracking-widest text-destructive">
                    Cyberware Status
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Last checkup</span>
                    <span className="text-foreground">
                      {data.cyberwareStatus.lastCheckupAt
                        ? formatDueDate(data.cyberwareStatus.lastCheckupAt)
                        : "never"}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Weeks unpaid</span>
                    <span className="text-foreground">{data.cyberwareStatus.weeksUnpaid}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Household chars billing meds</span>
                    <span className="text-foreground">
                      {data.cyberwareStatus.household}
                      {data.cyberwareStatus.multiplier > 1 ? ` · x${data.cyberwareStatus.multiplier}` : ""}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 italic pt-1">
                    Any ripperdoc checkup resets the streak for all your characters. Bands: 0-6 none · 7-9 medium · 10-12 high · 13+ extreme.
                  </div>
                </div>
              )}

              {data.leases.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    <HomeIcon className="w-3 h-3" /> ACTIVE LEASES
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/70 italic">
                    Listed for reference. Auto-billing currently uses the flat rent above, not per-lease pricing.
                  </div>
                  {data.leases.map((l) => (
                    <Link key={l.id} href={`/characters/${l.characterId}`}>
                      <div className="flex justify-between items-center text-sm font-mono border border-border/40 px-3 py-2 hover:border-nc-cyan/60 cursor-pointer" data-testid={`row-lease-${l.id}`}>
                        <div className="min-w-0">
                          <div className="truncate text-foreground">{l.address}</div>
                          <div className="text-xs text-muted-foreground truncate">{l.characterName}</div>
                        </div>
                        <div className="text-nc-yellow whitespace-nowrap">€${l.monthlyRent.toLocaleString()}/mo</div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              <div className="text-[10px] font-mono text-muted-foreground/60 pt-2 border-t border-border/30">
                Rent posts 1st of the month · meds post Mondays 05:00 UTC.
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BillSection({
  icon: Icon,
  color,
  title,
  items,
  emptyHint,
}: {
  icon: any;
  color: string;
  title: string;
  items: Array<{ key: string; primary: string; secondary: string; amount: number; to?: string }>;
  emptyHint: string;
}) {
  return (
    <div className="space-y-2">
      <div className={`text-xs font-mono uppercase tracking-widest flex items-center gap-2 ${color}`}>
        <Icon className="w-3 h-3" /> {title}
      </div>
      {items.length === 0 ? (
        <div className="text-xs font-mono text-muted-foreground italic">{emptyHint}</div>
      ) : (
        items.map((it) => {
          const row = (
            <div className={`flex justify-between items-center text-sm font-mono border border-border/40 px-3 py-2 ${it.to ? "hover:border-nc-cyan/60 cursor-pointer" : ""}`} data-testid={`row-${it.key}`}>
              <div className="min-w-0">
                <div className="truncate text-foreground">{it.primary}</div>
                <div className="text-xs text-muted-foreground truncate">{it.secondary}</div>
              </div>
              <div className={`whitespace-nowrap ${color}`}>€${it.amount.toLocaleString()}</div>
            </div>
          );
          return it.to ? (
            <Link key={it.key} href={it.to}>{row}</Link>
          ) : (
            <div key={it.key}>{row}</div>
          );
        })
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color, href }: { icon: any, label: string, value: string | number, color: 'cyan' | 'magenta' | 'yellow' | 'red', href?: string }) {
  const colorMap = {
    cyan: 'text-nc-cyan border-nc-cyan/30 bg-nc-cyan/5 shadow-[0_0_15px_rgba(0,255,255,0.05)] hover:border-nc-cyan/60',
    magenta: 'text-nc-magenta border-nc-magenta/30 bg-nc-magenta/5 shadow-[0_0_15px_rgba(255,0,255,0.05)] hover:border-nc-magenta/60',
    yellow: 'text-nc-yellow border-nc-yellow/30 bg-nc-yellow/5 shadow-[0_0_15px_rgba(255,255,0,0.05)] hover:border-nc-yellow/60',
    red: 'text-destructive border-destructive/30 bg-destructive/5 shadow-[0_0_15px_rgba(255,0,0,0.05)] hover:border-destructive/60'
  };

  const iconColorMap = {
    cyan: 'text-nc-cyan',
    magenta: 'text-nc-magenta',
    yellow: 'text-nc-yellow',
    red: 'text-destructive'
  };

  const card = (
    <Card className={`rounded-none border ${colorMap[color]} transition-all ${href ? 'hover:brightness-125 cursor-pointer' : 'hover:brightness-125'} h-full`} data-testid={`card-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="p-4 md:p-6 flex flex-col gap-2">
        <Icon className={`w-6 h-6 ${iconColorMap[color]}`} />
        <div className="text-3xl font-display font-bold text-foreground mt-2">{value}</div>
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest">{label}</div>
      </CardContent>
    </Card>
  );

  if (href) return <Link href={href}>{card}</Link>;
  return card;
}
