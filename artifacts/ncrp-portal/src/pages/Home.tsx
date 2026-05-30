import { useGetDashboardSummary, useGetRecentActivity, useListMyCharacters, useGetUpcomingBills, useListMyMissions, getCharacterStatus, updateCharacterStatus, getGetCharacterStatusQueryKey, type MissionSummary } from "@workspace/api-client-react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Link } from "wouter";
import { Activity, Users, Store, Wallet, Clock, ArrowRight, Skull, Receipt, Home as HomeIcon, Syringe, FileText, ShieldCheck, LogIn, Cpu, UserCog, Briefcase, MapPin } from "lucide-react";
import { missionStatusClass, missionStatusLabel, missionTierClass, missionTierLabel } from "@/lib/missionStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Switch as UiSwitch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";

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
  const { data: user } = useAuthMe();
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: characters, isLoading: charsLoading } = useListMyCharacters();
  // We'll skip recent activity if the hook isn't fully implemented or we just use characters

  if (summaryLoading || charsLoading) {
    return <div className="h-full flex items-center justify-center text-nc-cyan animate-pulse font-display text-2xl">SYNCING_DASHBOARD...</div>;
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-dashboard-title">SYS_OVERVIEW</h1>
        {user?.vrchat ? (
          <a
            href={user.vrchat.vrchatUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-muted-foreground hover:text-nc-magenta"
            data-testid="link-my-vrchat"
          >
            VRCHAT: <span className="text-nc-magenta">{user.vrchat.vrchatUsername}</span>
          </a>
        ) : null}
      </div>

      <PlayerLoaControl characters={characters ?? []} />

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={Users} label="Total Characters" value={summary.characterCount} color="cyan" href="/characters" />
          <StatCard icon={Wallet} label="Total Eddies" value={`€$${summary.totalEddies.toLocaleString()}`} color="yellow" href="/characters" />
          <StatCard icon={Store} label="Open Shops" value={summary.openShops} color="magenta" href="/stores" />
          <StatCard icon={Activity} label="Pending Sheets" value={summary.pendingSheets} color="red" href="/sheets/pending" />
        </div>
      )}

      <NextMissionBanner />

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
          <PendingMissionsCard />
          <AttendCard />
          <ShopOpenCard characters={characters ?? []} />
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

