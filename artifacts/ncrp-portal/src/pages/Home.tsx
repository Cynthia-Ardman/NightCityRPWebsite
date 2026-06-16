import { useGetDashboardSummary, useGetRecentActivity, useListMyCharacters, useListMyStores, useListMyRipperdocs, useGetUpcomingBills, useListMyMissions, useListMissions, useListEvents, getListMissionsQueryKey, getListEventsQueryKey, useGetReviewUnseenCounts, getGetReviewUnseenCountsQueryKey, getCharacterStatus, updateCharacterStatus, getGetCharacterStatusQueryKey, useGetIncomeStatus, useRunIncomeWork, useRunIncomeSlut, getGetIncomeStatusQueryKey, type MissionSummary, type EventView, type IncomeCommandResult } from "@workspace/api-client-react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Link } from "wouter";
import { Activity, Users, Store, Wallet, Clock, ArrowRight, Skull, Receipt, Home as HomeIcon, Syringe, FileText, ShieldCheck, LogIn, Cpu, UserCog, Briefcase, MapPin, ClipboardList, History, CalendarDays, PartyPopper, UserPlus } from "lucide-react";
import { expandOccurrences } from "@/lib/eventRecurrence";
import { useQuickNpcSignup } from "@/lib/useQuickNpcSignup";
import { missionStatusClass, missionStatusLabel, missionTierClass, missionTierLabel } from "@/lib/missionStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Switch as UiSwitch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";
import BecomeNpcButton from "@/components/BecomeNpcButton";
import LiveInstances from "@/components/LiveInstances";
import { useDismissNotificationPrompt, getGetMeQueryKey } from "@workspace/api-client-react";
import { Bell, X } from "lucide-react";
import ncrpBanner from "@assets/NCRP_GroupBanner_1780331827566.png";
import ncrpLogo from "@assets/image_1780331782394.png";

function BrandedLoader({ label }: { label: string }) {
  return (
    <div className="h-full min-h-[60vh] flex flex-col items-center justify-center gap-4">
      <img
        src={ncrpLogo}
        alt="NCRP"
        className="h-48 w-48 md:h-64 md:w-64 object-contain animate-pulse drop-shadow-[0_0_30px_rgba(0,255,255,0.5)]"
        data-testid="img-loader-logo"
      />
      <div className="text-nc-cyan animate-pulse font-display text-2xl tracking-widest">{label}</div>
    </div>
  );
}

