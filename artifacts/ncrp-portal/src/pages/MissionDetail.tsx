import { formatDate, formatEddies } from "@/lib/format";
import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMission,
  usePayMissionActors,
  useCompleteMission,
  useUncompleteMission,
  useSearchMissionActors,
  getSearchMissionActorsQueryKey,
  useSubmitMission,
  useApproveMission,
  usePostMission,
  useRevertMissionToDraft,
  useApplyToMission,
  useGetDefaultAvailability,
  useWithdrawApplication,
  useReviewApplication,
  useRemoveAssignedPlayer,
  useSignUpAsNpc,
  useWithdrawNpcSignup,
  useConfirmNpcSignup,
  useListActingForUser,
  getListActingForUserQueryKey,
  useListApplicantApplications,
  getListApplicantApplicationsQueryKey,
  type MissionApplicationListItem,
  useListMyCharacters,
  useListBreachPuzzles,
  getListBreachPuzzlesQueryKey,
  getGetMissionQueryKey,
  getListMissionsQueryKey,
  getListEventsQueryKey,
  useConvertMissionToEvent,
  useGetCharacter,
  getGetCharacterQueryKey,
  useGetCharacterInventory,
  getGetCharacterInventoryQueryKey,
  type Character,
  type InventoryItem,
  type ArchiveUser,
  type MissionDetail as MissionDetailModel,
  type MissionAssignmentView,
  type MissionApplicationView,
  type MissionNpcSignupView,
  type ActingEntry,
  type MissionToEventConvertInput,
  type MissionToEventConvertInputEventType,
} from "@workspace/api-client-react";
import { statusBadge as breachStatusBadge, difficultyBadge as breachDifficultyBadge } from "./breach/breachUtils";
import {
  AvailabilityGrid,
  buildDayColumns,
  expandPattern,
  patternFromInstants,
  type AvailabilitySlot,
} from "@/components/AvailabilityGrid";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  Search,
  X,
  Lock,
  Unlock,
  Cpu,
  PartyPopper,
  ChevronDown,
  ChevronUp,
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
import { NpcStateBadge, PaymentBadge } from "@/components/RosterBadges";
import { CloseApplicationsButton } from "@/components/CloseApplicationsButton";
import { TrialFixerBadge } from "@/components/TrialFixerBadge";
import DiscordThreadDrawer from "@/components/DiscordThreadDrawer";
import Markdown from "@/components/Markdown";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Request failed" : null);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

// datetime-local has no timezone; the value is treated as local time.
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CONVERT_EVENT_TYPE_OPTIONS: { value: MissionToEventConvertInputEventType; label: string }[] = [
  { value: "social", label: "Social" },
  { value: "session", label: "Main Session" },
  { value: "other", label: "Other" },
];

