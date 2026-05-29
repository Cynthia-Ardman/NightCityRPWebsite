import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMission,
  usePayMissionPlayers,
  usePayMissionActors,
  useSubmitMission,
  useApproveMission,
  usePostMission,
  useApplyToMission,
  useWithdrawApplication,
  useReviewApplication,
  useListMyCharacters,
  getGetMissionQueryKey,
  type MissionDetail as MissionDetailModel,
  type MissionAssignmentView,
  type MissionApplicationView,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Briefcase,
  ArrowLeft,
  CalendarDays,
  MapPin,
  Users,
  Pencil,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Clock,
} from "lucide-react";
import {
  missionStatusClass,
  missionStatusLabel,
  missionTierClass,
  missionTierLabel,
  missionWorkflowClass,
  missionWorkflowLabel,
  jobTypeLabel,
} from "@/lib/missionStatus";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Request failed" : null);
}

export default function MissionDetail() {
  const { id } = useParams();
  const missionId = Number(id);
  const { data, isLoading, error } = useGetMission(missionId, {
    query: { enabled: Number.isInteger(missionId), queryKey: getGetMissionQueryKey(missionId) },
  });

  if (isLoading) {
    return <div className="max-w-4xl mx-auto font-mono text-nc-cyan animate-pulse">Loading mission...</div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <Link href="/missions" className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> back to missions
        </Link>
        <div className="font-mono text-destructive">Mission not found or you don't have access.</div>
      </div>
    );
  }

  const when = data.startAt ? new Date(data.startAt) : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <Link
        href="/missions"
        className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1"
        data-testid="link-back-missions"
      >
        <ArrowLeft className="w-4 h-4" /> back to missions
      </Link>

      <MissionTestModeBanner live={data.live} />

      {data.imageUrl && (
        <div className="w-full overflow-hidden border border-border rounded-none bg-card/40">
          <img src={data.imageUrl} alt={data.title} className="w-full max-h-72 object-cover" />
        </div>
      )}

      <div>
        <div className="flex items-center gap-3 text-nc-magenta">
          <Briefcase className="w-6 h-6" />
          <span className="font-display text-xs uppercase tracking-widest">Mission</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-display text-foreground tracking-wider mt-1" data-testid="text-mission-title">
          {data.title}
        </h1>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          {data.canManage && (
            <Badge
              variant="outline"
              className={`rounded-none font-bold tracking-widest uppercase ${missionWorkflowClass(data.workflowState)}`}
              data-testid="badge-workflow"
            >
              {missionWorkflowLabel(data.workflowState)}
            </Badge>
          )}
          <Badge variant="outline" className={`rounded-none font-bold tracking-widest uppercase ${missionStatusClass(data.status)}`}>
            {missionStatusLabel(data.status)}
          </Badge>
          <Badge variant="outline" className={`rounded-none font-bold tracking-widest uppercase ${missionTierClass(data.tier)}`}>
            {missionTierLabel(data.tier)}
          </Badge>
          {data.jobType && (
            <Badge variant="outline" className="rounded-none font-bold tracking-widest uppercase border-border text-muted-foreground">
              {jobTypeLabel(data.jobType)}
            </Badge>
          )}
          <span className="text-nc-yellow font-mono text-xs uppercase tracking-widest">
            Player pay €${data.playerPay.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-sm">
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <CalendarDays className="w-4 h-4 shrink-0" />
          {when ? (
            <span>
              {when.toLocaleDateString()} {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {data.durationMinutes ? ` · ${data.durationMinutes}m` : ""}
            </span>
          ) : (
            <span className="italic">Not scheduled</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <MapPin className="w-4 h-4 shrink-0" />
          <span>{data.location || <span className="italic">No location</span>}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <Users className="w-4 h-4 shrink-0" />
          <span>
            {data.assignments.length}
            {data.maxPlayers > 0 ? ` / ${data.maxPlayers}` : data.slots > 0 ? ` / ${data.slots}` : ""} players
          </span>
        </div>
      </div>

      {data.canManage ? (
        <Tabs defaultValue="player" className="w-full">
          <TabsList className="rounded-none bg-card/60 border border-border">
            <TabsTrigger value="player" className="rounded-none font-display tracking-widest" data-testid="tab-player">
              PLAYER
            </TabsTrigger>
            <TabsTrigger value="fixer" className="rounded-none font-display tracking-widest" data-testid="tab-fixer">
              FIXER
            </TabsTrigger>
          </TabsList>
          <TabsContent value="player" className="mt-4 space-y-6">
            <PlayerView data={data} />
          </TabsContent>
          <TabsContent value="fixer" className="mt-4 space-y-6">
            <FixerView data={data} />
          </TabsContent>
        </Tabs>
      ) : (
        <>
          {data.canApprove && <WorkflowPanel data={data} />}
          <PlayerView data={data} />
        </>
      )}
    </div>
  );
}

function MissionFacts({ data }: { data: MissionDetailModel }) {
  const facts: Array<{ label: string; value: string | null | undefined }> = [
    { label: "Job Type", value: data.jobType ? jobTypeLabel(data.jobType) : null },
    { label: "Client", value: data.client },
    { label: "Requested Skills", value: data.requestedSkills },
    { label: "Max Players", value: data.maxPlayers > 0 ? String(data.maxPlayers) : null },
  ];
  const shown = facts.filter((f) => f.value);
  if (shown.length === 0 && !data.notesForPlayers) return null;
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        {shown.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {shown.map((f) => (
              <div key={f.label} className="flex flex-col">
                <span className="text-muted-foreground uppercase text-[10px] tracking-widest">{f.label}</span>
                <span className="text-foreground">{f.value}</span>
              </div>
            ))}
          </div>
        )}
        {data.notesForPlayers && (
          <div className="flex flex-col pt-1">
            <span className="text-muted-foreground uppercase text-[10px] tracking-widest">Notes for Players</span>
            <p className="text-foreground whitespace-pre-wrap">{data.notesForPlayers}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlayerView({ data }: { data: MissionDetailModel }) {
  return (
    <>
      {data.description && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Brief</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm whitespace-pre-wrap text-foreground">{data.description}</p>
          </CardContent>
        </Card>
      )}

      <MissionFacts data={data} />

      {/* Staff-only world/join link */}
      {data.canManage && data.worldLink && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
              World / Join Link <span className="text-nc-magenta">(staff only)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <a
              href={data.worldLink}
              target="_blank"
              rel="noreferrer"
              className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1 break-all"
              data-testid="link-world"
            >
              <ExternalLink className="w-4 h-4 shrink-0" /> {data.worldLink}
            </a>
          </CardContent>
        </Card>
      )}

      {/* Apply (players only, posted missions) */}
      {!data.canManage && <ApplySection data={data} />}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Fixer</CardTitle>
        </CardHeader>
        <CardContent>
          {data.fixerId ? (
            <div className="flex items-center gap-3" data-testid="block-fixer">
              <Avatar className="border border-nc-magenta/30 rounded-none w-12 h-12">
                <AvatarImage src={data.fixerAvatarUrl ?? undefined} />
                <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display">
                  {(data.fixerName ?? "??").substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="font-display text-foreground">{data.fixerName ?? "(unknown fixer)"}</div>
                <div className="text-xs font-mono text-muted-foreground">Fixer running this job</div>
              </div>
            </div>
          ) : (
            <div className="font-mono text-muted-foreground italic">Fixer record unavailable.</div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Players ({data.assignments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.assignments.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No players assigned yet.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {data.assignments.map((a) => (
                <li key={a.id} data-testid={`row-assignment-${a.id}`}>
                  <AssignmentRow a={a} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ApplySection({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const chars = useListMyCharacters();
  const apply = useApplyToMission({ mutation: { onSuccess: invalidate } });
  const withdraw = useWithdrawApplication({ mutation: { onSuccess: invalidate } });

  const [characterId, setCharacterId] = useState<number | "">("");
  const [comment, setComment] = useState("");

  const existing = data.myApplication;
  const applyErr = errOf(apply.error) ?? errOf(withdraw.error);

  // Only posted missions accept applications.
  if (data.workflowState !== "posted") return null;

  if (existing && existing.status !== "withdrawn") {
    return (
      <Card className="rounded-none border-border bg-card/50" data-testid="block-my-application">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Your Application
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 font-mono text-sm">
          <div className="flex items-center gap-2">
            <ApplicationStatusBadge status={existing.status} />
            <span className="text-foreground">{existing.characterName ?? "(your character)"}</span>
          </div>
          {existing.comment && <p className="text-muted-foreground whitespace-pre-wrap">{existing.comment}</p>}
          {existing.status === "pending" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate({ id: data.id, appId: existing.id })}
              className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
              data-testid="button-withdraw"
            >
              {withdraw.isPending ? "WITHDRAWING..." : "WITHDRAW"}
            </Button>
          )}
          {applyErr && <div className="text-destructive text-xs" data-testid="text-apply-error">{applyErr}</div>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-none border-border bg-nc-cyan/5 border-nc-cyan/40" data-testid="block-apply">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-nc-cyan">Apply for this Mission</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <div>
          <Label className="text-xs">CHARACTER</Label>
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value ? Number(e.target.value) : "")}
            className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
            data-testid="select-apply-character"
          >
            <option value="">Select a character…</option>
            {(chars.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs">COMMENT (optional)</Label>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            className="rounded-none"
            placeholder="Why your character is a good fit…"
            data-testid="input-apply-comment"
          />
        </div>
        <Button
          type="button"
          disabled={apply.isPending || characterId === ""}
          onClick={() =>
            apply.mutate(
              { id: data.id, data: { characterId: Number(characterId), comment: comment || null } },
              { onSuccess: () => setComment("") },
            )
          }
          className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
          data-testid="button-apply-submit"
        >
          {apply.isPending ? "APPLYING..." : "APPLY"}
        </Button>
        {applyErr && <div className="text-destructive text-xs" data-testid="text-apply-error">{applyErr}</div>}
      </CardContent>
    </Card>
  );
}

function ApplicationStatusBadge({ status }: { status: string }) {
  const cls =
    status === "accepted"
      ? "border-green-500 text-green-400 bg-green-500/10"
      : status === "rejected"
        ? "border-destructive text-destructive bg-destructive/10"
        : status === "withdrawn"
          ? "border-muted-foreground text-muted-foreground bg-muted/10"
          : "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
      {label}
    </Badge>
  );
}

function AssignmentRow({ a }: { a: MissionAssignmentView }) {
  const inner = (
    <div className="flex items-center gap-3 py-3">
      <Avatar className="border border-nc-cyan/30 rounded-none w-10 h-10">
        <AvatarImage src={a.characterPortraitUrl ?? a.userAvatarUrl ?? undefined} />
        <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
          {(a.characterName ?? a.userName ?? "??").substring(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-display text-foreground">
          {a.characterName ?? <span className="text-muted-foreground italic">(no character)</span>}
        </div>
        {a.userName && <div className="text-xs font-mono text-muted-foreground">{a.userName}</div>}
      </div>
      <div className="text-right space-y-1">
        {a.attendanceCreditedAt && (
          <div className="text-[10px] font-mono text-green-400 inline-flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Attended
          </div>
        )}
        <PaymentBadge status={a.paymentStatus} amount={a.payAmount} error={a.paymentError} />
      </div>
    </div>
  );
  return a.characterId ? (
    <Link href={`/directory/characters/${a.characterId}`} className="block hover:bg-card/80 transition px-2 -mx-2">
      {inner}
    </Link>
  ) : (
    <div className="px-2 -mx-2">{inner}</div>
  );
}

function PaymentBadge({
  status,
  amount,
  error,
}: {
  status: string;
  amount?: number | null;
  error?: string | null;
}) {
  const cls =
    status === "paid"
      ? "border-green-500 text-green-400 bg-green-500/10"
      : status === "failed"
        ? "border-destructive text-destructive bg-destructive/10"
        : "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
  const label = status === "paid" ? "Paid" : status === "failed" ? "Failed" : "Unpaid";
  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
        {label}
        {amount ? ` €$${amount.toLocaleString()}` : ""}
      </Badge>
      {error && <span className="text-[10px] font-mono text-destructive max-w-[12rem] truncate" title={error}>{error}</span>}
    </div>
  );
}

function WorkflowPanel({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const submit = useSubmitMission({ mutation: { onSuccess: invalidate } });
  const approve = useApproveMission({ mutation: { onSuccess: invalidate } });
  const post = usePostMission({ mutation: { onSuccess: invalidate } });
  const busy = submit.isPending || approve.isPending || post.isPending;
  const err = errOf(submit.error) ?? errOf(approve.error) ?? errOf(post.error);

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Workflow — {missionWorkflowLabel(data.workflowState)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <p className="text-muted-foreground text-xs">
          Draft → Proposal → Approved → Posted. Only posted missions are visible to players.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {data.workflowState === "draft" &&
            (data.canManage ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => submit.mutate({ id: data.id })}
                className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest"
                data-testid="button-submit-proposal"
              >
                {submit.isPending ? "SUBMITTING..." : "SUBMIT FOR APPROVAL"}
              </Button>
            ) : (
              <span className="text-muted-foreground text-xs">Draft — awaiting the fixer to submit.</span>
            ))}
          {data.workflowState === "proposal" &&
            (data.canApprove ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => approve.mutate({ id: data.id })}
                className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                data-testid="button-approve"
              >
                {approve.isPending ? "APPROVING..." : "APPROVE"}
              </Button>
            ) : (
              <span className="text-muted-foreground text-xs">Awaiting archivist approval.</span>
            ))}
          {data.workflowState === "approved" &&
            (data.canManage ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => post.mutate({ id: data.id })}
                className="rounded-none bg-green-600 text-background hover:bg-green-600/80 font-display tracking-widest"
                data-testid="button-post"
              >
                {post.isPending ? "POSTING..." : "POST TO MISSIONS"}
              </Button>
            ) : (
              <span className="text-muted-foreground text-xs">Approved — awaiting the fixer to post.</span>
            ))}
          {data.workflowState === "posted" && (
            <span className="text-green-400 text-xs inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Live on the public board.
            </span>
          )}
        </div>
        {err && <div className="text-destructive text-xs" data-testid="text-workflow-error">{err}</div>}
      </CardContent>
    </Card>
  );
}

function ApplicationsPanel({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const review = useReviewApplication({ mutation: { onSuccess: invalidate } });
  const err = errOf(review.error);

  const pending = data.applications.filter((a) => a.status === "pending");
  const decided = data.applications.filter((a) => a.status !== "pending");

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Applications ({data.applications.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        {data.applications.length === 0 ? (
          <p className="text-muted-foreground italic">No applications yet.</p>
        ) : (
          <>
            {pending.map((a) => (
              <ApplicationReviewRow
                key={a.id}
                a={a}
                missionId={data.id}
                onAction={(action) =>
                  review.mutate({ id: data.id, appId: a.id, data: { action } })
                }
                busy={review.isPending}
              />
            ))}
            {decided.length > 0 && (
              <div className="pt-2 space-y-2 border-t border-border/40">
                {decided.map((a) => (
                  <div key={a.id} className="flex items-center gap-2" data-testid={`row-application-${a.id}`}>
                    <ApplicationStatusBadge status={a.status} />
                    <span className="text-foreground">{a.characterName ?? "(character)"}</span>
                    {a.userName && <span className="text-muted-foreground text-xs">({a.userName})</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {err && <div className="text-destructive text-xs" data-testid="text-review-error">{err}</div>}
      </CardContent>
    </Card>
  );
}

function ApplicationReviewRow({
  a,
  missionId,
  onAction,
  busy,
}: {
  a: MissionApplicationView;
  missionId: number;
  onAction: (action: "accept" | "reject") => void;
  busy: boolean;
}) {
  return (
    <div className="border border-border bg-background/40 p-3 space-y-2" data-testid={`row-application-${a.id}`}>
      <div className="flex items-start gap-3">
        <Avatar className="border border-nc-cyan/30 rounded-none w-10 h-10">
          <AvatarImage src={a.characterPortraitUrl ?? a.userAvatarUrl ?? undefined} />
          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
            {(a.characterName ?? a.userName ?? "??").substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <Link
            href={`/directory/characters/${a.characterId}`}
            className="font-display text-foreground hover:text-nc-cyan transition-colors"
          >
            {a.characterName ?? "(character)"}
          </Link>
          {a.userName && <div className="text-xs text-muted-foreground">{a.userName}</div>}
          <div className="text-xs text-muted-foreground mt-1">
            Missions attended: {a.attendanceCount}
          </div>
          {a.recencyWarning && (
            <div className="text-[11px] text-nc-yellow inline-flex items-center gap-1 mt-1" data-testid={`recency-warning-${a.id}`}>
              <Clock className="w-3 h-3" />
              {a.daysSinceLastMission != null
                ? `Played a mission ${a.daysSinceLastMission} day${a.daysSinceLastMission === 1 ? "" : "s"} ago`
                : "Recently played a mission"}
            </div>
          )}
        </div>
      </div>
      {a.comment && <p className="text-muted-foreground whitespace-pre-wrap text-xs pl-1">{a.comment}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onAction("accept")}
          className="rounded-none bg-green-600 text-background hover:bg-green-600/80 font-display tracking-widest"
          data-testid={`button-accept-${a.id}`}
        >
          ACCEPT
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onAction("reject")}
          className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
          data-testid={`button-reject-${a.id}`}
        >
          REJECT
        </Button>
      </div>
    </div>
  );
}

function FixerView({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });

  const payPlayers = usePayMissionPlayers({ mutation: { onSuccess: invalidate } });
  const payActors = usePayMissionActors({ mutation: { onSuccess: invalidate } });

  const [actorIds, setActorIds] = useState<string[]>([]);
  const [actorAmount, setActorAmount] = useState(0);

  const toggleActor = (userId: string) =>
    setActorIds((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]));

  const playersPaid = data.status === "completed_players_paid" || data.status === "completed_paid";
  const payPlayersErr = errOf(payPlayers.error);
  const payActorsErr = errOf(payActors.error);

  return (
    <>
      {data.discordSyncError && (
        <div className="border border-destructive bg-destructive/10 text-destructive font-mono text-xs p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Discord event sync error: {data.discordSyncError}</span>
        </div>
      )}

      <WorkflowPanel data={data} />

      <ApplicationsPanel data={data} />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Mission Tools
          </CardTitle>
          <Link
            href={`/fixer/missions?edit=${data.id}`}
            className="text-nc-cyan font-mono text-xs hover:underline inline-flex items-center gap-1"
            data-testid="link-edit-mission"
          >
            <Pencil className="w-3 h-3" /> edit
          </Link>
        </CardHeader>
        <CardContent className="space-y-4 font-mono text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={payPlayers.isPending || playersPaid || data.assignments.length === 0}
              onClick={() => payPlayers.mutate({ id: data.id })}
              className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
              data-testid="button-pay-players"
            >
              {payPlayers.isPending ? "PAYING..." : playersPaid ? "PLAYERS PAID" : "PAY PLAYERS"}
            </Button>
            <span className="text-muted-foreground text-xs">
              Pays €${data.playerPay.toLocaleString()} to each attending player and credits attendance.
            </span>
          </div>
          {payPlayersErr && <div className="text-destructive text-xs" data-testid="text-pay-players-error">{payPlayersErr}</div>}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Pay Actors / NPCs
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 font-mono text-sm">
          <p className="text-muted-foreground text-xs">
            Select assigned players who acted as NPCs and pay them a separate actor fee.
          </p>
          {data.assignments.length === 0 ? (
            <p className="text-muted-foreground italic">No assigned players to pay as actors.</p>
          ) : (
            <div className="space-y-2">
              {data.assignments.map((a) => (
                <label key={a.id} className="flex items-center gap-2 cursor-pointer" data-testid={`actor-pick-${a.userId}`}>
                  <input
                    type="checkbox"
                    checked={actorIds.includes(a.userId)}
                    onChange={() => toggleActor(a.userId)}
                  />
                  <span className="text-foreground">{a.characterName ?? a.userName ?? a.userId}</span>
                  {a.userName && a.characterName && (
                    <span className="text-muted-foreground text-xs">({a.userName})</span>
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs">ACTOR FEE €$</Label>
              <Input
                type="number"
                min={0}
                value={actorAmount || ""}
                onChange={(e) => setActorAmount(Number(e.target.value))}
                className="rounded-none w-40"
                data-testid="input-actor-amount"
              />
            </div>
            <Button
              type="button"
              disabled={payActors.isPending || actorIds.length === 0 || actorAmount <= 0}
              onClick={() =>
                payActors.mutate(
                  { id: data.id, data: { userIds: actorIds, amount: actorAmount } },
                  {
                    onSuccess: () => {
                      setActorIds([]);
                      setActorAmount(0);
                    },
                  },
                )
              }
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-pay-actors"
            >
              {payActors.isPending ? "PAYING..." : "PAY ACTORS"}
            </Button>
          </div>
          {payActorsErr && <div className="text-destructive text-xs" data-testid="text-pay-actors-error">{payActorsErr}</div>}
        </CardContent>
      </Card>

      {data.actorPayments.length > 0 && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
              Actor Payments ({data.actorPayments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border/40 font-mono text-sm">
              {data.actorPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2" data-testid={`row-actor-payment-${p.id}`}>
                  <span className="text-foreground">{p.characterName ?? p.userName ?? p.userId}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs uppercase">{p.source}</span>
                    <PaymentBadge status={p.paymentStatus} amount={p.amount} error={p.paymentError} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
