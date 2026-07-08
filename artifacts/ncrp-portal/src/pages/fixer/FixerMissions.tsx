import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMissions,
  useCreateMission,
  useUpdateMission,
  useSubmitMission,
  useGetMission,
  useCheckMissionConflicts,
  getCheckMissionConflictsQueryKey,
  getListMissionsQueryKey,
  getListCreatedMissionsQueryKey,
  getListOwnedMissionsQueryKey,
  getGetMissionQueryKey,
  type MissionCreateInputTier,
  type MissionCreateInputStatus,
  type MissionCreateInputJobType,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Briefcase, X } from "lucide-react";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import MarkdownEditor from "@/components/MarkdownEditor";
import SingleImageUpload from "@/components/SingleImageUpload";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";
import {
  MISSION_STATUSES,
  MISSION_TIERS,
  missionStatusClass,
  missionStatusLabel,
  missionTierLabel,
} from "@/lib/missionStatus";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Save failed" : null);
}

// Convert a value like "2026-05-30T18:00" (datetime-local) to an ISO string,
// and back. datetime-local has no timezone, so we treat it as local time.
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Given a start ISO time and a duration in minutes, return the END time as a
// datetime-local input value. Used to seed the End picker when editing a mission
// that was stored as start + durationMinutes.
function endLocalInputValue(iso: string | null | undefined, durationMinutes: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const end = new Date(d.getTime() + (durationMinutes || 0) * 60000);
  return toLocalInputValue(end.toISOString());
}

// Derive durationMinutes from local start/end input values. Falls back to the
// default 120 when either side is missing or end is not after start.
function durationFromRange(startLocal: string, endLocal: string): number {
  if (!startLocal || !endLocal) return 120;
  const s = new Date(startLocal).getTime();
  const e = new Date(endLocal).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 120;
  return Math.round((e - s) / 60000);
}

