import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyMissions,
  useListMissions,
  useListOwnedMissions,
  useListCreatedMissions,
  useListMyApplications,
  useListMyActing,
  useSubmitMission,
  useDeleteMission,
  usePostMission,
  useApplyToMission,
  useWithdrawApplication,
  useSignUpAsNpc,
  useWithdrawNpcSignup,
  useListMyCharacters,
  useGetDefaultAvailability,
  getGetDefaultAvailabilityQueryKey,
  getListMissionsQueryKey,
  getListOwnedMissionsQueryKey,
  getListCreatedMissionsQueryKey,
  type MissionSummary,
  type MissionApplicationListItem,
  type ActingEntry,
} from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Briefcase,
  CalendarDays,
  MapPin,
  Plus,
  User,
  Users,
  Clock,
  Banknote,
  Drama,
  Trash2,
} from "lucide-react";
import {
  missionStatusClass,
  missionStatusLabel,
  missionTierClass,
  missionTierLabel,
  missionWorkflowClass,
  missionWorkflowLabel,
  applicationStatusClass,
  applicationStatusLabel,
  WORKFLOW_STATES,
  type MissionStatus,
} from "@/lib/missionStatus";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";
import { MissionOutcomesBanner } from "@/components/MissionOutcomesBanner";
import { CloseApplicationsButton } from "@/components/CloseApplicationsButton";
import { TrialFixerBadge } from "@/components/TrialFixerBadge";
import ErrorBoundary from "@/components/ErrorBoundary";
import Markdown from "@/components/Markdown";
import {
  AvailabilityGrid,
  buildDayColumns,
  expandPattern,
  patternFromInstants,
  type AvailabilitySlot,
} from "@/components/AvailabilityGrid";
import { Checkbox } from "@/components/ui/checkbox";

type TabKey =
  | "open"
  | "active"
  | "completed"
  | "applications"
  | "accepted"
  | "acting"
  | "mine"
  | "all";

type TabDef = { key: TabKey; label: string; count?: number; show?: boolean };

// Completed lifecycle statuses (mission ran to its end, not cancelled).
const COMPLETED_STATUSES: MissionStatus[] = [
  "completed",
  "completed_players_paid",
  "completed_paid",
];

