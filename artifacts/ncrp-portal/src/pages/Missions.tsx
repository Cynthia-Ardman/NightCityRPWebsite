import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyMissions,
  useListMissions,
  useListOwnedMissions,
  useListCreatedMissions,
  useListMissionHistory,
  useListMyApplications,
  useSubmitMission,
  useApproveMission,
  usePostMission,
  getListMissionsQueryKey,
  getListOwnedMissionsQueryKey,
  getListCreatedMissionsQueryKey,
  type MissionSummary,
  type MissionApplicationListItem,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  Briefcase,
  CalendarDays,
  MapPin,
  Plus,
  User,
  Users,
  Clock,
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
} from "@/lib/missionStatus";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";
import { MissionOutcomesBanner } from "@/components/MissionOutcomesBanner";

type TabKey = "open" | "accepted" | "applications" | "created" | "history" | "all";

export default function Missions() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);
  const isAdmin = !!me?.isAdmin;
  const canApprove = !!me && (me.isArchivist || me.isAdmin);
  // Archivists approve but don't create; fixers/admins both create and manage.
  // Staff tabs (My Created / All Missions) are visible to anyone in those roles.
  const canSeeStaffTabs = isStaff || canApprove;

  const [tab, setTab] = useState<TabKey>("open");

  // --- Data sources, each scoped + enabled by role ---
  // Open: posted + open missions anyone can apply to. The server returns only
  // posted missions to players; staff get all, so we filter to posted here too.
  const available = useListMissions(undefined, {
    query: { queryKey: getListMissionsQueryKey() },
  });
  const openMissions = useMemo(
    () =>
      (available.data ?? []).filter(
        (m) => m.workflowState === "posted" && m.status === "open",
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

  // My Created: missions the caller personally runs (staff only).
  const created = useListCreatedMissions({
    query: { enabled: isStaff, queryKey: getListCreatedMissionsQueryKey() },
  });

  // Mission History: completed/cancelled missions relevant to the caller.
  const history = useListMissionHistory();

  // All Missions: the staff-wide board (managers + approvers only).
  const owned = useListOwnedMissions({
    query: { enabled: canSeeStaffTabs, queryKey: getListOwnedMissionsQueryKey() },
  });

  const tabs: { key: TabKey; label: string; count?: number; show: boolean }[] = [
    { key: "open", label: "Open", count: openMissions.length, show: true },
    { key: "accepted", label: "Accepted", count: acceptedMissions.length, show: true },
    { key: "applications", label: "My Applications", count: myApps.data?.length, show: true },
    { key: "created", label: "My Created", count: created.data?.length, show: isStaff },
    { key: "history", label: "History", count: history.data?.length, show: true },
    { key: "all", label: "All Missions", count: owned.data?.length, show: canSeeStaffTabs },
  ];
  const visibleTabs = tabs.filter((t) => t.show);

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-display text-nc-magenta tracking-widest flex items-center gap-3">
            <Briefcase className="w-7 h-7" /> MISSIONS
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Scheduled jobs run by fixers, with payouts to the players who show up.
          </p>
        </div>
        {isStaff && (
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

      {isStaff && <MissionTestModeBanner />}

      <MissionOutcomesBanner />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-6">
        <TabsList className="rounded-none bg-card/60 border border-border p-1 flex flex-wrap h-auto justify-start gap-1">
          {visibleTabs.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              className="rounded-none font-display tracking-widest text-xs data-[state=active]:bg-nc-magenta data-[state=active]:text-background"
              data-testid={`tab-${t.key}`}
            >
              {t.label.toUpperCase()}
              {typeof t.count === "number" && (
                <span className="ml-1.5 opacity-70">({t.count})</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="open" data-testid="tabpanel-open">
          <ListSection
            isLoading={available.isLoading}
            isEmpty={openMissions.length === 0}
            emptyText="No open missions right now. Check back soon."
          >
            <MissionCardList rows={openMissions} isAdmin={isAdmin} showApply />
          </ListSection>
        </TabsContent>

        <TabsContent value="accepted" data-testid="tabpanel-accepted">
          <ListSection
            isLoading={mine.isLoading}
            isEmpty={acceptedMissions.length === 0}
            emptyText="You're not on any upcoming missions yet. Apply to one from the Open tab."
          >
            <MissionCardList rows={acceptedMissions} isAdmin={isAdmin} />
          </ListSection>
        </TabsContent>

        <TabsContent value="applications" data-testid="tabpanel-applications">
          <ListSection
            isLoading={myApps.isLoading}
            isEmpty={(myApps.data?.length ?? 0) === 0}
            emptyText="You haven't applied to any missions yet."
          >
            <MyApplicationsList rows={myApps.data ?? []} />
          </ListSection>
        </TabsContent>

        {isStaff && (
          <TabsContent value="created" data-testid="tabpanel-created">
            <ListSection
              isLoading={created.isLoading}
              isEmpty={(created.data?.length ?? 0) === 0}
              emptyText="No missions yet. Use “Create Mission” to draft one."
            >
              <OwnedMissionBoard
                rows={created.data ?? []}
                isAdmin={isAdmin}
                canApprove={canApprove}
                canManage={isStaff}
              />
            </ListSection>
          </TabsContent>
        )}

        <TabsContent value="history" data-testid="tabpanel-history">
          <ListSection
            isLoading={history.isLoading}
            isEmpty={(history.data?.length ?? 0) === 0}
            emptyText="No completed missions in your history yet."
          >
            <MissionCardList rows={history.data ?? []} isAdmin={isAdmin} />
          </ListSection>
        </TabsContent>

        {canSeeStaffTabs && (
          <TabsContent value="all" data-testid="tabpanel-all">
            <AllMissionsTab
              rows={owned.data ?? []}
              isLoading={owned.isLoading}
              isAdmin={isAdmin}
              canApprove={canApprove}
              canManage={isStaff}
            />
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

function OwnedMissionBoard({
  rows,
  isAdmin,
  canApprove,
  canManage,
}: {
  rows: MissionSummary[];
  isAdmin: boolean;
  canApprove: boolean;
  canManage: boolean;
}) {
  // Group by workflow state so the fixer sees the pipeline at a glance.
  return (
    <div className="space-y-6">
      {WORKFLOW_STATES.map((state) => {
        const group = rows.filter((m) => m.workflowState === state);
        if (group.length === 0) return null;
        return (
          <div key={state} className="space-y-3" data-testid={`group-workflow-${state}`}>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={`rounded-none font-bold tracking-widest uppercase ${missionWorkflowClass(state)}`}
              >
                {missionWorkflowLabel(state)}
              </Badge>
              <span className="text-xs font-mono text-muted-foreground">({group.length})</span>
            </div>
            <div className="space-y-5">
              {group.map((m) => (
                <MissionCard key={m.id} m={m} isAdmin={isAdmin} canApprove={canApprove} canManage={canManage} showWorkflow />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MissionCardList({
  rows,
  isAdmin,
  showApply,
}: {
  rows: MissionSummary[];
  isAdmin: boolean;
  showApply?: boolean;
}) {
  return (
    <div className="space-y-5">
      {rows.map((m) => (
        <MissionCard key={m.id} m={m} isAdmin={isAdmin} showApply={showApply} />
      ))}
    </div>
  );
}

function MyApplicationsList({ rows }: { rows: MissionApplicationListItem[] }) {
  return (
    <div className="space-y-4">
      {rows.map((a) => (
        <MyApplicationCard key={a.id} a={a} />
      ))}
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

function MissionCard({
  m,
  isAdmin,
  canApprove,
  canManage,
  showWorkflow,
  showApply,
}: {
  m: MissionSummary;
  isAdmin: boolean;
  canApprove?: boolean;
  canManage?: boolean;
  showWorkflow?: boolean;
  showApply?: boolean;
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
          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">{m.descriptionPreview}</p>
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
          <FixerLink fixerId={m.fixerId} fixerName={m.fixerName} isAdmin={isAdmin} />
        </div>

        {/* 8. Players (clickable) */}
        <div className="flex items-start gap-2">
          <Users className="w-4 h-4 shrink-0 text-muted-foreground mt-0.5" />
          <span className="text-muted-foreground uppercase text-xs tracking-widest mt-0.5">Players:</span>
          <PlayerLinks m={m} />
        </div>

        {/* 9. Workflow actions (owned board) or Apply (open list) */}
        {showWorkflow && <WorkflowActions m={m} canApprove={!!canApprove} canManage={!!canManage} />}
        {showApply && (
          <div className="pt-1">
            <Link href={`/missions/${m.id}`}>
              <Button
                size="sm"
                className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                data-testid={`button-apply-${m.id}`}
              >
                APPLY
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowActions({
  m,
  canApprove,
  canManage,
}: {
  m: MissionSummary;
  canApprove: boolean;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListOwnedMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListCreatedMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
  };
  const submit = useSubmitMission({ mutation: { onSuccess: invalidate } });
  const approve = useApproveMission({ mutation: { onSuccess: invalidate } });
  const post = usePostMission({ mutation: { onSuccess: invalidate } });
  const busy = submit.isPending || approve.isPending || post.isPending;

  if (m.workflowState === "draft" && canManage) {
    return (
      <div className="pt-1">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => submit.mutate({ id: m.id })}
          className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest"
          data-testid={`button-submit-${m.id}`}
        >
          {submit.isPending ? "SUBMITTING..." : "SUBMIT FOR APPROVAL"}
        </Button>
      </div>
    );
  }
  if (m.workflowState === "proposal" && canApprove) {
    return (
      <div className="pt-1">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => approve.mutate({ id: m.id })}
          className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
          data-testid={`button-approve-${m.id}`}
        >
          {approve.isPending ? "APPROVING..." : "APPROVE"}
        </Button>
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
  return null;
}

function FixerLink({
  fixerId,
  fixerName,
  isAdmin,
}: {
  fixerId: string | null | undefined;
  fixerName: string | null | undefined;
  isAdmin: boolean;
}) {
  if (!fixerName) return <span className="text-muted-foreground">—</span>;
  // Only admins have a user profile route to link to. Everyone else sees the
  // name as plain text (graceful degradation — there is no public fixer page).
  if (isAdmin && fixerId) {
    return (
      <Link
        href={`/admin/users/${fixerId}`}
        className="text-nc-magenta hover:underline font-semibold"
        data-testid={`link-fixer-${fixerId}`}
      >
        {fixerName}
      </Link>
    );
  }
  return <span className="text-nc-magenta font-semibold">{fixerName}</span>;
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