export default function Home() {
  const { data: user, isLoading: userLoading } = useEffectiveMe();

  if (userLoading) {
    return <BrandedLoader label="LOADING_SYS_DATA..." />;
  }

  if (!user) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-background/80 z-0" />
        <div className="relative z-10 max-w-3xl text-center space-y-8 p-6">
          <img
            src={ncrpBanner}
            alt="Night City RP"
            className="w-full max-w-2xl mx-auto border border-nc-cyan/30 shadow-[0_0_30px_rgba(0,255,255,0.15)]"
            data-testid="img-hero-banner"
          />
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
  const { data: user } = useEffectiveMe();
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: characters, isLoading: charsLoading } = useListMyCharacters();
  // We'll skip recent activity if the hook isn't fully implemented or we just use characters

  // Contextual stat cards: only surface what's relevant to *this* viewer.
  // The pending-review cards are staff-only, so the request is only fired for
  // staff and each card is hidden when its queue is empty. (Total Eddies was
  // removed here — it's already shown in the top-right header.)
  const isStaff = Boolean(user?.isAdmin || user?.isFixer || user?.isCsApprover);
  // BOTH review cards count the ACTIONABLE, UNSEEN-by-me queue from the single
  // /review/unseen-counts source that also drives the sidebar "Pending" badge.
  // "Unseen" (not "unvoted") is the right metric: it excludes the viewer's OWN
  // submissions and any item they've already opened, so the card clears the
  // moment they look — matching what the user perceives as "nothing new /
  // unread". The old sheets card used a separate "pending sheets I haven't
  // VOTED on" tally, which stayed lit after the reviewer had seen everything
  // (the recurring phantom "Sheets to Review: N with nothing new" bug).
  const { data: reviewUnseen } = useGetReviewUnseenCounts({
    query: { enabled: isStaff, queryKey: getGetReviewUnseenCountsQueryKey() },
  });
  const pendingRequestCount = reviewUnseen?.requests ?? 0;
  const pendingSheetCount = reviewUnseen?.sheets ?? 0;

  if (summaryLoading || charsLoading) {
    return <BrandedLoader label="SYNCING_DASHBOARD..." />;
  }

  const statCards = summary
    ? [
        ...(isStaff && pendingSheetCount > 0
          ? [<StatCard key="sheets" icon={FileText} label="Sheets to Review" value={pendingSheetCount} color="red" href="/requests?tab=sheets" />]
          : []),
        ...(isStaff && pendingRequestCount > 0
          ? [<StatCard key="requests" icon={ClipboardList} label="Requests to Review" value={pendingRequestCount} color="magenta" href="/requests" />]
          : []),
      ]
    : [];
  return (
    <div className="space-y-8 pb-12">
      <div className="space-y-8 max-w-7xl mx-auto">
      <div className="relative overflow-hidden border border-nc-cyan/20">
        <img
          src={ncrpBanner}
          alt="Night City RP"
          className="w-full h-32 md:h-44 object-cover object-center"
          data-testid="img-dashboard-banner"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
      </div>
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

      <BecomeNpcButton variant="dashboard" />

      <NotificationPrefsPrompt />

      <NextMissionBanner />

      <NpcSessionBanner />
      </div>

      {/* Live VRChat instances span the full dashboard width (not capped at
          max-w-7xl) so the open-instance cards have room to breathe. */}
      <LiveInstances />

      <div className="space-y-8 max-w-7xl mx-auto">
      {/* Contextual top row: staff-only queue cards, the weekly attendance
          claim, and a per-character "open shop today" button all share ONE
          responsive auto-fit grid. Every tile is conditional, so they pack
          together and stretch to fill the row. Cards reflow onto new rows as
          more appear. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        {statCards}
        <IncomeCard />
        <AttendCard />
        {(characters ?? []).map((c) => (
          <ShopOpenSection key={c.id} characterId={c.id} name={c.name} />
        ))}
      </div>

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
                  {[...characters]
                    .sort((a, b) => (a.kind === 'pc' ? 0 : 1) - (b.kind === 'pc' ? 0 : 1))
                    .map(char => (
                    <Link key={char.id} href={`/characters/${char.id}`}>
                      <div className="p-2 flex items-center gap-3 hover:bg-nc-cyan/5 cursor-pointer group" data-testid={`row-dashboard-char-${char.id}`}>
                        <Avatar className="h-10 w-10 border border-border rounded-none group-hover:border-nc-cyan transition-colors shrink-0">
                          <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ''} className="object-contain" />
                          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
                            {char.name.substring(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="font-display text-sm truncate group-hover:text-nc-cyan transition-colors">{char.name}</div>
                          <div className="text-[10px] font-mono text-muted-foreground uppercase truncate">
                            {char.archetype || 'UNKNOWN'}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 px-1.5 py-0.5 text-[9px] font-display tracking-wider uppercase border ${
                            char.kind === 'pc'
                              ? 'bg-nc-green/20 border-nc-green/60 text-nc-green'
                              : 'bg-nc-yellow/20 border-nc-yellow/60 text-nc-yellow'
                          }`}
                          data-testid={`badge-char-kind-${char.id}`}
                        >
                          {char.kind}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <MyVenuesSection />
          <NpcsNeededCard />
          <MyEventsCard />
          <TodaysScheduleCard />
        </div>

        <div className="lg:col-span-2 space-y-6 lg:order-2">
          <UpcomingBillsCard />
          <SystemLogsCard />
        </div>
      </div>
      </div>
    </div>
  );
}

// Compact, dismissible dashboard prompt nudging players to set their Discord
// ping preferences on the Settings page. Dismissal is persisted per real user
// (notificationPromptDismissed on /auth/me) and mirrors the onboarding-banner
// pattern, so once dismissed it never re-appears. The Settings toggles remain
// the permanent home regardless of whether this prompt is shown.
function NotificationPrefsPrompt() {
  const qc = useQueryClient();
  const { data: user } = useEffectiveMe();
  const dismiss = useDismissNotificationPrompt();

  if (!user || user.notificationPromptDismissed) return null;

  function onDismiss() {
    // Optimistically hide, then persist and re-fetch /auth/me so the flag sticks.
    qc.setQueryData(getGetMeQueryKey(), (prev: any) =>
      prev ? { ...prev, notificationPromptDismissed: true } : prev,
    );
    dismiss.mutate(undefined, {
      onSettled: () => qc.invalidateQueries({ queryKey: getGetMeQueryKey() }),
    });
  }

  return (
    <Card
      className="rounded-none border-nc-cyan/40 bg-gradient-to-r from-nc-cyan/10 via-nc-cyan/5 to-transparent"
      data-testid="card-notification-prompt"
    >
      <CardContent className="p-4 flex flex-wrap items-center gap-4">
        <Bell className="w-7 h-7 text-nc-cyan shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-mono tracking-widest text-nc-cyan uppercase">
            Stay in the loop
          </div>
          <div className="font-display text-lg text-foreground">SET YOUR PING PREFERENCES</div>
          <div className="font-mono text-xs text-muted-foreground">
            Choose which Discord pings you get — NPC, Social RP, and Main Session — right from Settings.
          </div>
        </div>
        <Button
          asChild
          className="rounded-none bg-nc-cyan hover:bg-nc-cyan/80 text-background font-display shrink-0"
          data-testid="button-notification-prompt-settings"
        >
          <Link href="/settings">OPEN SETTINGS</Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          disabled={dismiss.isPending}
          className="shrink-0 text-muted-foreground hover:text-nc-cyan h-7 w-7 rounded-none"
          aria-label="Dismiss notification preferences prompt"
          data-testid="button-notification-prompt-dismiss"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

// "My stores" rail on the dashboard: the venues the signed-in user owns
// (storefronts + ripperdoc clinics), each linking into its management page.
// Hidden entirely when the user owns none so non-merchants don't see an
// empty card.
function MyVenuesSection() {
  const { data: stores } = useListMyStores();
  const { data: clinics } = useListMyRipperdocs();
  const storeList = stores ?? [];
  const clinicList = clinics ?? [];
  if (storeList.length === 0 && clinicList.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display font-bold text-foreground" data-testid="text-my-stores-title">MY_STORES</h2>
      </div>
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-0">
          <div className="divide-y divide-border/50">
            {storeList.map((s) => (
              <Link key={`store-${s.id}`} href={`/stores/${s.id}`}>
                <div className="p-3 flex items-center gap-3 hover:bg-nc-cyan/5 cursor-pointer group" data-testid={`row-dashboard-store-${s.id}`}>
                  <Store className="w-4 h-4 text-nc-cyan shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-sm truncate group-hover:text-nc-cyan transition-colors">{s.name}</div>
                  </div>
                </div>
              </Link>
            ))}
            {clinicList.map((c) => (
              <Link key={`clinic-${c.id}`} href={`/clinics/${c.id}`}>
                <div className="p-3 flex items-center gap-3 hover:bg-nc-magenta/5 cursor-pointer group" data-testid={`row-dashboard-clinic-${c.id}`}>
                  <Syringe className="w-4 h-4 text-nc-magenta shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-sm truncate group-hover:text-nc-magenta transition-colors">{c.name}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// A single upcoming/today calendar entry the dashboard cards render. Recurring
// events contribute one row per relevant occurrence.
interface DashCalItem {
  kind: "mission" | "event";
  id: number;
  title: string;
  start: Date;
  href: string;
  subtype: string;
  myStatus: "player" | "npc" | null;
}

const EVENT_TYPE_LABEL_DASH: Record<string, string> = {
  social: "Social",
  session: "Main Session",
  mission: "Mission",
  other: "Event",
};

function DashCalRow({ item }: { item: DashCalItem }) {
  const isMission = item.kind === "mission";
  const Icon = isMission ? Briefcase : PartyPopper;
  const color = isMission ? "text-nc-magenta" : "text-nc-cyan";
  const hover = isMission ? "hover:bg-nc-magenta/5" : "hover:bg-nc-cyan/5";
  const time = item.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = item.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return (
    <Link href={item.href}>
      <div
        className={`p-3 flex items-center gap-3 ${hover} cursor-pointer group`}
        data-testid={`row-dashboard-${item.kind}-${item.id}`}
      >
        <Icon className={`w-4 h-4 ${color} shrink-0`} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm truncate group-hover:text-nc-cyan transition-colors">{item.title}</div>
          <div className="text-sm font-mono text-foreground/90 tabular-nums truncate mt-0.5">
            {day} · {time}
            <span className="text-[10px] text-muted-foreground uppercase"> · {item.subtype}</span>
          </div>
        </div>
        {item.myStatus && (
          <span
            className={`shrink-0 px-1 text-[8px] font-display tracking-wider border ${
              item.myStatus === "player"
                ? "bg-nc-green/20 border-nc-green/60 text-nc-green"
                : "bg-nc-yellow/20 border-nc-yellow/60 text-nc-yellow"
            }`}
          >
            {item.myStatus === "player" ? "PLAYER" : "NPC"}
          </span>
        )}
      </div>
    </Link>
  );
}

// "My Events" rail card: upcoming missions/events the signed-in user is
// committed to (accepted player or active NPC signup), soonest first. Recurring
// events resolve to their next occurrence. Hidden when the user has none.
function MyEventsCard() {
  const { data: missions } = useListMissions(undefined, {
    query: { queryKey: getListMissionsQueryKey() },
  });
  const { data: events } = useListEvents(undefined, {
    query: { queryKey: getListEventsQueryKey() },
  });

  const now = new Date();
  const horizon = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const items: DashCalItem[] = [];

  for (const m of (missions ?? []) as MissionSummary[]) {
    if (!m.startAt || m.status === "cancelled") continue;
    const start = new Date(m.startAt);
    if (Number.isNaN(start.getTime()) || start < now) continue;
    const isPlayer = m.myApplication?.status === "accepted" || m.myCharacterId != null;
    const isNpc = m.mySignup?.state === "signed_up";
    if (!isPlayer && !isNpc) continue;
    items.push({
      kind: "mission",
      id: m.id,
      title: m.title,
      start,
      href: `/missions/${m.id}`,
      subtype: `Tier ${m.tier}`,
      myStatus: isPlayer ? "player" : "npc",
    });
  }
  for (const e of (events ?? []) as EventView[]) {
    if (e.mySignup == null) continue;
    const base = new Date(e.startAt);
    if (Number.isNaN(base.getTime())) continue;
    const occ = expandOccurrences(base, e.recurrence ?? null, now, horizon)[0];
    if (!occ) continue;
    items.push({
      kind: "event",
      id: e.id,
      title: e.title,
      start: occ,
      href: `/events/${e.id}`,
      subtype: EVENT_TYPE_LABEL_DASH[e.eventType] ?? "Event",
      myStatus: "npc",
    });
  }

  items.sort((a, b) => a.start.getTime() - b.start.getTime());
  const shown = items.slice(0, 6);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display font-bold text-foreground" data-testid="text-my-events-title">
          MY_EVENTS
        </h2>
      </div>
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-0">
          {shown.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground italic p-4" data-testid="text-my-events-empty">
              You haven't signed up for any upcoming missions or events. Browse the{" "}
              <Link href="/directory/calendar" className="text-nc-cyan hover:underline">calendar</Link> to join one.
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {shown.map((it) => (
                <DashCalRow key={`${it.kind}-${it.id}-${it.start.getTime()}`} item={it} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// "Today's Schedule" rail card: every mission and event occurrence happening
// today, in the viewer's local time, regardless of signup. Always shown so the
// user has an at-a-glance "what's on tonight" view.
function TodaysScheduleCard() {
  const { data: missions } = useListMissions(undefined, {
    query: { queryKey: getListMissionsQueryKey() },
  });
  const { data: events } = useListEvents(undefined, {
    query: { queryKey: getListEventsQueryKey() },
  });

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const items: DashCalItem[] = [];

  for (const m of (missions ?? []) as MissionSummary[]) {
    if (!m.startAt || m.status === "cancelled") continue;
    const start = new Date(m.startAt);
    if (Number.isNaN(start.getTime()) || start < dayStart || start > dayEnd) continue;
    const isPlayer = m.myApplication?.status === "accepted" || m.myCharacterId != null;
    const isNpc = m.mySignup?.state === "signed_up";
    items.push({
      kind: "mission",
      id: m.id,
      title: m.title,
      start,
      href: `/missions/${m.id}`,
      subtype: `Tier ${m.tier}`,
      myStatus: isPlayer ? "player" : isNpc ? "npc" : null,
    });
  }
  for (const e of (events ?? []) as EventView[]) {
    const base = new Date(e.startAt);
    if (Number.isNaN(base.getTime())) continue;
    const isNpc = e.mySignup != null;
    for (const occ of expandOccurrences(base, e.recurrence ?? null, dayStart, dayEnd)) {
      items.push({
        kind: "event",
        id: e.id,
        title: e.title,
        start: occ,
        href: `/events/${e.id}`,
        subtype: EVENT_TYPE_LABEL_DASH[e.eventType] ?? "Event",
        myStatus: isNpc ? "npc" : null,
      });
    }
  }

  items.sort((a, b) => a.start.getTime() - b.start.getTime());

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display font-bold text-foreground" data-testid="text-todays-schedule-title">
          TODAYS_SCHEDULE
        </h2>
      </div>
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="p-4 flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <CalendarDays className="w-4 h-4 shrink-0" /> Nothing scheduled today.
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {items.map((it) => (
                <DashCalRow key={`${it.kind}-${it.id}-${it.start.getTime()}`} item={it} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
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
  const { data: user } = useEffectiveMe();
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
                      <AvatarImage src={npc.portraitUrl || npc.portraitUrls?.[0] || ""} className="object-contain" />
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

// Prominent top-of-dashboard banner for the soonest upcoming Main Session that
// needs NPCs and that the viewer hasn't already signed up for. Main Sessions
// always need NPCs (the server derives needsNpcs from eventType), so this keeps
// the weekly call for volunteers in everyone's face. One-tap sign-up.
function NpcSessionBanner() {
  const { data: events } = useListEvents(undefined, { query: { queryKey: getListEventsQueryKey() } });
  const quickNpc = useQuickNpcSignup();
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // two weeks out

  // Always target the SOONEST upcoming Main Session that needs NPCs —
  // regardless of whether the viewer has signed up. We must NOT skip ahead to
  // a later session just because the viewer already volunteered for the next
  // one; the banner is about the *next* session only. Once the viewer has
  // signed up for that soonest session, we hide the banner entirely.
  let best: { id: number; title: string; start: Date; mySignup: EventView["mySignup"] } | null = null;
  for (const e of (events ?? []) as EventView[]) {
    if (e.eventType !== "session" || e.needsNpcs !== true) continue;
    const base = new Date(e.startAt);
    if (Number.isNaN(base.getTime())) continue;
    const occ = expandOccurrences(base, e.recurrence ?? null, now, horizon)[0];
    if (!occ) continue;
    if (!best || occ < best.start) {
      best = { id: e.id, title: e.title, start: occ, mySignup: e.mySignup };
    } else if (occ.getTime() === best.start.getTime() && e.mySignup != null) {
      // A single session can have duplicate rows (Discord + website). If the
      // viewer signed up on either copy, treat the session as signed up.
      best.mySignup = e.mySignup;
    }
  }
  if (!best || best.mySignup != null) return null;
  const session = best;

  const diffMs = session.start.getTime() - now.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const countdown = days > 0 ? `in ${days}d ${hours}h` : hours > 0 ? `in ${hours}h` : "starting soon";
  const whenStr = `${session.start.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} · ${session.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const signingUp = quickNpc.pendingKey === `event-${session.id}`;

  return (
    <Card
      className="rounded-none border-nc-yellow/50 bg-gradient-to-r from-nc-yellow/15 via-nc-yellow/5 to-transparent shadow-[0_0_20px_rgba(255,255,0,0.12)]"
      data-testid="card-npc-session-banner"
    >
      <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Users className="w-6 h-6 text-nc-yellow shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-mono tracking-wider text-nc-yellow uppercase">
              Main Session needs NPCs · <span className="font-semibold tabular-nums text-foreground">{countdown}</span>
            </div>
            <Link href={`/events/${session.id}`}>
              <div
                className="font-display text-lg md:text-xl text-foreground truncate hover:text-nc-yellow transition-colors"
                data-testid="text-npc-session-title"
              >
                {session.title}
              </div>
            </Link>
            <div className="text-sm font-mono text-foreground/80 uppercase flex items-center gap-1 mt-0.5">
              <Clock className="w-3.5 h-3.5" /> <span className="font-semibold tabular-nums tracking-tight text-foreground">{whenStr}</span>
            </div>
          </div>
        </div>
        <Button
          disabled={signingUp}
          onClick={() => quickNpc.signUp("event", session.id)}
          className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest shrink-0"
          data-testid="button-npc-session-signup"
        >
          {signingUp ? (
            "SIGNING UP..."
          ) : (
            <>
              <UserPlus className="w-4 h-4 mr-1" /> SIGN UP AS NPC
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// Left-rail card listing every upcoming mission/event that wants NPCs and that
// the viewer hasn't already joined (as player or NPC), soonest first, each with
// a one-tap sign-up. Hidden entirely when there's nothing to volunteer for.
type NpcNeedItem = { kind: "mission" | "event"; id: number; title: string; start: Date; href: string; subtype: string };
function NpcsNeededCard() {
  const { data: missions } = useListMissions(undefined, { query: { queryKey: getListMissionsQueryKey() } });
  const { data: events } = useListEvents(undefined, { query: { queryKey: getListEventsQueryKey() } });
  const quickNpc = useQuickNpcSignup();

  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // next 7 days
  const items: NpcNeedItem[] = [];

  for (const m of (missions ?? []) as MissionSummary[]) {
    if (!m.startAt || m.status === "cancelled" || m.npcSignupOpen !== true) continue;
    const isPlayer = m.myApplication?.status === "accepted" || m.myCharacterId != null;
    const isNpc = m.mySignup?.state === "signed_up";
    if (isPlayer || isNpc) continue;
    const start = new Date(m.startAt);
    if (Number.isNaN(start.getTime()) || start < now || start > horizon) continue;
    items.push({ kind: "mission", id: m.id, title: m.title, start, href: `/missions/${m.id}`, subtype: `Tier ${m.tier}` });
  }
  for (const e of (events ?? []) as EventView[]) {
    if (e.needsNpcs !== true || e.mySignup != null) continue;
    const base = new Date(e.startAt);
    if (Number.isNaN(base.getTime())) continue;
    const occ = expandOccurrences(base, e.recurrence ?? null, now, horizon)[0];
    if (!occ) continue;
    items.push({ kind: "event", id: e.id, title: e.title, start: occ, href: `/events/${e.id}`, subtype: EVENT_TYPE_LABEL_DASH[e.eventType] ?? "Event" });
  }

  if (items.length === 0) return null;
  items.sort((a, b) => a.start.getTime() - b.start.getTime());
  const shown = items.slice(0, 6);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-nc-yellow" />
        <h2 className="text-xl font-display font-bold text-foreground" data-testid="text-npcs-needed-title">
          NPCS_NEEDED
        </h2>
      </div>
      <Card className="rounded-none border-nc-yellow/40 bg-nc-yellow/5">
        <CardContent className="p-0">
          <div className="divide-y divide-border/50">
            {shown.map((it) => {
              const signingUp = quickNpc.pendingKey === `${it.kind}-${it.id}`;
              return (
                <div
                  key={`${it.kind}-${it.id}-${it.start.getTime()}`}
                  className="p-2 flex items-center gap-2"
                  data-testid={`row-npc-need-${it.kind}-${it.id}`}
                >
                  <Link href={it.href} className="min-w-0 flex-1 group">
                    <div className="font-display text-sm truncate group-hover:text-nc-yellow transition-colors">
                      {it.title}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground uppercase truncate">
                      {it.subtype} ·{" "}
                      {it.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ·{" "}
                      {it.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={signingUp}
                    onClick={() => quickNpc.signUp(it.kind, it.id)}
                    className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display tracking-widest shrink-0 h-7 px-2 text-xs"
                    data-testid={`button-npc-need-${it.kind}-${it.id}`}
                  >
                    {signingUp ? (
                      "..."
                    ) : (
                      <>
                        <UserPlus className="w-3 h-3 mr-1" /> NPC
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
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
    <Link href={`/missions/${next.id}`} className="block">
      <Card
        className="rounded-none border-nc-magenta/50 bg-gradient-to-r from-nc-magenta/15 via-nc-magenta/5 to-transparent hover:border-nc-magenta cursor-pointer group shadow-[0_0_20px_rgba(255,0,255,0.15)]"
        data-testid="card-next-mission"
      >
        <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Briefcase className="w-6 h-6 text-nc-magenta shrink-0" />
            <div className="min-w-0">
              <div className="text-[11px] font-mono tracking-wider text-nc-magenta uppercase">
                Next Mission · <span className="font-semibold tabular-nums text-foreground">{countdown}</span>
              </div>
              <div className="font-display text-lg md:text-xl text-foreground truncate group-hover:text-nc-magenta transition-colors" data-testid="text-next-mission-title">
                {next.title}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm font-mono text-foreground/80 uppercase">
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> <span className="font-semibold tabular-nums tracking-tight text-foreground">{whenStr}</span>
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

interface ActivityHistoryEntry {
  source: "portal" | "bot";
  date: string;
  at: string | null;
  amount?: number | null;
  label?: string | null;
}
interface ActivityHistoryResponse {
  totalCount: number;
  portalCount: number;
  botCount: number;
  entries: ActivityHistoryEntry[];
}

// Read-only history dialog shared by the attendance + open-shop cards. Fetches
// a merged (portal-era + imported bot-era) chronological list on open. The
// `accent` class picks the card's neon color so each dialog matches its source.
function ActivityHistoryDialog({
  open,
  onOpenChange,
  title,
  url,
  queryKey,
  accent,
  showAmount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  url: string;
  queryKey: readonly unknown[];
  accent: string;
  showAmount?: boolean;
}) {
  const { data, isLoading, error } = useQuery<ActivityHistoryResponse>({
    queryKey,
    enabled: open,
    queryFn: async () => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`Failed to load history (HTTP ${r.status})`);
      return r.json();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`rounded-none border ${accent} bg-card max-w-md`}>
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest">{title}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="font-mono text-sm text-nc-cyan animate-pulse py-6 text-center">LOADING_HISTORY...</div>
        ) : error instanceof Error ? (
          <div className="font-mono text-sm text-destructive py-6 text-center">ERR: {error.message}</div>
        ) : !data || data.entries.length === 0 ? (
          <div className="font-mono text-sm text-muted-foreground py-6 text-center">NO_HISTORY_RECORDED</div>
        ) : (
          <div className="space-y-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              {data.totalCount} TOTAL · {data.botCount} BOT-ERA · {data.portalCount} PORTAL
            </div>
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-border/40 border border-border/40">
              {data.entries.map((e, i) => (
                <div
                  key={`${e.source}-${e.at ?? e.date}-${i}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 font-mono text-xs"
                  data-testid={`row-history-${i}`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground">
                      {new Date(e.at ?? `${e.date}T00:00:00Z`).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    {e.label && (
                      <span className="truncate text-[10px] text-muted-foreground" title={e.label}>
                        {e.label}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {(showAmount || e.amount != null) && e.amount != null && (
                      <span className={e.amount < 0 ? "text-destructive" : "text-nc-yellow"}>
                        {e.amount < 0 ? "-" : "+"}€${Math.abs(e.amount).toLocaleString()}
                      </span>
                    )}
                    <Badge
                      variant="outline"
                      className={`rounded-none text-[9px] tracking-widest ${
                        e.source === "bot" ? "border-nc-magenta/50 text-nc-magenta" : "border-nc-cyan/50 text-nc-cyan"
                      }`}
                    >
                      {e.source === "bot" ? "BOT-ERA" : "PORTAL"}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Live "Hh Mm" (or "Mm Ss" under a minute) countdown to an ISO timestamp.
// Returns null once the target has passed so callers can flip to "ready".
function useCountdown(targetIso: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetIso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [targetIso]);
  if (!targetIso) return null;
  const ms = new Date(targetIso).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

// Dashboard income card. WORK is open to everyone (random 100–200, 20h
// cooldown); SLUT is gated to the joytoy role server-side (random 100–500 or a
// 1–3% fine) and only rendered when /economy/income reports the viewer eligible.
// All cooldown/eligibility/payout logic is enforced by the API — the UI just
// disables buttons on the obvious cases and surfaces the last outcome.
function IncomeCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetIncomeStatus();
  const [lastResult, setLastResult] = useState<IncomeCommandResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const onDone = () => qc.invalidateQueries({ queryKey: getGetIncomeStatusQueryKey() });
  const handleSuccess = (resp: IncomeCommandResult) => {
    setErrorMsg(null);
    setLastResult(resp);
    onDone();
  };
  const handleError = (err: unknown) => {
    const d = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
    setErrorMsg(d?.error ?? "Command failed. Try again shortly.");
    onDone();
  };

  const work = useRunIncomeWork({ mutation: { onSuccess: handleSuccess, onError: handleError } });
  const slut = useRunIncomeSlut({ mutation: { onSuccess: handleSuccess, onError: handleError } });

  const workCooldown = useCountdown(data?.work.available ? null : data?.work.cooldownEndsAt);
  const slutCooldown = useCountdown(data?.slut.available ? null : data?.slut.cooldownEndsAt);

  if (isLoading || !data) return null;

  const workBusy = work.isPending;
  const slutBusy = slut.isPending;
  const workDisabled = !data.work.available || workBusy;
  const slutDisabled = !data.slut.available || slutBusy;

  return (
    <div className="border border-nc-cyan/40 bg-nc-cyan/5 p-4 space-y-3 h-full flex flex-col">
      <div className="font-display tracking-widest text-nc-cyan text-sm">INCOME</div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          disabled={workDisabled}
          onClick={() => work.mutate()}
          className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest disabled:opacity-50"
          data-testid="button-income-work"
        >
          {workBusy ? "WORKING..." : !data.work.available ? `WORK · ${workCooldown ?? "READY"}` : "WORK"}
        </Button>
        {data.slut.eligible && (
          <Button
            type="button"
            disabled={slutDisabled}
            onClick={() => slut.mutate()}
            variant="outline"
            className="rounded-none border-nc-magenta/50 text-nc-magenta hover:bg-nc-magenta/10 font-display tracking-widest disabled:opacity-50"
            data-testid="button-income-slut"
          >
            {slutBusy ? "WORKING..." : !data.slut.available ? `SLUT · ${slutCooldown ?? "READY"}` : "SLUT"}
          </Button>
        )}
      </div>

      {lastResult && (
        <div
          className={`text-xs font-mono ${lastResult.outcome === "fined" ? "text-destructive" : "text-nc-cyan"}`}
          data-testid="text-income-result"
        >
          {lastResult.outcome === "fined"
            ? `FINED €$${Math.abs(lastResult.amount).toLocaleString()}`
            : `EARNED €$${lastResult.amount.toLocaleString()}`}{" "}
          ({lastResult.command.toUpperCase()})
        </div>
      )}
      {errorMsg && (
        <div className="text-xs font-mono text-destructive" data-testid="text-income-error">
          ERR: {errorMsg}
        </div>
      )}

      <div className="text-xs text-muted-foreground mt-auto pt-1" data-testid="text-income-balance">
        TOTAL_EDDIES · €${(data.balance ?? 0).toLocaleString()}
      </div>
    </div>
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
  const [historyOpen, setHistoryOpen] = useState(false);
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
        ? "SESSION CLOSED"
        : "CLAIM";
  // Short month/day label (e.g. "Jun 1") so the header meta stays one short
  // line and doesn't wrap/squish against the buttons like the raw ISO date did.
  // Build the Date from y/m/d parts to avoid a UTC->local day shift.
  const weekLabel = data.weekStart
    ? (() => {
        const [y, m, d] = data.weekStart.split("T")[0].split("-").map(Number);
        const dt = new Date(y, m - 1, d);
        return Number.isNaN(dt.getTime())
          ? data.weekStart
          : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      })()
    : "";
  return (
    <div className="border border-nc-yellow/40 bg-nc-yellow/5 p-4 space-y-3 h-full">
      <div className="font-display tracking-widest text-nc-yellow text-sm">WEEKLY ATTENDANCE</div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          disabled={disabled}
          onClick={() => claim.mutate()}
          className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest disabled:opacity-50"
          data-testid="button-attend-claim"
        >
          {buttonLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setHistoryOpen(true)}
          className="rounded-none border-nc-yellow/40 text-nc-yellow hover:bg-nc-yellow/10 font-display tracking-widest text-xs"
          data-testid="button-attend-history"
        >
          ATTENDANCE HISTORY
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        WEEK_OF {weekLabel} · €${data.payout.toLocaleString()}
      </div>
      {!windowOpen && !data.claimed && (
        <div className="text-xs font-mono text-nc-yellow" data-testid="text-attend-next-window">
          SESSION_WINDOW: {data.windowHint ?? "Sundays 2:00pm–9:00pm Pacific"}
          {data.nextWindowOpensAt && ` · OPENS ${formatDueDate(data.nextWindowOpensAt)}`}
        </div>
      )}
      {data.claimedAt && (
        <div className="text-xs font-mono text-nc-yellow">
          LAST_CLAIM: {new Date(data.claimedAt).toLocaleString()}
        </div>
      )}
      {claim.error instanceof Error && (
        <div className="text-xs font-mono text-destructive">ERR: {claim.error.message}</div>
      )}
      <ActivityHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title="ATTENDANCE HISTORY"
        url="/api/attendance/history"
        queryKey={["attendance-history"]}
        accent="border-nc-yellow/60"
        showAmount
      />
    </div>
  );
}

// Single per-PLAYER Leave of Absence control. LOA is stored per character
// server-side (it drives rent-billing skips), so toggling this fans the change
// out across every one of the player's characters at once: ON puts them all on
// leave, OFF brings them all back.
export function PlayerLoaControl({ characters }: { characters: Array<{ id: number; name: string }> }) {
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

interface ShopOpenInfo {
  characterId: number;
  canOpen: boolean;
  openedToday: boolean;
  opensThisMonth: number;
  opensCountedForIncome: number;
  businessLeases: Array<{ id: number; address: string; monthlyRent: number }>;
  venues?: Array<{ kind: "store" | "ripperdoc"; id: number; name: string }>;
  shopLabel?: string | null;
  windowOpen?: boolean;
  windowHint?: string;
  nextWindowOpensAt?: string | null;
  history: Array<{ openedOn: string; openedAt: string }>;
}

// Hidden entirely when the character owns no shop (no business lease and no
// storefront / clinic) — there's no useful UI for "you can't open a shop you
// don't own."
function ShopOpenSection({ characterId, name }: { characterId: number; name?: string }) {
  const qc = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const shopDesc = lease
    ? `${lease.address} · €$${lease.monthlyRent.toLocaleString()}/mo`
    : (data.shopLabel ?? "Storefront / clinic");
  const capped = data.opensThisMonth > data.opensCountedForIncome;
  // Shop can only be opened during the live session window (Sundays 2-9pm
  // Pacific). Treat an absent flag as open for backward-compat.
  const windowOpen = data.windowOpen !== false;
  const disabled = data.openedToday || open.isPending || !windowOpen;

  return (
    <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-4 space-y-3 h-full">
      <div className="font-display tracking-widest text-nc-magenta text-sm">
        {name ? `SHOP — ${name.toUpperCase()}` : "SHOP STATUS"}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          disabled={disabled}
          onClick={() => open.mutate()}
          className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest disabled:opacity-50"
          data-testid={`button-open-shop-today-${characterId}`}
        >
          {data.openedToday
            ? "OPENED TODAY ✓"
            : open.isPending
              ? "OPENING..."
              : !windowOpen
                ? "SESSION CLOSED"
                : "OPEN SHOP TODAY"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setHistoryOpen(true)}
          className="rounded-none border-nc-magenta/40 text-nc-magenta hover:bg-nc-magenta/10 font-display tracking-widest text-xs"
          data-testid={`button-open-shop-history-${characterId}`}
        >
          OPEN SHOP HISTORY
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        {shopDesc}
      </div>
      {!windowOpen && !data.openedToday && (
        <div className="text-xs font-mono text-nc-yellow">
          SHOP_WINDOW: {data.windowHint ?? "Sundays 2:00pm–9:00pm Pacific"}
          {data.nextWindowOpensAt && ` · OPENS ${formatDueDate(data.nextWindowOpensAt)}`}
        </div>
      )}
      <div className="text-xs font-mono text-muted-foreground">
        OPENS_THIS_MONTH: <span className="text-nc-cyan">{data.opensCountedForIncome}/4</span>
        {capped && <span className="text-nc-yellow"> (+{data.opensThisMonth - data.opensCountedForIncome} past cap)</span>}
      </div>
      {data.history?.[0] && (
        <div className="text-xs font-mono text-nc-yellow">
          LAST_OPENED: {new Date(data.history[0].openedAt).toLocaleString()}
        </div>
      )}
      {open.error instanceof Error && (
        <div className="text-xs font-mono text-destructive">ERR: {open.error.message}</div>
      )}
      <ActivityHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title={name ? `OPEN SHOP HISTORY — ${name.toUpperCase()}` : "OPEN SHOP HISTORY"}
        url={`/api/characters/${characterId}/shop-history`}
        queryKey={["shop-history", characterId]}
        accent="border-nc-magenta/60"
      />
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

// Formats a PAST date relative to now (e.g. a last-checkup timestamp). Uses
// calendar-day differences in local time so "yesterday" flips at midnight, not
// at the 24h mark. Do NOT use formatDueDate here — it clamps negatives to 0 and
// mislabels every past date as "today".
function formatPastDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return `today (${dateStr})`;
  if (days === 1) return `yesterday (${dateStr})`;
  return `${days} days ago (${dateStr})`;
}

function UpcomingBillsCard() {
  const { data, isLoading } = useGetUpcomingBills();
  // Account-level history dialogs (the legacy bot tracked rent + cyberware meds
  // PER DISCORD USER, not per character). Rent comes from the parsed
  // #rent-payments channel (a full year); meds + the full ledger come from the
  // imported bot balance history.
  const [rentOpen, setRentOpen] = useState(false);
  const [medsOpen, setMedsOpen] = useState(false);
  const [financeOpen, setFinanceOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-2xl font-display font-bold text-foreground flex items-center gap-2" data-testid="text-bills-title">
          <Receipt className="w-5 h-5 text-nc-yellow" /> UPCOMING_BILLS
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRentOpen(true)}
            className="rounded-none border-nc-yellow/40 text-nc-yellow hover:bg-nc-yellow/10 font-display tracking-widest text-xs h-8"
            data-testid="button-rent-history"
          >
            <History className="w-3 h-3 mr-1" /> RENT HISTORY
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFinanceOpen(true)}
            className="rounded-none border-border text-muted-foreground hover:bg-muted/30 font-display tracking-widest text-xs h-8"
            data-testid="button-financial-history"
          >
            <History className="w-3 h-3 mr-1" /> ALL FINANCES
          </Button>
        </div>
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

              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
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
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setMedsOpen(true)}
                  className="rounded-none border-destructive/40 text-destructive hover:bg-destructive/10 font-display tracking-widest text-xs h-8 shrink-0"
                  data-testid="button-meds-history"
                >
                  <History className="w-3 h-3 mr-1" /> MEDS HISTORY
                </Button>
              </div>

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

      <ActivityHistoryDialog
        open={rentOpen}
        onOpenChange={setRentOpen}
        title="RENT HISTORY"
        url="/api/me/rent-history"
        queryKey={["rent-history"]}
        accent="border-nc-yellow/60"
        showAmount
      />
      <ActivityHistoryDialog
        open={medsOpen}
        onOpenChange={setMedsOpen}
        title="CYBERWARE MEDS HISTORY"
        url="/api/me/cyberware-history"
        queryKey={["cyberware-history"]}
        accent="border-destructive/60"
        showAmount
      />
      <ActivityHistoryDialog
        open={financeOpen}
        onOpenChange={setFinanceOpen}
        title="ALL FINANCES"
        url="/api/me/financial-history"
        queryKey={["financial-history"]}
        accent="border-nc-cyan/60"
        showAmount
      />
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
          value={status.lastCheckupAt ? formatPastDate(status.lastCheckupAt) : "never"}
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
                  <div key={b.characterId} className="flex justify-between items-baseline gap-3 text-sm">
                    <span className={billable ? "text-foreground" : "text-muted-foreground"}>
                      {b.characterName}
                    </span>
                    <span className="flex items-baseline gap-2.5 whitespace-nowrap">
                      <span className="flex items-baseline gap-1">
                        <span className={`tabular-nums text-sm ${billable ? "text-foreground font-bold" : "text-muted-foreground"}`}>
                          {b.chromeCount}
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                          CWP
                        </span>
                      </span>
                      <span className={`text-[11px] font-semibold uppercase tracking-wider ${bandColorClass(b.band)}`}>
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