// Hero banner for the caller's next upcoming ACCEPTED mission — i.e. one they
// were assigned to (their application was accepted) that is still upcoming and
// active (open/pending) with a future start time. Picks the soonest. Renders in
// the viewer's local time. Hidden entirely when there is nothing upcoming.
function NextMissionBanner() {
  const { data: missions } = useListMyMissions();
  const now = Date.now();
  const next = (missions ?? [])
    .filter(
      (m: MissionSummary) =>
        (m.status === "open" || m.status === "pending") &&
        !!m.startAt &&
        new Date(m.startAt).getTime() > now,
    )
    .sort(
      (a: MissionSummary, b: MissionSummary) =>
        new Date(a.startAt!).getTime() - new Date(b.startAt!).getTime(),
    )[0];

  if (!next) return null;

  const start = new Date(next.startAt!);
  const diffMs = start.getTime() - now;
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const countdown =
    days > 0 ? `in ${days}d ${hours}h` : hours > 0 ? `in ${hours}h` : "starting soon";
  const whenStr = `${start.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} · ${start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <Link href={`/missions/${next.id}`}>
      <Card
        className="rounded-none border-nc-magenta/50 bg-gradient-to-r from-nc-magenta/15 via-nc-magenta/5 to-transparent hover:border-nc-magenta cursor-pointer group shadow-[0_0_20px_rgba(255,0,255,0.15)]"
        data-testid="card-next-mission"
      >
        <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Briefcase className="w-6 h-6 text-nc-magenta shrink-0" />
            <div className="min-w-0">
              <div className="text-[10px] font-mono tracking-widest text-nc-magenta uppercase">
                Next Mission · {countdown}
              </div>
              <div className="font-display text-lg md:text-xl text-foreground truncate group-hover:text-nc-magenta transition-colors" data-testid="text-next-mission-title">
                {next.title}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground uppercase">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" /> {whenStr}
            </span>
            {next.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3" /> {next.location}
              </span>
            )}
            {next.myCharacterName && (
              <span className="flex items-center gap-1 text-nc-cyan">
                <Users className="w-3 h-3" /> {next.myCharacterName}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// Shows the signed-in player the missions they're assigned to that haven't
// wrapped yet (open / pending). Dates render in the viewer's local time. Once a
// mission is completed/cancelled/paid it drops out of this list automatically.
function PendingMissionsCard() {
  const { data: missions, isLoading } = useListMyMissions();
  const pending = (missions ?? []).filter(
    (m: MissionSummary) => m.status === "open" || m.status === "pending",
  );

  if (isLoading || pending.length === 0) return null;

  const fmtWhen = (iso: string | null | undefined): string => {
    if (!iso) return "Not scheduled";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Not scheduled";
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest flex items-center gap-2 text-foreground">
          <Briefcase className="w-4 h-4 text-nc-magenta" /> PENDING_MISSIONS
        </CardTitle>
        <Button asChild variant="outline" size="sm" className="border-nc-magenta text-nc-magenta rounded-none hover:bg-nc-magenta/10 h-7 px-2 text-xs">
          <Link href="/missions">VIEW_ALL</Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/50">
          {pending.map((m: MissionSummary) => (
            <Link key={m.id} href={`/missions/${m.id}`}>
              <div className="p-3 hover:bg-nc-magenta/5 cursor-pointer group" data-testid={`row-dashboard-mission-${m.id}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-display text-sm text-foreground group-hover:text-nc-magenta transition-colors">{m.title}</span>
                  <Badge variant="outline" className={`rounded-none text-[10px] font-bold tracking-widest uppercase ${missionTierClass(m.tier)}`}>
                    {missionTierLabel(m.tier)}
                  </Badge>
                  <Badge variant="outline" className={`rounded-none text-[10px] font-bold tracking-widest uppercase ${missionStatusClass(m.status)}`}>
                    {missionStatusLabel(m.status)}
                  </Badge>
                </div>
                <div className="mt-1 flex items-center gap-4 text-[10px] font-mono text-muted-foreground uppercase">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {fmtWhen(m.startAt)}
                  </span>
                  {m.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> {m.location}
                    </span>
                  )}
                  {m.myCharacterName && (
                    <span className="flex items-center gap-1 text-nc-cyan">
                      <Users className="w-3 h-3" /> {m.myCharacterName}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
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

// Single per-PLAYER Leave of Absence control. LOA is stored per character
// server-side (it drives rent-billing skips), so toggling this fans the change
// out across every one of the player's characters at once: ON puts them all on
// leave, OFF brings them all back.
function PlayerLoaControl({ characters }: { characters: Array<{ id: number; name: string }> }) {
  const qc = useQueryClient();
  const statusQueries = useQueries({
    queries: characters.map((c) => ({
      queryKey: getGetCharacterStatusQueryKey(c.id),
      queryFn: () => getCharacterStatus(c.id),
    })),
  });

  const setAll = useMutation({
    mutationFn: async (v: boolean) => {
      await Promise.all(characters.map((c) => updateCharacterStatus(c.id, { loa: v })));
    },
    onSuccess: () => {
      for (const c of characters) {
        qc.invalidateQueries({ queryKey: getGetCharacterStatusQueryKey(c.id) });
      }
    },
  });

  if (characters.length === 0) return null;

  const allLoaded = statusQueries.every((q) => q.data);
  const anyLoading = statusQueries.some((q) => q.isLoading);
  // "On leave" only when every character is flagged LOA; mixed/partial states
  // read as OFF so a single toggle re-asserts the player-wide intent.
  const onLeave = allLoaded && statusQueries.every((q) => q.data?.loa === true);
  const disabled = anyLoading || setAll.isPending;

  return (
    <Card className="rounded-none border-nc-cyan/40 bg-nc-cyan/5" data-testid="card-player-loa">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-display tracking-widest text-nc-cyan text-sm">LEAVE OF ABSENCE</div>
            <div className="text-xs text-muted-foreground font-mono mt-1">
              {onLeave
                ? "You're on leave — billing paused for all your characters."
                : "Toggle on to pause all your characters while you're away."}
            </div>
          </div>
          <UiSwitch
            checked={onLeave}
            disabled={disabled}
            onCheckedChange={(v) => setAll.mutate(v)}
            data-testid="switch-player-loa"
          />
        </div>
        {setAll.error instanceof Error && (
          <div className="text-xs font-mono text-destructive mt-2">ERR: {setAll.error.message}</div>
        )}
      </CardContent>
    </Card>
  );
}

// "Open shop today" daily actions — one per shop-owning character. Treated like
// the weekly attendance claim (a Sunday-only income action). ShopOpenSection
// renders null for characters without an active business lease, so players who
// run no shops see nothing here.
function ShopOpenCard({ characters }: { characters: Array<{ id: number; name: string }> }) {
  if (!characters || characters.length === 0) return null;
  return (
    <div className="space-y-4">
      {characters.map((c) => (
        <ShopOpenSection key={c.id} characterId={c.id} name={c.name} />
      ))}
    </div>
  );
}

interface ShopOpenInfo {
  characterId: number;
  canOpen: boolean;
  openedToday: boolean;
  opensThisMonth: number;
  opensCountedForIncome: number;
  businessLeases: Array<{ id: number; address: string; monthlyRent: number }>;
  history: Array<{ openedOn: string; openedAt: string }>;
}

// Hidden entirely when the character has no active business lease — there's
// no useful UI for "you can't open a shop you don't own."
function ShopOpenSection({ characterId, name }: { characterId: number; name?: string }) {
  const qc = useQueryClient();
  const queryKey = ["character-shop", characterId] as const;
  const { data, isLoading } = useQuery<ShopOpenInfo>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`/api/characters/${characterId}/shop`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load shop status");
      return r.json();
    },
  });
  const open = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/characters/${characterId}/open-shop`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok && r.status !== 409) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  if (isLoading || !data) return null;
  if (!data.canOpen) return null;

  const lease = data.businessLeases[0];
  const capped = data.opensThisMonth > data.opensCountedForIncome;
  const disabled = data.openedToday || open.isPending;

  return (
    <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-display tracking-widest text-nc-magenta text-sm">
            {name ? `SHOP — ${name.toUpperCase()}` : "SHOP STATUS"}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {lease ? `${lease.address} · €$${lease.monthlyRent.toLocaleString()}/mo` : "Business lease"}
          </div>
        </div>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => open.mutate()}
          className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest disabled:opacity-50"
          data-testid={`button-open-shop-today-${characterId}`}
        >
          {data.openedToday ? "OPENED TODAY ✓" : open.isPending ? "OPENING..." : "OPEN SHOP TODAY"}
        </Button>
      </div>
      <div className="text-xs font-mono text-muted-foreground">
        OPENS_THIS_MONTH: <span className="text-nc-cyan">{data.opensCountedForIncome}/4</span>
        {capped && <span className="text-nc-yellow"> (+{data.opensThisMonth - data.opensCountedForIncome} past cap)</span>}
        {" · "}NEXT_CHARGE: monthly rent cycle
      </div>
      {open.error instanceof Error && (
        <div className="text-xs font-mono text-destructive">ERR: {open.error.message}</div>
      )}
    </div>
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
                title="BASELINE LIVING COST"
                emptyHint="No PCs eligible for baseline living cost."
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
                emptyHint={medsEmptyHint(data.cyberwareStatus)}
                items={data.meds.map((m) => ({
                  key: `meds-${m.anchorCharacterId ?? "player"}`,
                  primary: `Household bill${m.anchorCharacterName ? ` · top: ${m.anchorCharacterName}` : ""}`,
                  secondary: `${m.level} band · ${m.maxChromeCount} CWP · week ${m.weeksUnpaid}${m.multiplier > 1 ? ` · household x${m.multiplier}` : ""} · due ${formatDueDate(m.dueAt)}`,
                  amount: m.amount,
                  to: m.anchorCharacterId ? `/characters/${m.anchorCharacterId}` : undefined,
                }))}
              />

              {/* Always render so the checkup history, multiplier and band
                  breakdown stay visible even when the household isn't being
                  billed this week (e.g. just had a checkup, or no PC is
                  above 7 CWP yet). */}
              <CyberwareStatusPanel status={data.cyberwareStatus} />

              {data.leases.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    <HomeIcon className="w-3 h-3" /> ACTIVE LEASES
                  </div>
                  <div className="text-xs font-mono text-muted-foreground italic leading-relaxed">
                    Per-lease rent — included in the Next Rent total above.
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

              <div className="text-xs font-mono text-muted-foreground/80 pt-2 border-t border-border/30 leading-relaxed">
                Rent posts 1st of the month · meds post Mondays 05:00 UTC.
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Cyberware status panel — 4 labelled stats with hover tooltips that
// explain what each number means and (for the character count) which PCs
// are driving the household band. Replaces the older opaque
// "household chars billing meds · x1.5" line so players can see why
// they're being billed at the current band.
type CyberwareStatusShape = {
  lastCheckupAt?: string | null;
  weeksUnpaid: number;
  household: number;
  multiplier: number;
  topBand: string;
  breakdown: Array<{ characterId: number; characterName: string; chromeCount: number; band: string }>;
};

// Explain WHY no meds are owed this week so the player doesn't think
// the system is broken. Priority: recent checkup > nobody at risk >
// generic fallback.
function medsEmptyHint(status: CyberwareStatusShape): string {
  const anyAtRisk = status.breakdown.some((b) => b.chromeCount >= 7);
  if (status.weeksUnpaid <= 1 && status.lastCheckupAt) {
    return "Last checkup within the week — no meds owed.";
  }
  if (!anyAtRisk) {
    return "No character has 7+ CWP — no meds owed.";
  }
  return "No meds owed this week.";
}

function bandLabel(band: string): string {
  if (band === "none") return "None";
  return band.charAt(0).toUpperCase() + band.slice(1);
}

function bandColorClass(band: string): string {
  switch (band) {
    case "extreme": return "text-destructive";
    case "high": return "text-nc-magenta";
    case "medium": return "text-nc-yellow";
    default: return "text-foreground";
  }
}

function CyberwareStatusPanel({ status }: { status: CyberwareStatusShape }) {
  // Show every PC that has ANY chrome, sorted hi→lo. Each row is colored
  // by its own band so the player can see at a glance which characters
  // are in the danger zone, instead of having to mouse over a cramped
  // tooltip. Anyone <7 CWP is dimmed but still listed for context.
  const rows = [...status.breakdown].sort((a, b) => b.chromeCount - a.chromeCount);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3 border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm font-mono">
        <div className="text-xs uppercase tracking-widest text-destructive">
          Cyberware Status
        </div>

        <StatRow
          label="Last Checkup"
          value={status.lastCheckupAt ? formatDueDate(status.lastCheckupAt) : "never"}
          tooltip={
            <>
              <p className="font-semibold text-nc-cyan">How checkups work</p>
              <p>
                Ripperdoc checkups (RP or Text RP) reset the streak for
                <span className="text-foreground"> your whole household</span> —
                one visit on any character covers everyone.
              </p>
            </>
          }
        />

        <StatRow
          label="Weeks Without Checkup"
          value={String(status.weeksUnpaid)}
          tooltip={
            <>
              <p className="font-semibold text-nc-cyan">Weekly bill formula</p>
              <p>
                <span className="text-foreground">charge = floor((bandCap / 128) × 2<sup>weeks − 1</sup>)</span>,
                clamped to the band cap, then × household multiplier.
              </p>
              <p className="text-muted-foreground">
                Doubles every week without a checkup. Capped at 12 weeks.
              </p>
            </>
          }
        />

        <StatRow
          label="Top Cyberware Band"
          value={<span className={`font-semibold ${bandColorClass(status.topBand)}`}>{bandLabel(status.topBand)}</span>}
          tooltip={
            <>
              <p className="font-semibold text-nc-cyan">Cyberware bands</p>
              <ul className="space-y-0.5">
                <li><span className="text-nc-yellow">Medium</span> — 7-9 CWP</li>
                <li><span className="text-nc-magenta">High</span> — 10-12 CWP</li>
                <li><span className="text-destructive">Extreme</span> — 13+ CWP</li>
              </ul>
              <p className="text-muted-foreground">
                Driven by your highest-CWP character. NPCs don't count.
              </p>
            </>
          }
        />

        {status.multiplier > 1 ? (
          <StatRow
            label="Household Multiplier"
            value={<span className="font-semibold text-foreground">×{status.multiplier}</span>}
            tooltip={
              <>
                <p className="font-semibold text-nc-cyan">Household scaling</p>
                <p>
                  +25% per extra PC at <span className="text-foreground">7+ CWP</span>.
                  More chrome under one roof = more risk.
                </p>
              </>
            }
          />
        ) : null}

        {/* Inline per-character breakdown — promoted out of a tooltip so it's
            always readable. Each row colored by its own band. */}
        <div className="pt-2 border-t border-destructive/20">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
            Your Characters · {status.household} billable
          </div>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No PC has any cyberware yet — no meds owed.
            </div>
          ) : (
            <div className="space-y-1">
              {rows.map((b) => {
                const billable = b.chromeCount >= 7;
                return (
                  <div key={b.characterId} className="flex justify-between items-baseline gap-3 text-xs">
                    <span className={billable ? "text-foreground" : "text-muted-foreground"}>
                      {b.characterName}
                    </span>
                    <span className="flex items-baseline gap-2 whitespace-nowrap">
                      <span className={billable ? "text-foreground font-semibold" : "text-muted-foreground"}>
                        {b.chromeCount} CWP
                      </span>
                      <span className={`text-[10px] uppercase tracking-wider ${bandColorClass(b.band)}`}>
                        {bandLabel(b.band)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function StatRow({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: React.ReactNode;
  tooltip: React.ReactNode;
}) {
  return (
    <div className="flex justify-between items-start gap-3 text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 cursor-help">
            {label}
            <HelpCircle className="w-3 h-3 opacity-60" />
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="w-[320px] max-w-[calc(100vw-2rem)] bg-background border border-nc-cyan/60 text-foreground font-mono text-sm px-4 py-3 leading-relaxed space-y-2 shadow-lg shadow-nc-cyan/10"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <span className="text-foreground text-right">{value}</span>
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
            <div className={`flex justify-between items-start gap-3 text-sm font-mono border border-border/40 px-3 py-2 ${it.to ? "hover:border-nc-cyan/60 cursor-pointer" : ""}`} data-testid={`row-${it.key}`}>
              <div className="min-w-0 flex-1">
                <div className="text-foreground break-words">{it.primary}</div>
                <div className="text-xs text-muted-foreground break-words leading-relaxed">{it.secondary}</div>
              </div>
              <div className={`whitespace-nowrap ${color} font-display`}>€${it.amount.toLocaleString()}</div>
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