export default function Missions() {
  const { data: me } = useEffectiveMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);
  const isAdmin = !!me?.isAdmin;
  const canApprove = !!me && (me.isArchivist || me.isAdmin);
  // Trial fixers are author-only: they may create/propose missions (subject to
  // the unchanged Archivist/Admin approval) and shepherd their own pipeline, but
  // they get NONE of the staff management tools or the all-missions board.
  const canAuthor = isStaff || !!me?.isTrialFixer;
  // Archivists approve but don't create; fixers/admins both create and manage.
  // The all-missions board (All Missions) is for full managers + approvers only.
  const canSeeStaffTabs = isStaff || canApprove;

  const [tab, setTab] = useState<TabKey>("open");

  // --- Data sources, each scoped + enabled by role ---
  // The public list returns every posted mission (all statuses) to players, so
  // the three Browse tabs are client-side filters over a single fetch.
  const available = useListMissions(undefined, {
    query: { queryKey: getListMissionsQueryKey() },
  });
  // Open: posted + recruiting (PC applications accepted).
  const openMissions = useMemo(
    () =>
      (available.data ?? []).filter(
        (m) => m.workflowState === "posted" && m.status === "open",
      ),
    [available.data],
  );
  // Active: posted, PC applications closed (status pending). NPC sign-ups may
  // still be open, so the cards keep the NPC controls but hide PC apply.
  const activeMissions = useMemo(
    () =>
      (available.data ?? []).filter(
        (m) => m.workflowState === "posted" && m.status === "pending",
      ),
    [available.data],
  );
  // Completed: posted missions that ran to completion (not cancelled).
  const completedMissions = useMemo(
    () =>
      (available.data ?? []).filter(
        (m) =>
          m.workflowState === "posted" &&
          COMPLETED_STATUSES.includes(m.status as MissionStatus),
      ),
    [available.data],
  );

  // Accepted: missions the caller is assigned to that are still upcoming/active.
  const mine = useListMyMissions();
  const acceptedMissions = useMemo(
    () =>
      (mine.data ?? []).filter(
        (m) => m.status === "open" || m.status === "pending",
      ),
    [mine.data],
  );

  // My Applications: every application the caller submitted (all states).
  const myApps = useListMyApplications();

  // Acting: every time the caller acted (NPC/actor) in a mission or event.
  const acting = useListMyActing();

  // My Missions: missions the caller personally runs (any author, incl. trial
  // fixers), across all workflow states — grouped into lifecycle sub-tabs.
  const created = useListCreatedMissions({
    query: { enabled: canAuthor, queryKey: getListCreatedMissionsQueryKey() },
  });

  // All Missions: the staff-wide board (managers + approvers only).
  const owned = useListOwnedMissions({
    query: { enabled: canSeeStaffTabs, queryKey: getListOwnedMissionsQueryKey() },
  });

  // Tabs are grouped so it's clear which views are the public board, which are
  // the caller's own player activity, and which are fixer management boards.
  const browseTabs: TabDef[] = [
    { key: "open", label: "Open", count: openMissions.length },
    { key: "active", label: "Active", count: activeMissions.length },
    { key: "completed", label: "Completed", count: completedMissions.length },
  ];
  const playerTabs: TabDef[] = [
    { key: "applications", label: "My Applications", count: myApps.data?.length },
    { key: "accepted", label: "Accepted", count: acceptedMissions.length },
    { key: "acting", label: "Acting", count: acting.data?.length },
  ];
  const fixerTabs: TabDef[] = ([
    { key: "mine", label: "My Missions", count: created.data?.length, show: canAuthor },
    { key: "all", label: "All Missions", count: owned.data?.length, show: canSeeStaffTabs },
  ] as TabDef[]).filter((t) => t.show !== false);

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-display text-nc-magenta tracking-widest flex items-center gap-3">
            <Briefcase className="w-7 h-7" /> MISSIONS
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Scheduled jobs run by fixers, with payouts to the players who show up.
          </p>
        </div>
        {canAuthor && (
          <Link href="/fixer/missions">
            <Button
              className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
              data-testid="button-create-mission"
            >
              <Plus className="w-4 h-4 mr-1" /> CREATE MISSION
            </Button>
          </Link>
        )}
      </div>

      {canAuthor && <MissionTestModeBanner />}

      <MissionOutcomesBanner />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-6">
        <TabsList className="rounded-none bg-card/60 border border-border p-1 flex flex-wrap h-auto justify-start items-center gap-1">
          <TabGroupLabel>Browse</TabGroupLabel>
          <TabTriggers tabs={browseTabs} />
          <TabDivider />
          <TabGroupLabel>You</TabGroupLabel>
          <TabTriggers tabs={playerTabs} />
          {fixerTabs.length > 0 && (
            <>
              <TabDivider />
              <TabGroupLabel>Fixer</TabGroupLabel>
              <TabTriggers tabs={fixerTabs} />
            </>
          )}
        </TabsList>

        <TabsContent value="open" data-testid="tabpanel-open">
          <ErrorBoundary>
            <ListSection
              isLoading={available.isLoading}
              isEmpty={openMissions.length === 0}
              emptyText="No open missions right now. Check back soon."
            >
              <MissionCardList rows={openMissions} isAdmin={isAdmin} showApply />
            </ListSection>
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="active" data-testid="tabpanel-active">
          <ErrorBoundary>
            <ListSection
              isLoading={available.isLoading}
              isEmpty={activeMissions.length === 0}
              emptyText="No active missions. Open missions move here once PC applications close."
            >
              <MissionCardList rows={activeMissions} isAdmin={isAdmin} showApply npcOnly />
            </ListSection>
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="completed" data-testid="tabpanel-completed">
          <ErrorBoundary>
            <ListSection
              isLoading={available.isLoading}
              isEmpty={completedMissions.length === 0}
              emptyText="No completed missions yet."
            >
              <MissionCardList rows={completedMissions} isAdmin={isAdmin} />
            </ListSection>
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="applications" data-testid="tabpanel-applications">
          <ErrorBoundary>
            <ListSection
              isLoading={myApps.isLoading}
              isEmpty={(myApps.data?.length ?? 0) === 0}
              emptyText="You haven't applied to any missions yet."
            >
              <MyApplicationsList rows={myApps.data ?? []} />
            </ListSection>
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="accepted" data-testid="tabpanel-accepted">
          <ErrorBoundary>
            <ListSection
              isLoading={mine.isLoading}
              isEmpty={acceptedMissions.length === 0}
              emptyText="You're not on any upcoming missions yet. Apply to one from the Open tab."
            >
              <MissionCardList rows={acceptedMissions} isAdmin={isAdmin} />
            </ListSection>
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="acting" data-testid="tabpanel-acting">
          <ErrorBoundary>
            <ListSection
              isLoading={acting.isLoading}
              isEmpty={(acting.data?.length ?? 0) === 0}
              emptyText="You haven't acted in any missions or events yet."
            >
              <ActingList rows={acting.data ?? []} />
            </ListSection>
          </ErrorBoundary>
        </TabsContent>

        {canAuthor && (
          <TabsContent value="mine" data-testid="tabpanel-mine">
            <ErrorBoundary>
              <ListSection
                isLoading={created.isLoading}
                isEmpty={(created.data?.length ?? 0) === 0}
                emptyText="No missions yet. Use “Create Mission” to draft one."
              >
                <MyMissionsBoard
                  rows={created.data ?? []}
                  isAdmin={isAdmin}
                  canApprove={canApprove}
                  canManage={isStaff}
                  canAuthor={canAuthor}
                />
              </ListSection>
            </ErrorBoundary>
          </TabsContent>
        )}

        {canSeeStaffTabs && (
          <TabsContent value="all" data-testid="tabpanel-all">
            <ErrorBoundary>
              <AllMissionsTab
                rows={owned.data ?? []}
                isLoading={owned.isLoading}
                isAdmin={isAdmin}
                canApprove={canApprove}
                canManage={isStaff}
              />
            </ErrorBoundary>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function ListSection({
  isLoading,
  isEmpty,
  emptyText,
  children,
}: {
  isLoading: boolean;
  isEmpty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (isLoading) {
    return <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>;
  }
  if (isEmpty) {
    return <div className="font-mono text-muted-foreground italic">{emptyText}</div>;
  }
  return <>{children}</>;
}

function AllMissionsTab({
  rows,
  isLoading,
  isAdmin,
  canApprove,
  canManage,
}: {
  rows: MissionSummary[];
  isLoading: boolean;
  isAdmin: boolean;
  canApprove: boolean;
  canManage: boolean;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [tier, setTier] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((m) => {
      if (status && m.status !== status) return false;
      if (workflow && m.workflowState !== workflow) return false;
      if (tier && String(m.tier) !== tier) return false;
      if (q) {
        const hay = `${m.title} ${m.fixerName ?? ""} ${m.location ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, status, workflow, tier]);

  const selectClass =
    "rounded-none bg-background border border-border font-mono text-xs px-2 py-1 text-foreground";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, fixer, location…"
          className="rounded-none font-mono text-xs h-8 max-w-xs"
          data-testid="input-all-search"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={selectClass}
          data-testid="select-all-status"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="completed_players_paid">Players Paid</option>
          <option value="completed_paid">Fully Paid</option>
          <option value="cancelled">Canceled</option>
        </select>
        <select
          value={workflow}
          onChange={(e) => setWorkflow(e.target.value)}
          className={selectClass}
          data-testid="select-all-workflow"
        >
          <option value="">All stages</option>
          {WORKFLOW_STATES.map((w) => (
            <option key={w} value={w}>
              {missionWorkflowLabel(w)}
            </option>
          ))}
        </select>
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className={selectClass}
          data-testid="select-all-tier"
        >
          <option value="">All tiers</option>
          {[1, 2, 3, 4].map((t) => (
            <option key={t} value={String(t)}>
              Tier {t}
            </option>
          ))}
        </select>
        <span className="font-mono text-xs text-muted-foreground" data-testid="text-all-count">
          {filtered.length} / {rows.length}
        </span>
      </div>

      <ListSection
        isLoading={isLoading}
        isEmpty={filtered.length === 0}
        emptyText="No missions match these filters."
      >
        <div className="space-y-5">
          {filtered.map((m) => (
            <MissionCard
              key={m.id}
              m={m}
              isAdmin={isAdmin}
              canApprove={canApprove}
              canManage={canManage}
              showWorkflow
            />
          ))}
        </div>
      </ListSection>
    </div>
  );
}

// Group the caller's own missions by lifecycle stage for the My Missions
// sub-tabs. A cancelled/completed status wins over workflow state (a posted
// mission that later completed belongs under Completed, not Pending).
type MyMissionBucket = "draft" | "submitted" | "pending" | "cancelled" | "completed";

function myMissionBucket(m: MissionSummary): MyMissionBucket {
  if (m.status === "cancelled") return "cancelled";
  if (COMPLETED_STATUSES.includes(m.status as MissionStatus)) return "completed";
  if (m.workflowState === "draft") return "draft";
  if (m.workflowState === "proposal") return "submitted";
  return "pending"; // approved or posted + still open/pending
}

const MY_MISSION_SUBTABS: { key: MyMissionBucket; label: string; empty: string }[] = [
  { key: "draft", label: "Draft", empty: "No drafts. Use Create Mission → Save as draft." },
  { key: "submitted", label: "Submitted", empty: "Nothing awaiting approval." },
  { key: "pending", label: "Pending", empty: "No live missions right now." },
  { key: "cancelled", label: "Cancelled", empty: "No cancelled missions." },
  { key: "completed", label: "Completed", empty: "No completed missions yet." },
];

function MyMissionsBoard({
  rows,
  isAdmin,
  canApprove,
  canManage,
  canAuthor,
}: {
  rows: MissionSummary[];
  isAdmin: boolean;
  canApprove: boolean;
  canManage: boolean;
  canAuthor?: boolean;
}) {
  const [sub, setSub] = useState<MyMissionBucket>("pending");
  const buckets = useMemo(() => {
    const b: Record<MyMissionBucket, MissionSummary[]> = {
      draft: [],
      submitted: [],
      pending: [],
      cancelled: [],
      completed: [],
    };
    for (const m of rows) b[myMissionBucket(m)].push(m);
    return b;
  }, [rows]);

  return (
    <Tabs value={sub} onValueChange={(v) => setSub(v as MyMissionBucket)} className="space-y-5">
      <TabsList className="rounded-none bg-card/40 border border-border p-1 flex flex-wrap h-auto justify-start gap-1">
        {MY_MISSION_SUBTABS.map((t) => (
          <TabsTrigger
            key={t.key}
            value={t.key}
            className="rounded-none font-display tracking-widest text-xs data-[state=active]:bg-nc-cyan data-[state=active]:text-background"
            data-testid={`subtab-mine-${t.key}`}
          >
            {t.label.toUpperCase()}
            <span className="ml-1.5 opacity-70">({buckets[t.key].length})</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {MY_MISSION_SUBTABS.map((t) => (
        <TabsContent key={t.key} value={t.key} data-testid={`subpanel-mine-${t.key}`}>
          <ListSection isLoading={false} isEmpty={buckets[t.key].length === 0} emptyText={t.empty}>
            <div className="space-y-5">
              {buckets[t.key].map((m) => (
                <MissionCard
                  key={m.id}
                  m={m}
                  isAdmin={isAdmin}
                  canApprove={canApprove}
                  canManage={canManage}
                  canAuthor={canAuthor}
                  showWorkflow
                />
              ))}
            </div>
          </ListSection>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function MissionCardList({
  rows,
  isAdmin,
  showApply,
  npcOnly,
}: {
  rows: MissionSummary[];
  isAdmin: boolean;
  showApply?: boolean;
  npcOnly?: boolean;
}) {
  return (
    <div className="space-y-5">
      {rows.map((m) => (
        <MissionCard key={m.id} m={m} isAdmin={isAdmin} showApply={showApply} npcOnly={npcOnly} />
      ))}
    </div>
  );
}

// The player's applications split into ACTIVE (still awaiting a fixer decision)
// and HISTORY (decided: accepted / rejected / withdrawn). Once an application is
// accepted it leaves the active list and moves to history — the upcoming mission
// itself still surfaces in the "Accepted" tab, so nothing is lost.
function MyApplicationsList({ rows }: { rows: MissionApplicationListItem[] }) {
  const active = rows.filter((a) => a.status === "pending");
  const past = rows.filter((a) => a.status !== "pending");
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h3 className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Active ({active.length})
        </h3>
        {active.length === 0 ? (
          <p
            className="font-mono text-sm text-muted-foreground italic"
            data-testid="text-applications-active-empty"
          >
            No applications awaiting a decision.
          </p>
        ) : (
          active.map((a) => <MyApplicationCard key={a.id} a={a} />)
        )}
      </section>
      <section className="space-y-4">
        <h3 className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          History ({past.length})
        </h3>
        {past.length === 0 ? (
          <p
            className="font-mono text-sm text-muted-foreground italic"
            data-testid="text-applications-history-empty"
          >
            No past applications yet.
          </p>
        ) : (
          past.map((a) => <MyApplicationCard key={a.id} a={a} />)
        )}
      </section>
    </div>
  );
}

function MyApplicationCard({ a }: { a: MissionApplicationListItem }) {
  const when = a.missionStartAt ? new Date(a.missionStartAt) : null;
  const reviewed = a.reviewedAt ? new Date(a.reviewedAt) : null;
  return (
    <Card
      className="rounded-none border-border bg-card/50 hover:border-nc-cyan/50 transition-colors"
      data-testid={`row-application-${a.id}`}
    >
      <CardHeader className="space-y-3">
        <Link href={`/missions/${a.missionId}`}>
          <CardTitle className="font-display text-xl md:text-2xl leading-tight text-foreground hover:text-nc-cyan transition-colors cursor-pointer break-words">
            {a.missionTitle}
          </CardTitle>
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-block font-display font-bold tracking-widest text-sm px-3 py-1 border rounded-none uppercase ${applicationStatusClass(
              a.status,
            )}`}
            data-testid={`application-status-${a.id}`}
          >
            {applicationStatusLabel(a.status)}
          </span>
          <span
            className={`inline-block font-display font-bold tracking-widest text-xs px-2 py-1 border rounded-none uppercase ${missionStatusClass(
              a.missionStatus,
            )}`}
          >
            Mission: {missionStatusLabel(a.missionStatus)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
          <span className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 shrink-0" />
            {when ? (
              <span>
                {when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}{" "}
                {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
            ) : (
              <span className="italic">Not scheduled</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <User className="w-4 h-4 shrink-0" />
            Fixer: <span className="text-nc-magenta">{a.fixerName ?? "—"}</span>
          </span>
        </div>

        <div className="flex items-center gap-2 text-muted-foreground">
          <Users className="w-4 h-4 shrink-0" />
          <span className="uppercase text-xs tracking-widest">Character:</span>
          {a.characterId ? (
            <Link
              href={`/characters/${a.characterId}`}
              className="text-nc-cyan hover:underline"
              data-testid={`link-app-character-${a.characterId}`}
            >
              {a.characterName ?? "—"}
            </Link>
          ) : (
            <span>{a.characterName ?? "—"}</span>
          )}
        </div>

        {a.comment && (
          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed border-l-2 border-border pl-3">
            {a.comment}
          </p>
        )}

        {reviewed && (
          <div className="text-xs text-muted-foreground/80 uppercase tracking-widest">
            Reviewed {reviewed.toLocaleDateString()}{" "}
            {reviewed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActingList({ rows }: { rows: ActingEntry[] }) {
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <ActingCard key={r.id} r={r} />
      ))}
    </div>
  );
}

const ACTING_SOURCE_LABEL: Record<ActingEntry["source"], string> = {
  mission: "Mission",
  event: "Event",
  legacy: "Legacy",
  npc: "NPC",
};

function ActingCard({ r }: { r: ActingEntry }) {
  const when = new Date(r.actedAt);
  const failed = r.paymentStatus === "failed";
  return (
    <Card
      className="rounded-none border-border bg-card/50 hover:border-nc-cyan/50 transition-colors"
      data-testid={`row-acting-${r.id}`}
    >
      <CardHeader className="space-y-3">
        <CardTitle className="font-display text-xl md:text-2xl leading-tight text-foreground break-words flex items-center gap-2">
          <Drama className="w-5 h-5 shrink-0 text-nc-magenta" />
          {r.name ?? "Untitled act"}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-block font-display font-bold tracking-widest text-xs px-2 py-1 border border-nc-cyan/50 text-nc-cyan rounded-none uppercase">
            {ACTING_SOURCE_LABEL[r.source]}
          </span>
          {failed && (
            <span
              className="inline-block font-display font-bold tracking-widest text-xs px-2 py-1 border border-destructive/60 text-destructive rounded-none uppercase"
              data-testid={`acting-status-${r.id}`}
            >
              Pay Failed
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
          <span className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 shrink-0" />
            {when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
          </span>
          <span className="flex items-center gap-2">
            <Banknote className="w-4 h-4 shrink-0" />
            <span className={failed ? "text-destructive" : "text-nc-cyan"}>
              {r.amount.toLocaleString()} eb
            </span>
          </span>
          {r.fixerName && (
            <span className="flex items-center gap-2">
              <User className="w-4 h-4 shrink-0" />
              Fixer: <span className="text-nc-magenta">{r.fixerName}</span>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MissionCard({
  m,
  isAdmin,
  canApprove,
  canManage,
  canAuthor,
  showWorkflow,
  showApply,
  npcOnly,
}: {
  m: MissionSummary;
  isAdmin: boolean;
  canApprove?: boolean;
  canManage?: boolean;
  canAuthor?: boolean;
  showWorkflow?: boolean;
  showApply?: boolean;
  npcOnly?: boolean;
}) {
  const when = m.startAt ? new Date(m.startAt) : null;
  return (
    <Card
      className="rounded-none border-border bg-card/50 hover:border-nc-cyan/50 transition-colors"
      data-testid={`row-mission-${m.id}`}
    >
      <CardHeader className="space-y-3">
        {/* 1. Dominant title */}
        <Link href={`/missions/${m.id}`}>
          <CardTitle className="font-display text-2xl md:text-3xl leading-tight text-foreground hover:text-nc-cyan transition-colors cursor-pointer break-words">
            {m.title}
          </CardTitle>
        </Link>
        {/* 2. Big, bold, color-coded status + tier (+ workflow on owned board) */}
        <div className="flex flex-wrap items-center gap-2">
          {showWorkflow && (
            <span
              className={`inline-block font-display font-bold tracking-widest text-xs px-2 py-1 border rounded-none uppercase ${missionWorkflowClass(
                m.workflowState,
              )}`}
              data-testid={`workflow-mission-${m.id}`}
            >
              {missionWorkflowLabel(m.workflowState)}
            </span>
          )}
          <span
            className={`inline-block font-display font-bold tracking-widest text-sm md:text-base px-3 py-1 border rounded-none uppercase ${missionStatusClass(
              m.status,
            )}`}
            data-testid={`status-mission-${m.id}`}
          >
            {missionStatusLabel(m.status)}
          </span>
          <span
            className={`inline-block font-display font-bold tracking-widest text-xs px-2 py-1 border rounded-none uppercase ${missionTierClass(
              m.tier,
            )}`}
            data-testid={`tier-mission-${m.id}`}
          >
            {missionTierLabel(m.tier)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        {/* 3. Description preview */}
        {m.descriptionPreview ? (
          <Markdown className="text-foreground/90 leading-relaxed">{m.descriptionPreview}</Markdown>
        ) : (
          <p className="text-muted-foreground italic">No description provided.</p>
        )}

        {/* 4. Schedule */}
        <div className="flex items-center gap-2 text-muted-foreground">
          <CalendarDays className="w-4 h-4 shrink-0" />
          {when ? (
            <span>
              {when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}{" "}
              {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {m.durationMinutes ? ` · ${m.durationMinutes} min` : ""}
            </span>
          ) : (
            <span className="italic">Not scheduled</span>
          )}
        </div>

        {/* 5. Location */}
        {m.location && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <MapPin className="w-4 h-4 shrink-0" />
            <span>{m.location}</span>
          </div>
        )}

        {/* 6. Slots + player pay */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
          <span className="flex items-center gap-2">
            <Users className="w-4 h-4 shrink-0" />
            {m.assignedCount}
            {m.slots > 0 ? ` / ${m.slots}` : ""} players
          </span>
          <span className="text-nc-yellow">Player pay: €${m.playerPay.toLocaleString()}</span>
        </div>

        {/* 7. Fixer (clickable for admins) */}
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground uppercase text-xs tracking-widest">Fixer:</span>
          <FixerLink fixerId={m.fixerId} fixerName={m.fixerName} isAdmin={isAdmin} isTrial={m.fixerIsTrial} />
        </div>

        {/* 8. Players (clickable) */}
        <div className="flex items-start gap-2">
          <Users className="w-4 h-4 shrink-0 text-muted-foreground mt-0.5" />
          <span className="text-muted-foreground uppercase text-xs tracking-widest mt-0.5">Players:</span>
          <PlayerLinks m={m} />
        </div>

        {/* 9. Workflow actions (owned board) or inline apply/sign-up (open list) */}
        {showWorkflow && <WorkflowActions m={m} canManage={!!canManage} canAuthor={!!canAuthor} />}
        {showApply && <InlineMissionActions m={m} npcOnly={npcOnly} />}
      </CardContent>
    </Card>
  );
}

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Request failed" : null);
}

// Inline apply / NPC sign-up controls on an Open-tab mission card. Lets a player
// pick a character and apply (or withdraw), and one-click NPC sign-up (or
// remove), all without leaving the missions list. Mirrors the detail page's
// ApplySection / NpcSignupSection logic against the lighter list summary.
// When npcOnly is set (Active tab — PC applications closed), only the NPC
// sign-up control is shown.
function InlineMissionActions({ m, npcOnly }: { m: MissionSummary; npcOnly?: boolean }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
  const chars = useListMyCharacters();
  const apply = useApplyToMission({ mutation: { onSuccess: invalidate } });
  const withdrawApp = useWithdrawApplication({ mutation: { onSuccess: invalidate } });
  const signUp = useSignUpAsNpc({ mutation: { onSuccess: invalidate } });
  const removeNpc = useWithdrawNpcSignup({ mutation: { onSuccess: invalidate } });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [characterId, setCharacterId] = useState<number | "">("");
  const [comment, setComment] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [makeDefault, setMakeDefault] = useState(false);

  // Pre-fill the availability picker from the player's saved weekly default the
  // first time they open the dialog (re-projected onto the current rolling
  // window so stale instants don't carry over). Mirrors the detail-page form.
  const days = useMemo(() => buildDayColumns(), []);
  const def = useGetDefaultAvailability({ query: { enabled: dialogOpen, queryKey: getGetDefaultAvailabilityQueryKey() } });
  const prefilled = useRef(false);
  useEffect(() => {
    if (!dialogOpen || prefilled.current) return;
    if (def.data && def.data.pattern.length > 0) {
      setSlots(expandPattern(def.data.pattern, days));
      prefilled.current = true;
    } else if (!def.isLoading && def.isFetched) {
      prefilled.current = true;
    }
  }, [dialogOpen, def.data, def.isLoading, def.isFetched, days]);

  const appErr = errOf(apply.error) ?? errOf(withdrawApp.error);
  const npcErr = errOf(signUp.error) ?? errOf(removeNpc.error);

  const existing = m.myApplication && m.myApplication.status !== "withdrawn" ? m.myApplication : null;
  const reviewed = existing?.status === "accepted" || existing?.status === "rejected";
  const mySignup = m.mySignup;
  const signupResolved = mySignup?.state === "attended" || mySignup?.state === "no_show";

  return (
    <div className="pt-1 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* --- Player-character application (hidden once applications close) --- */}
        {!npcOnly &&
          (existing ? (
            reviewed ? (
              <span
                className={`inline-flex items-center gap-2 font-display tracking-widest text-xs px-3 py-1 border rounded-none uppercase ${applicationStatusClass(
                  existing.status,
                )}`}
                data-testid={`status-application-${m.id}`}
              >
                {applicationStatusLabel(existing.status)}
                {existing.characterName ? ` · ${existing.characterName}` : ""}
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={withdrawApp.isPending}
                onClick={() => withdrawApp.mutate({ id: m.id, appId: existing.id })}
                className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
                data-testid={`button-withdraw-${m.id}`}
              >
                {withdrawApp.isPending ? "WITHDRAWING..." : "WITHDRAW APPLICATION"}
              </Button>
            )
          ) : (
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid={`button-apply-${m.id}`}
            >
              APPLY AS PLAYER CHARACTER
            </Button>
          ))}

        {/* --- NPC sign-up --- */}
        {mySignup ? (
          signupResolved ? (
            <span
              className="inline-flex items-center gap-2 font-display tracking-widest text-xs px-3 py-1 border rounded-none uppercase border-muted-foreground text-muted-foreground"
              data-testid={`status-npc-${m.id}`}
            >
              {mySignup.state === "attended" ? "NPC: Attended" : "NPC: No-show"}
            </span>
          ) : m.npcSignupOpen ? (
            <Button
              size="sm"
              variant="outline"
              disabled={removeNpc.isPending}
              onClick={() => removeNpc.mutate({ id: m.id })}
              className="rounded-none border-nc-magenta text-nc-magenta hover:bg-nc-magenta/10 font-display tracking-widest"
              data-testid={`button-remove-npc-${m.id}`}
            >
              {removeNpc.isPending ? "REMOVING..." : "REMOVE NPC SIGN-UP"}
            </Button>
          ) : (
            <span
              className="inline-flex items-center gap-2 font-display tracking-widest text-xs px-3 py-1 border rounded-none uppercase border-nc-magenta/60 text-nc-magenta"
              data-testid={`status-npc-${m.id}`}
            >
              NPC: Signed up
            </span>
          )
        ) : (
          m.npcSignupOpen && (
            <Button
              size="sm"
              variant="outline"
              disabled={signUp.isPending}
              onClick={() => signUp.mutate({ id: m.id, data: { characterId: null } })}
              className="rounded-none border-nc-magenta text-nc-magenta hover:bg-nc-magenta/10 font-display tracking-widest"
              data-testid={`button-signup-npc-${m.id}`}
            >
              {signUp.isPending ? "SIGNING UP..." : "SIGN UP AS NPC"}
            </Button>
          )
        )}
      </div>

      {!npcOnly && appErr && (
        <div className="text-destructive text-xs" data-testid={`text-apply-error-${m.id}`}>
          {appErr}
        </div>
      )}
      {npcErr && (
        <div className="text-destructive text-xs" data-testid={`text-npc-error-${m.id}`}>
          {npcErr}
        </div>
      )}

      {!npcOnly && (
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="rounded-none border-border bg-background sm:max-w-3xl max-h-[90vh] overflow-y-auto" data-testid={`dialog-apply-${m.id}`}>
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan uppercase">
              Apply to {m.title}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Pick which of your characters is applying for this job.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 font-mono text-sm">
            <Label className="text-xs">CHARACTER</Label>
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value ? Number(e.target.value) : "")}
              className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
              data-testid={`select-apply-character-${m.id}`}
            >
              <option value="">Select a character…</option>
              {(chars.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Label className="text-xs">COMMENT (optional)</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className="rounded-none"
              placeholder="Why your character is a good fit…"
              data-testid={`input-apply-comment-${m.id}`}
            />
            <div className="space-y-2 pt-1">
              <Label className="text-xs">YOUR AVAILABILITY (optional)</Label>
              <AvailabilityGrid mode="edit" value={slots} onChange={setSlots} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={makeDefault}
                  onCheckedChange={(v) => setMakeDefault(v === true)}
                  className="rounded-none"
                  data-testid={`checkbox-make-default-availability-${m.id}`}
                />
                Make this my default availability
              </label>
            </div>
            {appErr && <div className="text-destructive text-xs">{appErr}</div>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={apply.isPending || characterId === ""}
              onClick={() =>
                apply.mutate(
                  {
                    id: m.id,
                    data: {
                      characterId: Number(characterId),
                      comment: comment || null,
                      availability: slots,
                      makeDefault,
                      defaultPattern: makeDefault ? patternFromInstants(slots) : undefined,
                      timezone: makeDefault ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
                    },
                  },
                  {
                    onSuccess: () => {
                      setDialogOpen(false);
                      setCharacterId("");
                      setComment("");
                    },
                  },
                )
              }
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid={`button-apply-submit-${m.id}`}
            >
              {apply.isPending ? "APPLYING..." : "APPLY"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}
    </div>
  );
}

function WorkflowActions({
  m,
  canManage,
  canAuthor,
}: {
  m: MissionSummary;
  canManage: boolean;
  // Author-level (trial fixers + full managers): may submit a draft. Trial
  // fixers stop there — Post / Close-applications stay manager-only.
  canAuthor?: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListOwnedMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListCreatedMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
  };
  const submit = useSubmitMission({ mutation: { onSuccess: invalidate } });
  const post = usePostMission({ mutation: { onSuccess: invalidate } });
  const del = useDeleteMission({ mutation: { onSuccess: invalidate } });
  const busy = submit.isPending || post.isPending || del.isPending;

  if (m.workflowState === "draft" && (canManage || canAuthor)) {
    return (
      <div className="pt-1 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => submit.mutate({ id: m.id })}
          className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest"
          data-testid={`button-submit-${m.id}`}
        >
          {submit.isPending ? "SUBMITTING..." : "SUBMIT FOR APPROVAL"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Delete draft mission "${m.title}"? This cannot be undone.`,
              )
            ) {
              del.mutate({ id: m.id });
            }
          }}
          className="rounded-none border-destructive/60 text-destructive hover:bg-destructive/10 font-display tracking-widest"
          data-testid={`button-delete-${m.id}`}
        >
          <Trash2 className="w-4 h-4" />
          {del.isPending ? "DELETING..." : "DELETE DRAFT"}
        </Button>
      </div>
    );
  }
  // Proposals are now approved from the Misc Requests / Pending Requests queue,
  // not here. A proposal awaiting approval simply shows its workflow badge with
  // no action on this board.
  if (m.workflowState === "proposal") {
    return (
      <div className="pt-1">
        <span className="font-mono text-xs text-muted-foreground" data-testid={`text-awaiting-approval-${m.id}`}>
          Awaiting approval in Pending Requests
        </span>
      </div>
    );
  }
  if (m.workflowState === "approved" && canManage) {
    return (
      <div className="pt-1">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => post.mutate({ id: m.id })}
          className="rounded-none bg-green-600 text-background hover:bg-green-600/80 font-display tracking-widest"
          data-testid={`button-post-${m.id}`}
        >
          {post.isPending ? "POSTING..." : "POST TO MISSIONS"}
        </Button>
      </div>
    );
  }
  // A live (posted) mission can have its PC-application window opened/closed by
  // the fixer — toggling between the Open and Active browse tabs.
  if (m.workflowState === "posted" && canManage) {
    if (m.status !== "open" && m.status !== "pending") return null;
    return (
      <div className="pt-1">
        <CloseApplicationsButton missionId={m.id} status={m.status} onSuccess={invalidate} />
      </div>
    );
  }
  return null;
}

// --- Tab group chrome: visual labels + dividers separating Browse / You / Fixer.
function TabGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 select-none">
      {children}
    </span>
  );
}

function TabDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-border" />;
}

function TabTriggers({ tabs }: { tabs: TabDef[] }) {
  return (
    <>
      {tabs.map((t) => (
        <TabsTrigger
          key={t.key}
          value={t.key}
          className="rounded-none font-display tracking-widest text-xs data-[state=active]:bg-nc-magenta data-[state=active]:text-background"
          data-testid={`tab-${t.key}`}
        >
          {t.label.toUpperCase()}
          {typeof t.count === "number" && <span className="ml-1.5 opacity-70">({t.count})</span>}
        </TabsTrigger>
      ))}
    </>
  );
}

function FixerLink({
  fixerId,
  fixerName,
  isAdmin,
  isTrial = false,
}: {
  fixerId: string | null | undefined;
  fixerName: string | null | undefined;
  isAdmin: boolean;
  isTrial?: boolean;
}) {
  if (!fixerName) return <span className="text-muted-foreground">—</span>;
  // Only admins have a user profile route to link to. Everyone else sees the
  // name as plain text (graceful degradation — there is no public fixer page).
  const inner =
    isAdmin && fixerId ? (
      <Link
        href={`/admin/users/${fixerId}`}
        className="text-nc-magenta hover:underline font-semibold"
        data-testid={`link-fixer-${fixerId}`}
      >
        {fixerName}
      </Link>
    ) : (
      <span className="text-nc-magenta font-semibold">{fixerName}</span>
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      {inner}
      <TrialFixerBadge show={isTrial} />
    </span>
  );
}

function PlayerLinks({ m }: { m: MissionSummary }) {
  // The caller's own assigned character routes to the rich owner page; everyone
  // else routes to the directory profile (visible to owners, fixers, admins).
  const players = m.players ?? [];
  if (players.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {players.map((p, i) => {
        const href =
          m.myCharacterId === p.characterId
            ? `/characters/${p.characterId}`
            : `/directory/characters/${p.characterId}`;
        return (
          <span key={p.characterId} className="inline-flex items-center">
            <Link
              href={href}
              className="text-nc-cyan hover:underline"
              data-testid={`link-player-${p.characterId}`}
            >
              {p.name}
            </Link>
            {i < players.length - 1 ? <span className="text-muted-foreground">,</span> : null}
          </span>
        );
      })}
    </div>
  );
}