// Convert (replace) this mission into an event. The original mission is soft-
// cancelled and its linked Discord scheduled event is handed off to the new
// event row — no Discord teardown, no calendar duplicate.
function ConvertToEventDialog({ mission }: { mission: MissionDetailModel }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState<MissionToEventConvertInputEventType>("social");
  const [needsNpcs, setNeedsNpcs] = useState(false);
  const [npcBlurb, setNpcBlurb] = useState("");
  const [endAt, setEndAt] = useState("");

  const convert = useConvertMissionToEvent();
  const qc = useQueryClient();

  // Default the end time to the mission's start + duration so the staffer sees a
  // sensible window they can tweak.
  function openDialog() {
    if (mission.startAt) {
      const start = new Date(mission.startAt);
      if (!Number.isNaN(start.getTime())) {
        const end = new Date(start.getTime() + (mission.durationMinutes ?? 120) * 60000);
        setEndAt(toLocalInputValue(end.toISOString()));
      }
    }
    setOpen(true);
  }

  const noStart = !mission.startAt;
  const endBeforeStart =
    !!mission.startAt && !!endAt && new Date(endAt) <= new Date(mission.startAt);

  function submit() {
    if (noStart || endBeforeStart) return;
    const data: MissionToEventConvertInput = {
      eventType,
      needsNpcs,
      npcBlurb: needsNpcs ? npcBlurb.trim() || null : null,
      ...(endAt ? { endAt: new Date(endAt).toISOString() } : {}),
    };
    convert.mutate(
      { id: mission.id, data },
      {
        onSuccess: (ev) => {
          qc.invalidateQueries({ queryKey: getGetMissionQueryKey(mission.id) });
          qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
          qc.invalidateQueries({ queryKey: getListEventsQueryKey() });
          toast({ title: "Converted to event", description: `"${mission.title}" is now an event.` });
          setOpen(false);
          navigate(`/events/${ev.id}`);
        },
        onError: (e) => {
          toast({
            title: "Conversion failed",
            description: errOf(e) ?? "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={openDialog}
        className="rounded-none border-nc-magenta text-nc-magenta hover:bg-nc-magenta/10 font-display tracking-widest inline-flex items-center gap-1"
        data-testid="button-convert-to-event"
      >
        <PartyPopper className="w-4 h-4" /> CONVERT TO EVENT
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none border-border bg-card max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-magenta">Convert to Event</DialogTitle>
            <DialogDescription className="font-mono text-xs text-muted-foreground">
              This replaces the mission with an event. The mission is cancelled and its Discord scheduled event (if
              any) carries over — no duplicate on the calendar. This can't be undone automatically.
            </DialogDescription>
          </DialogHeader>

          {noStart ? (
            <p className="font-mono text-sm text-destructive" data-testid="text-convert-no-start">
              This mission has no start time. Set one before converting it to an event.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              <div>
                <Label className="text-xs">EVENT TYPE</Label>
                <select
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value as MissionToEventConvertInputEventType)}
                  className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
                  data-testid="select-convert-event-type"
                >
                  {CONVERT_EVENT_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs">END (date &amp; time, local)</Label>
                <Input
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  className="rounded-none"
                  data-testid="input-convert-end"
                />
                {endBeforeStart && (
                  <p className="text-destructive text-[10px] mt-1" data-testid="text-convert-end-before-start">
                    End must be after the mission start ({fmtDateTime(mission.startAt)}).
                  </p>
                )}
              </div>
              <div className="border border-border bg-background/40 p-3 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={needsNpcs}
                    onChange={(e) => setNeedsNpcs(e.target.checked)}
                    className="h-4 w-4 accent-nc-magenta"
                    data-testid="checkbox-convert-needs-npcs"
                  />
                  <span className="text-xs uppercase tracking-widest text-nc-magenta">Need NPCs for this event</span>
                </label>
                {needsNpcs && (
                  <Textarea
                    value={npcBlurb}
                    onChange={(e) => setNpcBlurb(e.target.value)}
                    rows={2}
                    className="rounded-none"
                    placeholder="What kind of NPCs you need, the vibe, any requirements…"
                    data-testid="input-convert-npc-blurb"
                  />
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="rounded-none"
              data-testid="button-convert-cancel"
            >
              CANCEL
            </Button>
            <Button
              type="button"
              disabled={convert.isPending || noStart || endBeforeStart}
              onClick={submit}
              className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
              data-testid="button-convert-confirm"
            >
              {convert.isPending ? "CONVERTING..." : "CONVERT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function MissionDetail() {
  const { id } = useParams();
  const missionId = Number(id);
  const { data, isLoading, error } = useGetMission(missionId, {
    query: { enabled: Number.isInteger(missionId), queryKey: getGetMissionQueryKey(missionId) },
  });

  if (isLoading) {
    return <div className="max-w-7xl mx-auto font-mono text-nc-cyan animate-pulse">Loading mission...</div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-7xl mx-auto space-y-4">
        <Link href="/missions" className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> back to missions
        </Link>
        <div className="font-mono text-destructive">Mission not found or you don't have access.</div>
      </div>
    );
  }

  const when = data.startAt ? new Date(data.startAt) : null;

  return <MissionDetailView data={data} when={when} />;
}

function MissionDetailView({ data: rawData, when }: { data: MissionDetailModel; when: Date | null }) {
  const qc = useQueryClient();
  const invalidateMission = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const complete = useCompleteMission({ mutation: { onSuccess: invalidateMission } });
  const uncomplete = useUncompleteMission({ mutation: { onSuccess: invalidateMission } });
  const completionBusy = complete.isPending || uncomplete.isPending;
  const completionErr = errOf(complete.error) ?? errOf(uncomplete.error);
  // `data.canManage` is now true for a trial fixer managing their OWN approved
  // mission (roster / post / pay). Convert-to-event and the cs-approver thread
  // drawer hit full-manager/reviewer-only endpoints, so gate THOSE on the real
  // role to avoid showing trial owners a button that just 403s.
  //
  // The server computes the staff capability flags (canManage/canEdit/...) from
  // the REAL account, so they stay true while an admin is using "View as <role>"
  // (which only downgrades client-side flags in useEffectiveMe). Downgrade them
  // here too when previewing as a role that wouldn't manage this mission, so the
  // preview shows what that role actually sees. Only admins can preview, so a
  // real manager's canManage came from isManager — the "fixer" preview keeps it,
  // while player/new_user/ripperdoc drop it.
  const { data: me, viewAs } = useEffectiveMe();
  const isFullManager = !!(me?.isFixer || me?.isAdmin);
  const suppressStaff = !!viewAs && !isFullManager;
  const data: MissionDetailModel = suppressStaff
    ? {
        ...rawData,
        canManage: false,
        canEdit: false,
        canComplete: false,
        canUncomplete: false,
        canApprove: false,
        fixerNotes: null,
      }
    : rawData;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
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
          <img src={data.imageUrl} alt={data.title} className="w-full max-h-72 object-contain" />
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
          {data.visibility === "private" && (
            <Badge
              variant="outline"
              className="rounded-none font-bold tracking-widest uppercase border-nc-magenta text-nc-magenta inline-flex items-center gap-1"
              data-testid="badge-private"
            >
              <Lock className="w-3 h-3" /> Private
            </Badge>
          )}
          {data.completedAt && (
            <Badge
              variant="outline"
              className="rounded-none font-bold tracking-widest uppercase border-nc-magenta text-nc-magenta inline-flex items-center gap-1"
              data-testid="badge-completed"
            >
              <Lock className="w-3 h-3" /> Completed
            </Badge>
          )}
          <Badge variant="outline" className={`rounded-none font-bold tracking-widest uppercase ${missionTierClass(data.tier)}`}>
            {missionTierLabel(data.tier)}
          </Badge>
          {data.jobType && (
            <Badge variant="outline" className="rounded-none font-bold tracking-widest uppercase border-border text-muted-foreground">
              {jobTypeLabel(data.jobType)}
            </Badge>
          )}
          <span className="text-nc-yellow font-mono text-xs uppercase tracking-widest">
            Player pay {formatEddies(data.playerPay)}
          </span>
        </div>
      </div>

      {(data.canComplete || data.canUncomplete || data.completedAt || data.canManage || data.canEdit) && (
        <div className="flex flex-wrap items-center gap-3 border border-border bg-card/40 p-3">
          {data.canEdit && (
            <Link
              href={`/fixer/missions?edit=${data.id}`}
              className="rounded-none border border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display tracking-widest inline-flex items-center gap-1 px-4 py-2 text-sm"
              data-testid="button-edit-mission"
            >
              <Pencil className="w-4 h-4" /> EDIT MISSION
            </Link>
          )}
          {isFullManager && data.status !== "cancelled" && <ConvertToEventDialog mission={data} />}
          {isFullManager && (
            <DiscordThreadDrawer subjectType="mission" subjectId={data.id} buttonLabel="FIXER COMMUNICATION" />
          )}
          {data.completedAt && (
            <span
              className="font-mono text-xs text-muted-foreground inline-flex items-center gap-1"
              data-testid="text-completed-meta"
            >
              <Lock className="w-3.5 h-3.5 text-nc-magenta shrink-0" />
              Completed{data.completedByName ? ` by ${data.completedByName}` : ""} · {fmtDateTime(data.completedAt)} — actor
              payments are locked.
            </span>
          )}
          {data.canComplete && (
            <Button
              type="button"
              disabled={completionBusy}
              onClick={() => {
                if (
                  window.confirm(
                    "Mark this mission as completed? This locks actor payments. You can reopen it later if needed.",
                  )
                ) {
                  complete.mutate({ id: data.id });
                }
              }}
              className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
              data-testid="button-complete-mission"
            >
              <Lock className="w-4 h-4 mr-1" /> {complete.isPending ? "MARKING..." : "MARK COMPLETED"}
            </Button>
          )}
          {data.canUncomplete && (
            <Button
              type="button"
              variant="outline"
              disabled={completionBusy}
              onClick={() => uncomplete.mutate({ id: data.id })}
              className="rounded-none border-border font-display tracking-widest"
              data-testid="button-uncomplete-mission"
            >
              <Unlock className="w-4 h-4 mr-1" /> {uncomplete.isPending ? "REOPENING..." : "REOPEN MISSION"}
            </Button>
          )}
          {completionErr && (
            <span className="text-destructive text-xs" data-testid="text-completion-error">
              {completionErr}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-sm">
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <CalendarDays className="w-4 h-4 shrink-0" />
          {when ? (
            <span>
              {formatDate(when)} {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {data.durationMinutes ? ` · ${data.durationMinutes}m` : ""}
              {data.npcStartAt && (
                <span className="block text-nc-yellow text-xs" data-testid="text-mission-npc-gather">
                  NPC gather:{" "}
                  {new Date(data.npcStartAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
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
            <TabsTrigger value="actors" className="rounded-none font-display tracking-widest" data-testid="tab-actors">
              ACTORS
            </TabsTrigger>
            <TabsTrigger value="fixer" className="rounded-none font-display tracking-widest" data-testid="tab-fixer">
              FIXER
            </TabsTrigger>
          </TabsList>
          <TabsContent value="player" className="mt-4 space-y-6">
            <PlayerView data={data} />
          </TabsContent>
          <TabsContent value="actors" className="mt-4 space-y-6">
            <ActorsView data={data} />
          </TabsContent>
          <TabsContent value="fixer" className="mt-4 space-y-6">
            <FixerView data={data} />
          </TabsContent>
        </Tabs>
      ) : (
        <>
          {(data.canApprove || data.canEdit) && <WorkflowPanel data={data} />}
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
            <Markdown className="font-mono text-sm text-foreground">{data.description}</Markdown>
          </CardContent>
        </Card>
      )}

      <MissionFacts data={data} />

      {/* Staff-only world/join link (visible to managers + the trial fixer who owns it) */}
      {data.canEdit && data.worldLink && (
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

      {/* Apply — available to anyone, including staff who also play. ApplySection
          self-hides unless the mission is open or the viewer already has an
          application, so it only appears where applying actually makes sense. */}
      <ApplySection data={data} />

      {/* NPC sign-up — players can volunteer to act as an NPC on missions that
          aren't completed yet. Self-hides unless sign-ups are open or the viewer
          already signed up. */}
      <NpcSignupSection data={data} />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Fixer</CardTitle>
        </CardHeader>
        <CardContent>
          {data.fixerId ? (
            <Link
              href={`/fixers/${data.fixerId}`}
              className="flex items-center gap-3 group"
              data-testid="block-fixer"
            >
              <Avatar className="border border-nc-magenta/30 rounded-none w-12 h-12">
                <AvatarImage src={data.fixerAvatarUrl ?? undefined} />
                <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display">
                  {(data.fixerName ?? "??").substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-foreground group-hover:text-nc-magenta group-hover:underline">
                    {data.fixerName ?? "(unknown fixer)"}
                  </span>
                  <TrialFixerBadge show={data.fixerIsTrial} testId="badge-fixer-trial" />
                </div>
                <div className="text-xs font-mono text-muted-foreground">Fixer running this job — view their missions</div>
              </div>
            </Link>
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
                  <AssignmentRow a={a} missionId={data.id} canManage={data.canManage} />
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
  const [slots, setSlots] = useState<string[]>([]);
  const [makeDefault, setMakeDefault] = useState(false);

  const existing = data.myApplication;

  // Pre-fill the availability picker once: prefer the player's own picks from a
  // withdrawn application they're re-submitting, otherwise their saved weekly
  // default. Both are re-projected onto the current rolling window via the
  // local weekly pattern so stale (now-past) instants don't carry over.
  const days = useMemo(() => buildDayColumns(), []);
  const def = useGetDefaultAvailability();
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    let pattern: AvailabilitySlot[] | null = null;
    if (existing?.availability && existing.availability.length > 0) {
      // Use the player's saved DATE-SPECIFIC picks verbatim when they still
      // fall inside the visible window. Collapsing them to a weekly pattern
      // and re-expanding would repaint days they deliberately cleared (e.g.
      // clearing THIS Friday while next Friday stays painted made refresh
      // "undo" the change). Only a fully-stale set (all instants in the past,
      // i.e. a re-apply on a withdrawn application) re-projects via the
      // weekly pattern.
      const windowStart = days[0].getTime();
      const windowEnd = days[days.length - 1].getTime() + 24 * 60 * 60 * 1000;
      const inWindow = existing.availability.filter((iso) => {
        const t = Date.parse(iso);
        return !Number.isNaN(t) && t >= windowStart && t < windowEnd;
      });
      if (inWindow.length > 0) {
        setSlots(inWindow);
        prefilled.current = true;
        return;
      }
      pattern = patternFromInstants(existing.availability);
    } else if (def.data && def.data.pattern.length > 0) {
      pattern = def.data.pattern;
    } else if (!def.isLoading && def.isFetched) {
      prefilled.current = true;
      return;
    }
    if (pattern) {
      setSlots(expandPattern(pattern, days));
      prefilled.current = true;
    }
  }, [def.data, def.isLoading, def.isFetched, existing, days]);
  const applyErr = errOf(apply.error) ?? errOf(withdraw.error);
  // Applications are only accepted on missions that are publicly posted AND
  // still Open for play (server enforces the same rule).
  const open = data.workflowState === "posted" && data.status === "open";
  // A player on the mission (pending applicant OR accepted onto the roster) can
  // keep updating their availability for any UPCOMING mission — not just while
  // intake is open — so the fixer always has their latest times to schedule
  // around. Editing an accepted application preserves the roster spot server-side.
  const canEditAvailability =
    data.workflowState === "posted" && data.status !== "cancelled" && !data.completedAt;

  // Always echo an existing (non-withdrawn) application back to the player so the
  // accepted/declined outcome stays visible even after the mission closes — this
  // closes the loop in-portal regardless of Discord DM delivery.
  if (existing && existing.status !== "withdrawn") {
    const reviewed = existing.status === "accepted" || existing.status === "rejected";
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
          {reviewed && (
            <p className="text-muted-foreground" data-testid="text-application-outcome">
              {existing.status === "accepted"
                ? "You're in — the fixer accepted this character. Check the Players list below for the line-up."
                : "The fixer passed on this application this time. Keep an eye on the board for other jobs."}
            </p>
          )}
          {existing.comment && <p className="text-muted-foreground whitespace-pre-wrap">{existing.comment}</p>}
          {(existing.status === "pending" || existing.status === "accepted") && canEditAvailability && (
            <div className="space-y-2 border-t border-border/50 pt-3">
              <Label className="text-xs">YOUR AVAILABILITY (required)</Label>
              {existing.status === "accepted" && (
                <p className="text-[11px] text-muted-foreground">
                  You're on the roster — update your availability any time before the mission and you'll stay accepted.
                </p>
              )}
              <AvailabilityGrid mode="edit" value={slots} onChange={setSlots} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={makeDefault}
                  onCheckedChange={(v) => setMakeDefault(v === true)}
                  className="rounded-none"
                  data-testid="checkbox-make-default-availability"
                />
                Make this my default availability
              </label>
              <Button
                type="button"
                size="sm"
                disabled={apply.isPending || slots.length === 0}
                onClick={() =>
                  apply.mutate({
                    id: data.id,
                    data: {
                      characterId: existing.characterId,
                      comment: existing.comment ?? null,
                      availability: slots,
                      makeDefault,
                      defaultPattern: makeDefault ? patternFromInstants(slots) : undefined,
                      timezone: makeDefault ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
                    },
                  })
                }
                className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                data-testid="button-save-availability"
              >
                {apply.isPending ? "SAVING..." : "SAVE AVAILABILITY"}
              </Button>
            </div>
          )}
          {existing.status === "pending" && open && (
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

  // No active application: only offer the apply form when the mission is open.
  if (!open) return null;

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
        <div className="space-y-2">
          <Label className="text-xs">YOUR AVAILABILITY (required)</Label>
          <AvailabilityGrid mode="edit" value={slots} onChange={setSlots} />
          {slots.length === 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="text-availability-required">
              Pick at least one time slot so the fixer knows when you can run.
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox
              checked={makeDefault}
              onCheckedChange={(v) => setMakeDefault(v === true)}
              className="rounded-none"
              data-testid="checkbox-make-default-availability"
            />
            Make this my default availability
          </label>
        </div>
        <Button
          type="button"
          disabled={apply.isPending || characterId === "" || slots.length === 0}
          onClick={() =>
            apply.mutate(
              {
                id: data.id,
                data: {
                  characterId: Number(characterId),
                  comment: comment || null,
                  availability: slots,
                  makeDefault,
                  defaultPattern: makeDefault ? patternFromInstants(slots) : undefined,
                  timezone: makeDefault ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
                },
              },
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

function NpcSignupSection({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const chars = useListMyCharacters();
  const signUp = useSignUpAsNpc({ mutation: { onSuccess: invalidate } });
  const withdraw = useWithdrawNpcSignup({ mutation: { onSuccess: invalidate } });

  const [characterId, setCharacterId] = useState<number | "">("");

  const mine = data.mySignup;
  const err = errOf(signUp.error) ?? errOf(withdraw.error);

  // Echo an existing sign-up back to the player so they see whether the fixer
  // confirmed attendance (and got paid) or marked them a no-show.
  if (mine) {
    const resolved = mine.state === "attended" || mine.state === "no_show";
    return (
      <Card className="rounded-none border-border bg-card/50" data-testid="block-my-npc-signup">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Your NPC Sign-up
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 font-mono text-sm">
          <div className="flex items-center gap-2">
            <NpcStateBadge state={mine.state} />
            {mine.characterName && <span className="text-foreground">{mine.characterName}</span>}
          </div>
          {mine.state === "attended" && (
            <div className="flex items-center gap-2" data-testid="text-npc-signup-paid">
              <PaymentBadge status={mine.paymentStatus} amount={mine.payAmount} error={null} />
            </div>
          )}
          {mine.state === "no_show" && (
            <p className="text-muted-foreground" data-testid="text-npc-signup-noshow">
              The fixer marked this sign-up as a no-show — no payout for this one.
            </p>
          )}
          {!resolved && data.npcSignupOpen && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate({ id: data.id })}
              className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
              data-testid="button-withdraw-npc"
            >
              {withdraw.isPending ? "WITHDRAWING..." : "WITHDRAW SIGN-UP"}
            </Button>
          )}
          {err && <div className="text-destructive text-xs" data-testid="text-npc-signup-error">{err}</div>}
        </CardContent>
      </Card>
    );
  }

  // No active sign-up: only offer the form when sign-ups are open.
  if (!data.npcSignupOpen) return null;

  return (
    <Card className="rounded-none border-border bg-nc-magenta/5 border-nc-magenta/40" data-testid="block-npc-signup">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-nc-magenta">
          Sign Up as an NPC
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <p className="text-muted-foreground text-xs">
          Volunteer to play an NPC on this job. The fixer confirms attendance afterwards
          {(data.npcPayAmount ?? 0) > 0 ? ` and pays ${formatEddies(data.npcPayAmount ?? 0)}.` : "."}
        </p>
        <div>
          <Label className="text-xs">CHARACTER (optional)</Label>
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value ? Number(e.target.value) : "")}
            className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
            data-testid="select-npc-character"
          >
            <option value="">NPC as no specific character…</option>
            {(chars.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          disabled={signUp.isPending}
          onClick={() =>
            signUp.mutate(
              { id: data.id, data: { characterId: characterId === "" ? null : Number(characterId) } },
              { onSuccess: () => setCharacterId("") },
            )
          }
          className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
          data-testid="button-signup-npc"
        >
          {signUp.isPending ? "SIGNING UP..." : "SIGN UP AS NPC"}
        </Button>
        {err && <div className="text-destructive text-xs" data-testid="text-npc-signup-error">{err}</div>}
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

/**
 * Fixer-only per-applicant lookup: click an applicant to see every mission
 * they've applied to and how each application stands (pending / accepted /
 * rejected / withdrawn). Fetches only while the dialog is open.
 */
function ApplicantApplicationsDialog({
  userId,
  displayName,
  open,
  onOpenChange,
}: {
  userId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apps = useListApplicantApplications(userId, {
    query: { enabled: open, queryKey: getListApplicantApplicationsQueryKey(userId) },
  });
  const rows: MissionApplicationListItem[] = apps.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-applicant-applications">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan uppercase">
            Applications — {displayName}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Pending applications to upcoming missions, newest first.
          </DialogDescription>
        </DialogHeader>
        {apps.isLoading ? (
          <p className="font-mono text-sm text-muted-foreground">Loading…</p>
        ) : apps.isError ? (
          <p className="font-mono text-sm text-destructive">Failed to load applications.</p>
        ) : rows.length === 0 ? (
          <p className="font-mono text-sm text-muted-foreground italic" data-testid="text-applicant-apps-empty">
            No pending applications to upcoming missions.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="border border-border bg-background/40 p-2 flex items-start gap-2 flex-wrap"
                data-testid={`row-applicant-app-${r.id}`}
              >
                <ApplicationStatusBadge status={r.status} />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <Link
                    href={`/missions/${r.missionId}`}
                    className="font-display text-sm text-foreground hover:text-nc-cyan transition-colors break-words"
                    onClick={() => onOpenChange(false)}
                  >
                    {r.missionTitle}
                  </Link>
                  <div className="text-[11px] text-muted-foreground font-mono">
                    {r.characterName && <span>as {r.characterName} · </span>}
                    <span className={missionStatusClass(r.missionStatus)}>
                      Mission: {missionStatusLabel(r.missionStatus)}
                    </span>
                    {r.missionStartAt && <span> · {formatDate(new Date(r.missionStartAt))}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignmentRow({
  a,
  missionId,
  canManage,
}: {
  a: MissionAssignmentView;
  missionId: number;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const remove = useRemoveAssignedPlayer({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMissionQueryKey(missionId) });
        toast({ title: "Player removed from mission" });
      },
      onError: (err) =>
        toast({
          title: "Couldn't remove player",
          description: errOf(err) ?? "Please try again.",
          variant: "destructive",
        }),
    },
  });
  const onRemove = () => {
    const who = a.characterName ?? a.userName ?? "this player";
    if (
      !window.confirm(
        `Remove ${who} from this mission? Their attendance and slot for this mission will be reverted.`,
      )
    )
      return;
    remove.mutate({ id: missionId, userId: a.userId });
  };
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
      <div className="text-right space-y-1 flex flex-col items-end">
        <ParticipationBadge status={a.participationStatus} />
        {a.attendanceCreditedAt && (
          <div className="text-[10px] font-mono text-green-400 inline-flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Attended
          </div>
        )}
        <PaymentBadge status={a.paymentStatus} amount={a.payAmount} error={a.paymentError} />
      </div>
    </div>
  );
  const linked = a.characterId ? (
    <Link href={`/directory/characters/${a.characterId}`} className="block hover:bg-card/80 transition px-2 -mx-2">
      {inner}
    </Link>
  ) : (
    <div className="px-2 -mx-2">{inner}</div>
  );
  if (!canManage) return linked;
  return (
    <div className="flex items-center gap-1">
      <div className="flex-1 min-w-0">{linked}</div>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-none text-destructive hover:bg-destructive/10 shrink-0"
        disabled={remove.isPending}
        onClick={onRemove}
        title="Remove player from mission"
        data-testid={`button-remove-assignment-${a.id}`}
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
}

// Shows whether an assigned player has confirmed their invite, so a fixer can
// see at a glance who is definitely coming. Renders nothing when there's no
// confirmation request (e.g. a fixer self-assigned their own character).
function ParticipationBadge({ status }: { status?: string | null }) {
  if (status === "accepted") {
    return (
      <Badge
        variant="outline"
        className="rounded-none text-[10px] border-green-500 text-green-400 bg-green-500/10 inline-flex items-center gap-1"
        data-testid="badge-participation-accepted"
      >
        <CheckCircle2 className="w-3 h-3" /> Accepted
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge
        variant="outline"
        className="rounded-none text-[10px] border-nc-yellow text-nc-yellow bg-nc-yellow/10 inline-flex items-center gap-1"
        data-testid="badge-participation-pending"
      >
        <Clock className="w-3 h-3" /> Awaiting reply
      </Badge>
    );
  }
  return null;
}

function WorkflowPanel({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const submit = useSubmitMission({ mutation: { onSuccess: invalidate } });
  const approve = useApproveMission({ mutation: { onSuccess: invalidate } });
  const post = usePostMission({ mutation: { onSuccess: invalidate } });
  const revert = useRevertMissionToDraft({ mutation: { onSuccess: invalidate } });
  const [confirmRevert, setConfirmRevert] = useState(false);
  const busy = submit.isPending || approve.isPending || post.isPending || revert.isPending;
  const err =
    errOf(submit.error) ?? errOf(approve.error) ?? errOf(post.error) ?? errOf(revert.error);
  // "Return to draft" pulls an approved/posted mission back for rework. Not
  // offered once the mission is completed or cancelled — those are history.
  const canRevert =
    data.canManage &&
    (data.workflowState === "posted" || data.workflowState === "approved") &&
    data.status !== "cancelled" &&
    !data.completedAt;

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
            (data.canEdit ? (
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
            <>
              <span className="text-green-400 text-xs inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Live on the public board.
              </span>
              {data.canManage && (
                <CloseApplicationsButton
                  missionId={data.id}
                  status={data.status}
                  onSuccess={invalidate}
                />
              )}
            </>
          )}
          {canRevert &&
            (confirmRevert ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="text-nc-yellow text-xs">
                  Pull this mission off the board? It returns to draft and must be re-approved.
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    revert.mutate(
                      { id: data.id },
                      { onSettled: () => setConfirmRevert(false) },
                    )
                  }
                  className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display tracking-widest"
                  data-testid="button-revert-to-draft-confirm"
                >
                  {revert.isPending ? "RETURNING..." : "CONFIRM"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmRevert(false)}
                  className="rounded-none font-display tracking-widest"
                  data-testid="button-revert-to-draft-cancel"
                >
                  CANCEL
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmRevert(true)}
                className="rounded-none font-display tracking-widest"
                data-testid="button-revert-to-draft"
              >
                RETURN TO DRAFT
              </Button>
            ))}
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

  // Availability overlap heatmap: every applicant still in the running (not
  // withdrawn/rejected) who supplied availability. Each cell counts how many of
  // them are free; the fixer can eyeball the densest blocks to schedule the run.
  const availApplicants = data.applications
    .filter((a) => a.status !== "withdrawn" && a.status !== "rejected" && (a.availability?.length ?? 0) > 0)
    .map((a) => ({
      name: a.characterName ?? a.userName ?? "(unknown)",
      slots: a.availability ?? [],
    }));

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Applications ({data.applications.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        {availApplicants.length > 0 && (
          <div className="space-y-2 border border-border/60 bg-background/30 p-3" data-testid="availability-overlap">
            <div className="font-display tracking-widest text-[11px] uppercase text-muted-foreground">
              Availability Overlap
            </div>
            <AvailabilityGrid mode="heatmap" heatmap={availApplicants} />
          </div>
        )}
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
                  <div key={a.id} className="flex items-center gap-2 flex-wrap" data-testid={`row-application-${a.id}`}>
                    <ApplicationStatusBadge status={a.status} />
                    <DecidedApplicantName a={a} />
                    {a.userName && <span className="text-muted-foreground text-xs">({a.userName})</span>}
                    {a.status === "accepted" && a.onRoster === false && (
                      // Desync repair: the application was accepted but its
                      // roster row is gone (e.g. clobbered by a stale roster
                      // edit). Accept is idempotent server-side, so re-running
                      // it recreates the assignment.
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: data.id, appId: a.id, data: { action: "accept" } })}
                        className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display tracking-widest text-[11px] h-6 px-2"
                        data-testid={`button-restore-${a.id}`}
                      >
                        RESTORE TO ROSTER
                      </Button>
                    )}
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

// Decided-applicant name: click to open the same per-applicant application
// history dialog fixers get on pending rows.
function DecidedApplicantName({ a }: { a: MissionApplicationView }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setHistoryOpen(true)}
        className="text-foreground hover:text-nc-cyan underline decoration-dotted underline-offset-2 transition-colors"
        data-testid={`button-applicant-history-${a.id}`}
      >
        {a.characterName ?? "(character)"}
      </button>
      <ApplicantApplicationsDialog
        userId={a.userId}
        displayName={a.userName ?? a.characterName ?? "Player"}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
    </>
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
  const [historyOpen, setHistoryOpen] = useState(false);
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
          {a.upcomingAcceptedMissionId != null && (
            <div className="text-[11px] text-nc-cyan flex items-center gap-1 mt-1" data-testid={`upcoming-accepted-${a.id}`}>
              <CalendarDays className="w-3 h-3 shrink-0" />
              <span>
                Accepted to upcoming mission:{" "}
                <Link
                  href={`/missions/${a.upcomingAcceptedMissionId}`}
                  className="underline hover:text-foreground transition-colors"
                >
                  {a.upcomingAcceptedMissionTitle ?? `#${a.upcomingAcceptedMissionId}`}
                </Link>
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="text-[11px] text-muted-foreground underline hover:text-nc-cyan transition-colors mt-1 block"
            data-testid={`button-applicant-history-${a.id}`}
          >
            View pending applications
          </button>
          <ApplicantApplicationsDialog
            userId={a.userId}
            displayName={a.userName ?? a.characterName ?? "Player"}
            open={historyOpen}
            onOpenChange={setHistoryOpen}
          />
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

// ---------------------------------------------------------------------------
// Squad Intel: at-a-glance character loadouts (cyberware / weapons / gear) plus
// a short "who is this" summary for everyone the fixer is considering — roster
// members first, then still-pending applicants. Renders only inside the FIXER
// tab, and the character/inventory endpoints it hits are owner-or-staff gated
// server-side.

function SquadIntelPanel({ data }: { data: MissionDetailModel }) {
  const rosterCharIds = new Set(data.assignments.map((a) => a.characterId).filter((id): id is number => id != null));
  const roster = data.assignments.filter((a) => a.characterId != null);
  // Pending applicants not already on the roster with the same character.
  const pendingApps = data.applications.filter(
    (a) => a.status === "pending" && a.characterId != null && !rosterCharIds.has(a.characterId),
  );
  if (roster.length === 0 && pendingApps.length === 0) return null;
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="panel-squad-intel">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Squad Intel
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 font-mono text-sm">
        <p className="text-muted-foreground text-xs">
          Expand a character to review their cyberware, weapons, and gear before the run.
        </p>
        {roster.map((a) => (
          <CharacterIntelRow
            key={`roster-${a.id}`}
            characterId={a.characterId!}
            name={a.characterName ?? "(character)"}
            userName={a.userName ?? null}
            portraitUrl={a.characterPortraitUrl ?? a.userAvatarUrl ?? null}
            tag="ROSTER"
            tagClass="border-green-600/60 text-green-500"
          />
        ))}
        {pendingApps.map((a) => (
          <CharacterIntelRow
            key={`app-${a.id}`}
            characterId={a.characterId!}
            name={a.characterName ?? "(character)"}
            userName={a.userName ?? null}
            portraitUrl={a.characterPortraitUrl ?? a.userAvatarUrl ?? null}
            tag="APPLICANT"
            tagClass="border-nc-yellow/60 text-nc-yellow"
          />
        ))}
      </CardContent>
    </Card>
  );
}

function CharacterIntelRow({
  characterId,
  name,
  userName,
  portraitUrl,
  tag,
  tagClass,
}: {
  characterId: number;
  name: string;
  userName: string | null;
  portraitUrl: string | null;
  tag: string;
  tagClass: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border/60 bg-background/30" data-testid={`intel-row-${characterId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 p-2 text-left hover:bg-background/60 transition-colors"
        data-testid={`button-intel-toggle-${characterId}`}
      >
        <Avatar className="border border-nc-cyan/30 rounded-none w-8 h-8">
          <AvatarImage src={portraitUrl ?? undefined} />
          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-[10px]">
            {name.substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <span className="font-display text-foreground">{name}</span>
          {userName && <span className="text-xs text-muted-foreground ml-2">({userName})</span>}
        </div>
        <Badge variant="outline" className={`rounded-none font-display tracking-widest text-[10px] ${tagClass}`}>
          {tag}
        </Badge>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && <CharacterIntelBody characterId={characterId} />}
    </div>
  );
}

/** Parse the per-unit CWP cost stamped into cyberware notes ("CWP 3 ..."). */
function cwpFromNotes(notes: string | null | undefined): number | null {
  const m = /(?:^|\b)CWP\s+(\d+)/i.exec(notes ?? "");
  return m ? parseInt(m[1], 10) : null;
}

const WEAPON_CATEGORIES = new Set(["gun", "weapon", "blade"]);

function CharacterIntelBody({ characterId }: { characterId: number }) {
  const charQ = useGetCharacter(characterId, {
    query: { queryKey: getGetCharacterQueryKey(characterId) },
  });
  const invQ = useGetCharacterInventory(characterId, {
    query: { queryKey: getGetCharacterInventoryQueryKey(characterId) },
  });

  if (charQ.isLoading || invQ.isLoading) {
    return <div className="p-3 text-xs text-muted-foreground italic border-t border-border/40">Loading dossier…</div>;
  }
  if (charQ.isError || invQ.isError) {
    return (
      <div className="p-3 text-xs text-destructive border-t border-border/40" data-testid={`intel-error-${characterId}`}>
        Could not load this character&apos;s dossier.
      </div>
    );
  }
  const c = charQ.data as Character | undefined;
  const items = (invQ.data ?? []) as InventoryItem[];
  if (!c) return null;

  const catOf = (i: InventoryItem) => (i.category ?? "").trim().toLowerCase();
  const cyberware = items.filter((i) => catOf(i) === "cyberware");
  const weapons = items.filter((i) => WEAPON_CATEGORIES.has(catOf(i)));
  const gear = items.filter((i) => catOf(i) !== "cyberware" && !WEAPON_CATEGORIES.has(catOf(i)));
  const totalCwp = cyberware.reduce((sum, i) => sum + (cwpFromNotes(i.notes) ?? 0) * (i.quantity || 1), 0);

  const sheet = (c.sheetData ?? null) as Record<string, unknown> | null;
  const sheetStr = (k: string) => {
    const v = sheet?.[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const affiliation = sheetStr("knownAffiliation");
  const skills = sheetStr("skills");
  const psych = sheetStr("psychProfile");
  // Strip internal [legacy:<uuid>] anchors stamped by the prod importer.
  const bgClean = (c.background ?? "").replace(/\[legacy:[^\]]+\]/g, "").trim();
  const summary = psych ?? (bgClean || null);
  const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

  return (
    <div className="p-3 space-y-3 border-t border-border/40" data-testid={`intel-body-${characterId}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {c.archetype && (
          <Badge variant="outline" className="rounded-none border-nc-cyan/50 text-nc-cyan font-display tracking-widest text-[10px]">
            {c.archetype}
          </Badge>
        )}
        {c.lifeStatus && c.lifeStatus !== "active" && (
          <Badge variant="outline" className="rounded-none border-destructive/60 text-destructive font-display tracking-widest text-[10px] uppercase">
            {c.lifeStatus}
          </Badge>
        )}
        {affiliation && <span className="text-muted-foreground">Affiliation: <span className="text-foreground">{clamp(affiliation, 120)}</span></span>}
      </div>

      {summary && (
        <p className="text-xs text-muted-foreground whitespace-pre-wrap" data-testid={`intel-summary-${characterId}`}>
          {clamp(summary, 400)}
        </p>
      )}

      {skills && (
        <div className="text-xs">
          <span className="font-display tracking-widest text-[10px] uppercase text-muted-foreground">Skills</span>
          <p className="text-foreground whitespace-pre-wrap mt-0.5">{clamp(skills, 250)}</p>
        </div>
      )}

      <IntelItemList
        title={`Cyberware (${cyberware.length}${totalCwp > 0 ? ` · ${totalCwp} CWP` : ""})`}
        items={cyberware}
        empty="No cyberware on record."
        accent="text-nc-cyan"
        renderExtra={(i) => {
          const cwp = cwpFromNotes(i.notes);
          return cwp != null ? <span className="text-muted-foreground"> · CWP {cwp}</span> : null;
        }}
        testId={`intel-cyberware-${characterId}`}
      />
      <IntelItemList
        title={`Weapons (${weapons.length})`}
        items={weapons}
        empty="No weapons on record."
        accent="text-nc-magenta"
        renderExtra={(i) =>
          i.cyberwareReq ? <span className="text-muted-foreground"> · requires {i.cyberwareReq}</span> : null
        }
        testId={`intel-weapons-${characterId}`}
      />
      <IntelItemList
        title={`Gear & Other (${gear.length})`}
        items={gear}
        empty="No other gear on record."
        accent="text-nc-yellow"
        testId={`intel-gear-${characterId}`}
      />

      <Link
        href={`/directory/characters/${characterId}`}
        className="inline-flex items-center gap-1 text-xs text-nc-cyan hover:underline font-display tracking-widest"
        data-testid={`link-intel-sheet-${characterId}`}
      >
        VIEW FULL SHEET <ExternalLink className="w-3 h-3" />
      </Link>
    </div>
  );
}

function IntelItemList({
  title,
  items,
  empty,
  accent,
  renderExtra,
  testId,
}: {
  title: string;
  items: InventoryItem[];
  empty: string;
  accent: string;
  renderExtra?: (i: InventoryItem) => ReactNode;
  testId: string;
}) {
  return (
    <div className="text-xs" data-testid={testId}>
      <span className={`font-display tracking-widest text-[10px] uppercase ${accent}`}>{title}</span>
      {items.length === 0 ? (
        <p className="text-muted-foreground italic mt-0.5">{empty}</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {items.map((i) => (
            <li key={i.id} className="text-foreground">
              {i.name}
              {i.quantity > 1 && <span className="text-muted-foreground"> ×{i.quantity}</span>}
              {renderExtra?.(i)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FixerView({ data }: { data: MissionDetailModel }) {
  // Trial fixers may fully manage their OWN approved missions (roster / post /
  // pay), but the cross-player acting lookup and breach control are
  // full-manager-only tools, so hide them for the trial tier. The server still
  // enforces this — these panels just avoid showing dead UI / 403s.
  const { data: me } = useAuthMe();
  const isFullManager = !!(me?.isFixer || me?.isAdmin);
  return (
    <>
      {data.discordSyncError && (
        <div className="border border-destructive bg-destructive/10 text-destructive font-mono text-xs p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Discord event sync error: {data.discordSyncError}</span>
        </div>
      )}

      {data.fixerNotes && (
        <Card className="rounded-none border-nc-magenta/40 bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
              Fixer-Only Information <span className="text-nc-magenta normal-case">(staff only)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm text-foreground whitespace-pre-wrap" data-testid="text-mission-fixer-notes">
              {data.fixerNotes}
            </p>
          </CardContent>
        </Card>
      )}

      <WorkflowPanel data={data} />

      <ApplicationsPanel data={data} />

      <SquadIntelPanel data={data} />

      {isFullManager && <PlayerActingLookup />}

      {isFullManager && <BreachesPanel missionId={data.id} />}
    </>
  );
}

// Staff-only: look up any player's full acting history (mission + NPC + event +
// legacy payouts) to gauge how often they've been used as an NPC/actor.
function PlayerActingLookup() {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<ArchiveUser | null>(null);

  const searchParams = { q: search || undefined };
  const { data: results, isFetching: searching } = useSearchMissionActors(searchParams, {
    query: {
      queryKey: getSearchMissionActorsQueryKey(searchParams),
      enabled: search.trim().length > 0 && !picked,
    },
  });

  const { data: acting, isFetching: loadingActing } = useListActingForUser(picked?.id ?? "", {
    query: {
      queryKey: getListActingForUserQueryKey(picked?.id ?? ""),
      enabled: !!picked,
    },
  });

  const rows = acting ?? [];
  const total = rows
    .filter((r) => r.paymentStatus !== "failed")
    .reduce((sum, r) => sum + r.amount, 0);

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Player Acting Lookup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <p className="text-muted-foreground text-xs">
          Search any player to review their full acting / NPC history before signing them up again.
        </p>
        {picked ? (
          <div className="flex items-center justify-between border border-border/60 px-3 py-2">
            <span className="text-foreground">{picked.globalName ?? picked.username}</span>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setSearch("");
              }}
              className="text-muted-foreground hover:text-foreground"
              data-testid="button-clear-acting-lookup"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="name…"
                className="rounded-none pl-8"
                data-testid="input-acting-lookup-search"
              />
            </div>
            {search.trim().length > 0 && (
              <div className="border border-border/60 divide-y divide-border/40 max-h-56 overflow-y-auto">
                {searching && <div className="px-3 py-2 text-muted-foreground text-xs">Searching…</div>}
                {!searching && (results?.length ?? 0) === 0 && (
                  <div className="px-3 py-2 text-muted-foreground text-xs">No users found.</div>
                )}
                {results?.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setPicked(u)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent/40"
                    data-testid={`acting-lookup-result-${u.id}`}
                  >
                    <span className="text-foreground">{u.globalName ?? u.username}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {picked && (
          <div className="space-y-2" data-testid="acting-lookup-results">
            {loadingActing ? (
              <div className="text-muted-foreground text-xs">Loading acting history…</div>
            ) : rows.length === 0 ? (
              <p className="text-muted-foreground text-xs" data-testid="text-acting-lookup-empty">
                No acting history for this player yet.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {rows.length} act{rows.length === 1 ? "" : "s"}
                  </span>
                  <span className="text-nc-cyan">{formatEddies(total)} total</span>
                </div>
                <ul className="divide-y divide-border/40">
                  {rows.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-2 py-2"
                      data-testid={`acting-lookup-row-${r.id}`}
                    >
                      <div className="min-w-0">
                        <div className="text-foreground truncate">{r.name ?? "Untitled act"}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(r.actedAt)}
                        </div>
                      </div>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-muted-foreground text-[10px] uppercase">{r.source}</span>
                        <span
                          className={r.paymentStatus === "failed" ? "text-destructive" : "text-nc-cyan"}
                        >
                          {formatEddies(r.amount)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Staff-only: Breach Protocol puzzles linked to this mission. The breach list
// endpoint is FIXER/ADMIN-gated, so this only renders inside the manager tab.
function BreachesPanel({ missionId }: { missionId: number }) {
  const params = { missionId };
  const { data: breaches } = useListBreachPuzzles(params, {
    query: { queryKey: getListBreachPuzzlesQueryKey(params) },
  });
  const rows = breaches ?? [];
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground flex items-center gap-2">
          <Cpu className="w-4 h-4 text-nc-magenta" /> Attached Breaches
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            No Breach Protocol puzzles linked to this mission yet. Link one from{" "}
            <Link href="/breach" className="text-nc-cyan hover:underline">Breach Control</Link>.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 border border-border/40 bg-background/40 px-3 py-2 font-mono text-sm"
                data-testid={`mission-breach-${b.id}`}
              >
                <span className="text-muted-foreground text-xs">#{b.id}</span>
                <span className="text-foreground truncate">{b.assignedCharacterName ?? "—"}</span>
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {breachDifficultyBadge(b.difficulty)}
                  {breachStatusBadge(b.status)}
                  {(b.status === "success" || b.status === "failed") && (
                    <span className="text-xs text-muted-foreground">{b.solvedCount}/{b.daemons.length}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActorsView({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });

  const payActors = usePayMissionActors({ mutation: { onSuccess: invalidate } });

  const [selectedActors, setSelectedActors] = useState<ArchiveUser[]>([]);
  const [actorAmount, setActorAmount] = useState(0);
  const [actorSearch, setActorSearch] = useState("");

  const searchParams = { q: actorSearch || undefined };
  const { data: searchResults, isFetching: searchPending } = useSearchMissionActors(searchParams, {
    query: {
      queryKey: getSearchMissionActorsQueryKey(searchParams),
      enabled: actorSearch.trim().length > 0,
    },
  });

  // Users who already have a SUCCESSFUL actor payment for this mission — used to
  // warn/disable re-paying the same actor (double-pay guard mirrors the backend).
  const paidActorIds = new Set(
    data.actorPayments.filter((p) => p.paymentStatus === "paid").map((p) => p.userId),
  );

  const addActor = (u: ArchiveUser) => {
    setSelectedActors((prev) => (prev.some((x) => x.id === u.id) ? prev : [...prev, u]));
    setActorSearch("");
  };
  const removeActor = (id: string) =>
    setSelectedActors((prev) => prev.filter((x) => x.id !== id));

  const selectedIds = selectedActors.map((u) => u.id);
  const someAlreadyPaid = selectedActors.some((u) => paidActorIds.has(u.id));

  const payActorsErr = errOf(payActors.error);
  // Actor/NPC pay is allowed any time the mission is live — including after it's
  // marked completed. Only a cancelled mission refuses further payouts.
  const locked = data.status === "cancelled";

  return (
    <>
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Pay Actors / NPCs
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 font-mono text-sm">
          <p className="text-muted-foreground text-xs">
            Search for any user by name to pay them an actor / NPC fee. Not limited to assigned players.
          </p>

          {locked && (
            <div
              className="flex items-center gap-2 border border-nc-magenta/60 bg-nc-magenta/10 text-nc-magenta text-xs p-2"
              data-testid="text-actor-pay-locked"
            >
              <Lock className="w-3.5 h-3.5 shrink-0" />
              This mission is cancelled — actor and NPC payments are locked.
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs">SEARCH USERS</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={actorSearch}
                onChange={(e) => setActorSearch(e.target.value)}
                placeholder="name…"
                className="rounded-none pl-8"
                data-testid="input-actor-search"
              />
            </div>
            {actorSearch.trim().length > 0 && (
              <div className="border border-border/60 divide-y divide-border/40 max-h-56 overflow-y-auto">
                {searchPending && <div className="px-3 py-2 text-muted-foreground text-xs">Searching…</div>}
                {!searchPending && (searchResults?.length ?? 0) === 0 && (
                  <div className="px-3 py-2 text-muted-foreground text-xs">No users found.</div>
                )}
                {searchResults?.map((u) => {
                  const already = paidActorIds.has(u.id);
                  const selected = selectedIds.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => addActor(u)}
                      disabled={selected || already}
                      className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid={`actor-result-${u.id}`}
                    >
                      <span className="text-foreground">{u.globalName ?? u.username}</span>
                      <span className="flex items-center gap-2 text-xs">
                        {already && <span className="text-yellow-500">already paid</span>}
                        {selected && <span className="text-muted-foreground">added</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selectedActors.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="list-selected-actors">
              {selectedActors.map((u) => {
                const already = paidActorIds.has(u.id);
                return (
                  <span
                    key={u.id}
                    className={`inline-flex items-center gap-1 border px-2 py-1 text-xs ${
                      already ? "border-yellow-500/60 text-yellow-500" : "border-border text-foreground"
                    }`}
                    data-testid={`chip-actor-${u.id}`}
                  >
                    {u.globalName ?? u.username}
                    {already && <AlertTriangle className="w-3 h-3" />}
                    <button type="button" onClick={() => removeActor(u.id)} data-testid={`remove-actor-${u.id}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {someAlreadyPaid && (
            <div className="text-yellow-500 text-xs flex items-center gap-1" data-testid="text-actor-already-paid">
              <AlertTriangle className="w-3 h-3" /> One or more selected users were already paid for this mission. Paying
              again will be skipped by the server.
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
              disabled={locked || payActors.isPending || selectedIds.length === 0 || actorAmount <= 0}
              onClick={() =>
                payActors.mutate(
                  { id: data.id, data: { userIds: selectedIds, amount: actorAmount } },
                  {
                    onSuccess: () => {
                      setSelectedActors([]);
                      setActorAmount(0);
                      setActorSearch("");
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

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Actor Payments ({data.actorPayments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.actorPayments.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground" data-testid="text-no-actor-payments">
              No actors have been paid for this mission yet. Use the search above to pay an actor / NPC —
              they'll appear here once paid. (Past missions imported from the old Discord bot have no actor
              records, so their list starts empty.)
            </p>
          ) : (
            <ul className="divide-y divide-border/40 font-mono text-sm">
              {data.actorPayments.map((p) => (
                <li key={p.id} className="flex flex-col gap-1 py-2" data-testid={`row-actor-payment-${p.id}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-foreground">{p.characterName ?? p.userName ?? p.userId}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs uppercase">{p.source}</span>
                      <PaymentBadge status={p.paymentStatus} amount={p.amount} error={p.paymentError} />
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span data-testid={`actor-payment-by-${p.id}`}>
                      {p.fixerName ? `by ${p.fixerName}` : p.source === "auto" ? "auto" : "—"}
                    </span>
                    <span>{fmtDateTime(p.paidAt ?? p.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <NpcRoster data={data} locked={locked} />
    </>
  );
}

function NpcRoster({ data, locked }: { data: MissionDetailModel; locked: boolean }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });
  const confirm = useConfirmNpcSignup({ mutation: { onSuccess: invalidate } });
  const confirmErr = errOf(confirm.error);

  const signups = data.npcSignups ?? [];
  const outstanding = signups.filter((s) => s.state === "signed_up").length;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          NPC Sign-ups ({signups.length})
          {outstanding > 0 && (
            <span className="ml-2 text-nc-yellow normal-case tracking-normal">
              {outstanding} awaiting confirmation
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <p className="text-muted-foreground text-xs">
          Players who volunteered to NPC this job. Confirm attendance to pay{" "}
          {(data.npcPayAmount ?? 0) > 0 ? `${formatEddies(data.npcPayAmount ?? 0)}` : "the NPC fee"}, or mark a no-show.
        </p>
        {signups.length === 0 ? (
          <p className="text-muted-foreground text-xs" data-testid="text-no-npc-signups">
            No NPC sign-ups yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {signups.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-3" data-testid={`row-npc-signup-${s.id}`}>
                <Avatar className="border border-nc-magenta/30 rounded-none w-10 h-10">
                  <AvatarImage src={s.characterPortraitUrl ?? s.userAvatarUrl ?? undefined} />
                  <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display text-xs">
                    {(s.characterName ?? s.userName ?? "??").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="font-display text-foreground">
                    {s.characterName ?? s.userName ?? s.userId}
                  </div>
                  {s.characterName && s.userName && (
                    <div className="text-xs font-mono text-muted-foreground">{s.userName}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {s.state === "signed_up" ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={locked || confirm.isPending}
                        onClick={() =>
                          confirm.mutate({ id: data.id, signupId: s.id, data: { action: "attended" } })
                        }
                        className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                        data-testid={`button-npc-attended-${s.id}`}
                      >
                        ATTENDED
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={locked || confirm.isPending}
                        onClick={() =>
                          confirm.mutate({ id: data.id, signupId: s.id, data: { action: "no_show" } })
                        }
                        className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
                        data-testid={`button-npc-noshow-${s.id}`}
                      >
                        NO-SHOW
                      </Button>
                    </>
                  ) : s.state === "attended" ? (
                    <PaymentBadge status={s.paymentStatus} amount={s.payAmount} error={s.paymentError} />
                  ) : (
                    <NpcStateBadge state={s.state} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {confirmErr && (
          <div className="text-destructive text-xs" data-testid="text-confirm-npc-error">{confirmErr}</div>
        )}
      </CardContent>
    </Card>
  );
}