export default function FixerMissions() {
  const qc = useQueryClient();
  const search = useSearch();
  const editId = (() => {
    const v = new URLSearchParams(search).get("edit");
    const n = v ? Number(v) : NaN;
    return Number.isInteger(n) ? n : null;
  })();

  const { data: missions, isLoading } = useListMissions();
  const invalidateList = () => {
    qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListCreatedMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListOwnedMissionsQueryKey() });
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-missions-title">
        <Briefcase className="w-7 h-7 text-nc-magenta" /> MISSIONS
      </h1>

      <MissionTestModeBanner />

      {editId != null ? (
        <EditMissionForm missionId={editId} onSaved={invalidateList} />
      ) : (
        <MissionForm key="create" onSaved={invalidateList} />
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">SCHEDULED MISSIONS</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading missions...</div>
          ) : !missions || missions.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No missions scheduled.</p>
          ) : (
            <table className="w-full font-mono text-sm">
              <thead className="border-b border-border bg-card">
                <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                  <th className="text-left p-2">When</th>
                  <th className="text-left p-2">Title</th>
                  <th className="text-left p-2">Tier</th>
                  <th className="text-left p-2">Fixer</th>
                  <th className="text-right p-2">Players</th>
                  <th className="text-right p-2">Player Pay</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {missions.map((m) => {
                  const href = `/missions/${m.id}`;
                  return (
                    <tr
                      key={m.id}
                      className="border-b border-border/30 hover:bg-card/80 cursor-pointer"
                      data-testid={`row-mission-${m.id}`}
                    >
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-muted-foreground text-xs">
                          {m.startAt ? new Date(m.startAt).toLocaleString() : "—"}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-foreground">
                          {m.title}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2">
                          {missionTierLabel(m.tier)}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-nc-magenta">
                          {m.fixerName ?? "—"}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-right">
                          {m.assignedCount}
                          {m.maxPlayers > 0 ? ` / ${m.maxPlayers}` : ""}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-right text-nc-yellow">
                          {m.playerPay ? `€$${m.playerPay.toLocaleString()}` : "—"}
                        </Link>
                      </td>
                      <td className="p-2">
                        <Badge variant="outline" className={`rounded-none text-[10px] px-1 py-0 ${missionStatusClass(m.status)}`}>
                          {missionStatusLabel(m.status).toUpperCase()}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type AssignmentDraft = { userId: string | null; character: CharacterPickerValue };

type FormValues = {
  title: string;
  tier: MissionCreateInputTier;
  playerPay: number;
  npcPayAmount: number;
  location: string;
  description: string;
  imageUrl: string;
  startAt: string;
  endAt: string;
  status: MissionCreateInputStatus;
  worldLink: string;
  jobType: MissionCreateInputJobType | "";
  requestedSkills: string;
  client: string;
  notesForPlayers: string;
  fixerNotes: string;
  maxPlayers: number;
  assignments: AssignmentDraft[];
};

const EMPTY: FormValues = {
  title: "",
  tier: 1,
  playerPay: 0,
  npcPayAmount: 0,
  location: "",
  description: "",
  imageUrl: "",
  startAt: "",
  endAt: "",
  status: "open",
  worldLink: "",
  jobType: "",
  requestedSkills: "",
  client: "",
  notesForPlayers: "",
  fixerNotes: "",
  maxPlayers: 0,
  assignments: [],
};

const MISSION_DRAFT_KEY = "ncrp:mission-create-draft";

const JOB_TYPE_OPTIONS: { value: MissionCreateInputJobType; label: string }[] = [
  { value: "combat", label: "Combat" },
  { value: "non_combat", label: "Non-Combat" },
  { value: "mixed", label: "Mixed" },
];

function EditMissionForm({ missionId, onSaved }: { missionId: number; onSaved: () => void }) {
  const { data, isLoading } = useGetMission(missionId);
  if (isLoading) return <div className="font-mono text-nc-cyan animate-pulse">Loading mission...</div>;
  if (!data) return <div className="font-mono text-destructive">Mission not found.</div>;
  const initial: FormValues = {
    title: data.title,
    tier: data.tier,
    playerPay: data.playerPay,
    npcPayAmount: data.npcPayAmount ?? 0,
    location: data.location ?? "",
    description: data.description ?? "",
    imageUrl: data.imageUrl ?? "",
    startAt: toLocalInputValue(data.startAt),
    endAt: endLocalInputValue(data.startAt, data.durationMinutes),
    status: data.status,
    worldLink: data.worldLink ?? "",
    jobType: data.jobType ?? "",
    requestedSkills: data.requestedSkills ?? "",
    client: data.client ?? "",
    notesForPlayers: data.notesForPlayers ?? "",
    fixerNotes: data.fixerNotes ?? "",
    maxPlayers: data.maxPlayers,
    assignments: data.assignments.map((a) => ({
      userId: a.userId,
      character: a.characterId ? { id: a.characterId, name: a.characterName ?? "(character)" } : null,
    })),
  };
  return (
    <MissionForm
      key={`edit-${missionId}`}
      missionId={missionId}
      initial={initial}
      excludeEventId={data.discordEventId ?? undefined}
      onSaved={onSaved}
    />
  );
}

function MissionForm({
  missionId,
  initial,
  excludeEventId,
  onSaved,
}: {
  missionId?: number;
  initial?: FormValues;
  excludeEventId?: string;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  // Only the CREATE form autosaves to localStorage; edits are server-backed.
  const isCreate = missionId == null;
  const [v, setV] = useState<FormValues>(() => {
    if (initial) return initial;
    if (missionId == null) {
      try {
        const raw = localStorage.getItem(MISSION_DRAFT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<FormValues>;
          // Defend against stale/malformed drafts: only merge known fields and
          // force `assignments` to a valid array so a corrupt value can't poison
          // the form (and crash rendering).
          return {
            ...EMPTY,
            ...parsed,
            assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
          };
        }
      } catch {
        /* ignore malformed draft */
      }
    }
    return EMPTY;
  });
  useEffect(() => {
    if (initial) setV(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  // Persist the in-progress create form so a refresh/navigation doesn't lose work.
  useEffect(() => {
    if (!isCreate) return;
    try {
      localStorage.setItem(MISSION_DRAFT_KEY, JSON.stringify(v));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [v, isCreate]);

  const clearDraft = () => {
    try {
      localStorage.removeItem(MISSION_DRAFT_KEY);
    } catch {
      /* ignore */
    }
  };

  const create = useCreateMission({ mutation: { onSuccess: onSaved } });
  const update = useUpdateMission({ mutation: { onSuccess: onSaved } });
  const submitProposal = useSubmitMission({ mutation: { onSuccess: onSaved } });
  const busy = create.isPending || update.isPending || submitProposal.isPending;
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const errMsg = errOf(create.error) ?? errOf(update.error) ?? errOf(submitProposal.error) ?? submitErr;

  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) => setV((p) => ({ ...p, [k]: val }));

  // Fail-safe Discord scheduling-conflict warning (never blocks). Only queries
  // once a start time is set; surfaces overlapping events for staff awareness.
  const startIso = v.startAt ? new Date(v.startAt).toISOString() : "";
  const computedDuration = durationFromRange(v.startAt, v.endAt);
  const conflictParams = {
    startAt: startIso,
    durationMinutes: computedDuration || undefined,
    // When editing an already-posted mission, ignore its own Discord event so
    // a reschedule doesn't warn against itself.
    ...(excludeEventId ? { excludeEventId } : {}),
  };
  const conflictQuery = useCheckMissionConflicts(conflictParams, {
    query: { enabled: !!startIso, queryKey: getCheckMissionConflictsQueryKey(conflictParams) },
  });
  const conflict = conflictQuery.data;

  const addAssignment = (c: CharacterPickerValue) => {
    if (!c) return;
    setV((p) => {
      if (p.assignments.some((a) => a.character?.id === c.id)) return p;
      return { ...p, assignments: [...p.assignments, { userId: null, character: c }] };
    });
  };
  const removeAssignment = (idx: number) =>
    setV((p) => ({ ...p, assignments: p.assignments.filter((_, i) => i !== idx) }));

  const buildPayload = () => {
    // Send characterId-only assignments; the server derives the owning player.
    // Keep explicit userId for rows that came from existing assignments.
    const assignments = v.assignments
      .map((a) => ({
        userId: a.userId ?? undefined,
        characterId: a.character?.id ?? undefined,
      }))
      .filter((a) => a.userId !== undefined || a.characterId !== undefined) as Array<{
      userId?: string;
      characterId?: number;
    }>;

    return {
      title: v.title.trim(),
      tier: v.tier,
      playerPay: v.playerPay,
      npcPayAmount: v.npcPayAmount,
      location: v.location || undefined,
      description: v.description || undefined,
      imageUrl: v.imageUrl || undefined,
      startAt: v.startAt ? new Date(v.startAt).toISOString() : undefined,
      durationMinutes: computedDuration,
      status: v.status,
      worldLink: v.worldLink || undefined,
      jobType: v.jobType || undefined,
      requestedSkills: v.requestedSkills || undefined,
      client: v.client || undefined,
      notesForPlayers: v.notesForPlayers || undefined,
      fixerNotes: v.fixerNotes || undefined,
      maxPlayers: v.maxPlayers,
      assignments,
    };
  };

  // Create form: persist the mission in draft state and reset the form.
  const saveDraft = () => {
    setSubmitErr(null);
    if (!v.title.trim()) return;
    create.mutate(
      { data: buildPayload() },
      {
        onSuccess: () => {
          setPendingSubmitId(null);
          clearDraft();
          setV(EMPTY);
        },
      },
    );
  };

  // Create form: create the mission, then submit it straight to the approval
  // queue (Misc Requests). The server requires a job type on submit, so we
  // enforce it client-side first to give a clear message. If the create
  // succeeds but the submit fails, we retain the new mission's id so a retry
  // resubmits the SAME mission instead of creating a duplicate draft.
  const [pendingSubmitId, setPendingSubmitId] = useState<number | null>(null);
  const submitForApproval = async () => {
    setSubmitErr(null);
    if (!v.title.trim()) return;
    if (!v.jobType) {
      setSubmitErr("Select a job type before submitting for approval.");
      return;
    }
    try {
      let id = pendingSubmitId;
      if (id == null) {
        const created = await create.mutateAsync({ data: buildPayload() });
        id = created.id;
        setPendingSubmitId(id);
      }
      await submitProposal.mutateAsync({ id });
      setPendingSubmitId(null);
      clearDraft();
      setV(EMPTY);
    } catch {
      /* error surfaced via errMsg; pendingSubmitId is retained for retry */
    }
  };

  // Form submit: edit mode saves the mission; create mode saves a draft (the
  // explicit "Submit for approval" button drives the proposal path).
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitErr(null);
    if (!v.title.trim()) return;
    if (missionId != null) {
      // The mutation-level onSuccess (onSaved) already refreshes the mission
      // lists; here we just refresh this specific mission's detail, instead of
      // the previous blanket qc.invalidateQueries() that refetched everything.
      update.mutate(
        { id: missionId, data: buildPayload() },
        { onSuccess: () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(missionId) }) },
      );
    } else {
      saveDraft();
    }
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest">
          {missionId != null ? "EDIT MISSION" : "NEW MISSION"}
        </CardTitle>
        {missionId != null && (
          <Link href="/fixer/missions" className="text-nc-cyan font-mono text-xs hover:underline">
            cancel edit
          </Link>
        )}
      </CardHeader>
      <CardContent>
        <form className="grid grid-cols-1 md:grid-cols-12 gap-3 font-mono text-sm" onSubmit={submit}>
          <div className="md:col-span-6">
            <Label className="text-xs">TITLE</Label>
            <Input
              value={v.title}
              onChange={(e) => set("title", e.target.value)}
              required
              className="rounded-none"
              data-testid="input-mission-title"
            />
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs">TIER</Label>
            <select
              value={v.tier}
              onChange={(e) => set("tier", Number(e.target.value) as MissionCreateInputTier)}
              className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
              data-testid="select-mission-tier"
            >
              {MISSION_TIERS.map((t) => (
                <option key={t} value={t}>
                  {missionTierLabel(t).toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs">STATUS</Label>
            <select
              value={v.status}
              onChange={(e) => set("status", e.target.value as MissionCreateInputStatus)}
              className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
              data-testid="select-mission-status"
            >
              {MISSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {missionStatusLabel(s).toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-4">
            <Label className="text-xs">START (date &amp; time, local)</Label>
            <Input
              type="datetime-local"
              value={v.startAt}
              onChange={(e) => set("startAt", e.target.value)}
              className="rounded-none"
              data-testid="input-mission-start"
            />
          </div>
          <div className="md:col-span-4">
            <Label className="text-xs">END (date &amp; time, local)</Label>
            <Input
              type="datetime-local"
              value={v.endAt}
              onChange={(e) => set("endAt", e.target.value)}
              className="rounded-none"
              data-testid="input-mission-end"
            />
            {v.startAt && v.endAt && new Date(v.endAt) <= new Date(v.startAt) && (
              <p className="text-destructive text-[10px] mt-1" data-testid="text-end-before-start">
                End must be after start.
              </p>
            )}
          </div>
          {conflict && conflict.conflicts.length > 0 && (
            <div
              className="md:col-span-12 border border-nc-yellow/50 bg-nc-yellow/10 px-3 py-2 text-xs text-nc-yellow"
              data-testid="warning-discord-conflict"
            >
              <span className="font-display tracking-widest">⚠ DISCORD CONFLICT</span> — this window overlaps{" "}
              {conflict.conflicts.length} existing event
              {conflict.conflicts.length > 1 ? "s" : ""}:{" "}
              {conflict.conflicts.map((c) => c.name).join(", ")}. This is only a warning; you can still save.
            </div>
          )}
          {conflict && !conflict.checked && conflict.error && (
            <div
              className="md:col-span-12 border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              data-testid="warning-discord-conflict-unchecked"
            >
              Couldn't check Discord for scheduling conflicts ({conflict.error}). Proceeding anyway.
            </div>
          )}
          <div className="md:col-span-4">
            <Label className="text-xs">PLAYER PAY €$</Label>
            <Input
              type="number"
              min={0}
              value={v.playerPay || ""}
              onChange={(e) => set("playerPay", Number(e.target.value))}
              className="rounded-none"
              data-testid="input-mission-playerpay"
            />
          </div>
          <div className="md:col-span-4">
            <Label className="text-xs">NPC PAY €$ (per confirmed sign-up)</Label>
            <Input
              type="number"
              min={0}
              value={v.npcPayAmount || ""}
              onChange={(e) => set("npcPayAmount", Number(e.target.value))}
              className="rounded-none"
              data-testid="input-mission-npcpay"
            />
          </div>

          <div className="md:col-span-6">
            <Label className="text-xs">LOCATION</Label>
            <Input
              value={v.location}
              onChange={(e) => set("location", e.target.value)}
              className="rounded-none"
              data-testid="input-mission-location"
            />
          </div>
          <div className="md:col-span-6">
            <Label className="text-xs">IMAGE</Label>
            <div className="mt-1">
              <SingleImageUpload
                value={v.imageUrl}
                onChange={(url) => set("imageUrl", url)}
                testIdPrefix="mission"
                alt="mission"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <Label className="text-xs">JOB TYPE *</Label>
            <select
              value={v.jobType}
              onChange={(e) => set("jobType", e.target.value as MissionCreateInputJobType | "")}
              className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
              data-testid="select-mission-jobtype"
            >
              <option value="">— select —</option>
              {JOB_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs">MAX PLAYERS (0 = no cap)</Label>
            <Input
              type="number"
              min={0}
              value={Number.isFinite(v.maxPlayers) ? String(v.maxPlayers) : ""}
              onChange={(e) => set("maxPlayers", e.target.value === "" ? 0 : Number(e.target.value))}
              className="rounded-none"
              data-testid="input-mission-maxplayers"
            />
          </div>
          <div className="md:col-span-6">
            <Label className="text-xs">CLIENT</Label>
            <Input
              value={v.client}
              onChange={(e) => set("client", e.target.value)}
              className="rounded-none"
              data-testid="input-mission-client"
            />
          </div>

          <div className="md:col-span-6">
            <Label className="text-xs">REQUESTED SKILLS</Label>
            <Input
              value={v.requestedSkills}
              onChange={(e) => set("requestedSkills", e.target.value)}
              placeholder="e.g. netrunning, stealth, demolitions"
              className="rounded-none"
              data-testid="input-mission-skills"
            />
          </div>
          <div className="md:col-span-6">
            <Label className="text-xs">
              WORLD / JOIN LINK <span className="text-nc-magenta">(staff only)</span>
            </Label>
            <Input
              value={v.worldLink}
              onChange={(e) => set("worldLink", e.target.value)}
              placeholder="https://vrchat.com/home/world/..."
              className="rounded-none"
              data-testid="input-mission-worldlink"
            />
          </div>

          <div className="md:col-span-12">
            <Label className="text-xs">
              FIXER-ONLY INFORMATION <span className="text-nc-magenta">(staff only)</span>
            </Label>
            <Textarea
              value={v.fixerNotes}
              onChange={(e) => set("fixerNotes", e.target.value)}
              rows={2}
              className="rounded-none"
              placeholder="Private briefing — visible only in the Fixer tab. Never shown to players."
              data-testid="input-mission-fixernotes"
            />
          </div>

          <div className="md:col-span-12">
            <Label className="text-xs">DESCRIPTION</Label>
            <MarkdownEditor
              value={v.description}
              onChange={(val) => set("description", val)}
              rows={3}
              testId="input-mission-description"
            />
          </div>

          <div className="md:col-span-12">
            <Label className="text-xs">NOTES FOR PLAYERS</Label>
            <Textarea
              value={v.notesForPlayers}
              onChange={(e) => set("notesForPlayers", e.target.value)}
              rows={2}
              className="rounded-none"
              placeholder="Visible to players on the posted mission."
              data-testid="input-mission-notes"
            />
          </div>

          <div className="md:col-span-12 space-y-2">
            <Label className="text-xs">ASSIGN PLAYERS</Label>
            <CharacterPicker value={null} onChange={addAssignment} testId="input-mission-assign" />
            {v.assignments.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {v.assignments.map((a, i) => (
                  <span
                    key={`${a.character?.id ?? a.userId ?? i}`}
                    className="inline-flex items-center gap-1 border border-border bg-background px-2 py-1 text-xs"
                    data-testid={`assigned-${a.character?.id ?? a.userId ?? i}`}
                  >
                    {a.character?.name ?? a.userId ?? "(player)"}
                    <button type="button" onClick={() => removeAssignment(i)} className="text-destructive hover:text-destructive/80">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="md:col-span-12 flex flex-wrap items-center gap-3">
            {missionId != null ? (
              <Button
                type="submit"
                disabled={busy || !v.title.trim()}
                className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
                data-testid="button-save-mission"
              >
                {busy ? "SAVING..." : "SAVE MISSION"}
              </Button>
            ) : (
              <>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy || !v.title.trim()}
                  className="rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display tracking-widest"
                  data-testid="button-save-draft"
                >
                  {create.isPending && !submitProposal.isPending ? "SAVING..." : "SAVE AS DRAFT"}
                </Button>
                <Button
                  type="button"
                  onClick={submitForApproval}
                  disabled={busy || !v.title.trim()}
                  className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
                  data-testid="button-submit-approval"
                >
                  {submitProposal.isPending ? "SUBMITTING..." : "SUBMIT FOR APPROVAL"}
                </Button>
              </>
            )}
            {errMsg && (
              <span className="text-destructive text-xs" data-testid="text-mission-error">
                {errMsg}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
