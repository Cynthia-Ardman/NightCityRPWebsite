import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyMissions,
  useListMissions,
  useListOwnedMissions,
  useSubmitMission,
  useApproveMission,
  usePostMission,
  getListMissionsQueryKey,
  getListOwnedMissionsQueryKey,
  type MissionSummary,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Briefcase, CalendarDays, MapPin, Plus, User, Users } from "lucide-react";
import {
  missionStatusClass,
  missionStatusLabel,
  missionTierClass,
  missionTierLabel,
  missionWorkflowClass,
  missionWorkflowLabel,
  WORKFLOW_STATES,
} from "@/lib/missionStatus";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";
import { MissionOutcomesBanner } from "@/components/MissionOutcomesBanner";

export default function Missions() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);
  const isAdmin = !!me?.isAdmin;
  const canApprove = !!me && (me.isArchivist || me.isAdmin);
  // Archivists are approvers, not creators: they get the board to find proposals
  // to approve, but not the Create affordance or test-mode banner.
  const canSeeOwnedBoard = isStaff || canApprove;

  const mine = useListMyMissions();
  const owned = useListOwnedMissions({
    query: { enabled: canSeeOwnedBoard, queryKey: getListOwnedMissionsQueryKey() },
  });
  // Players see only posted missions (the server enforces this); staff/approvers
  // get their full owned board above, so the public list is player-facing only.
  const available = useListMissions(undefined, {
    query: { enabled: !canSeeOwnedBoard, queryKey: getListMissionsQueryKey() },
  });

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

      {canSeeOwnedBoard && (
        <section className="space-y-4" data-testid="card-owned-missions">
          <h2 className="font-display tracking-widest text-lg text-nc-cyan">
            MY MISSIONS{" "}
            <span className="text-xs text-muted-foreground font-mono">
              ({isAdmin || canApprove ? "all missions" : "missions you run"})
            </span>
          </h2>
          {owned.isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
          ) : !owned.data || owned.data.length === 0 ? (
            <div className="font-mono text-muted-foreground italic">
              No missions yet. Use “Create Mission” to draft one.
            </div>
          ) : (
            <OwnedMissionBoard rows={owned.data} isAdmin={isAdmin} canApprove={canApprove} canManage={isStaff} />
          )}
        </section>
      )}

      <section className="space-y-4">
        <h2 className="font-display tracking-widest text-lg">
          {isStaff ? "ASSIGNED TO YOU" : "YOUR MISSIONS"}
        </h2>
        {mine.isLoading ? (
          <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
        ) : !mine.data || mine.data.length === 0 ? (
          <div className="font-mono text-muted-foreground italic">No missions yet.</div>
        ) : (
          <MissionCardList rows={mine.data} isAdmin={isAdmin} />
        )}
      </section>

      {!isStaff && (
        <section className="space-y-4" data-testid="card-available-missions">
          <h2 className="font-display tracking-widest text-lg text-nc-cyan">AVAILABLE MISSIONS</h2>
          {available.isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
          ) : !available.data || available.data.length === 0 ? (
            <div className="font-mono text-muted-foreground italic">
              No open missions right now. Check back soon.
            </div>
          ) : (
            <MissionCardList rows={available.data} isAdmin={isAdmin} showApply />
          )}
        </section>
      )}
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

        {/* 9. Workflow actions (owned board) or Apply (available list) */}
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
