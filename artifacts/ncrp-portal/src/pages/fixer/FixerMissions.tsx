import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMissions,
  useCreateMission,
  useUpdateMission,
  useGetMission,
  getListMissionsQueryKey,
  type MissionCreateInputTier,
  type MissionCreateInputStatus,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Briefcase, X } from "lucide-react";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
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

export default function FixerMissions() {
  const qc = useQueryClient();
  const search = useSearch();
  const editId = (() => {
    const v = new URLSearchParams(search).get("edit");
    const n = v ? Number(v) : NaN;
    return Number.isInteger(n) ? n : null;
  })();

  const { data: missions, isLoading } = useListMissions();
  const invalidateList = () => qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
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
                          {m.slots > 0 ? ` / ${m.slots}` : ""}
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
  location: string;
  description: string;
  imageUrl: string;
  startAt: string;
  durationMinutes: number;
  slots: number;
  status: MissionCreateInputStatus;
  assignments: AssignmentDraft[];
};

const EMPTY: FormValues = {
  title: "",
  tier: 1,
  playerPay: 0,
  location: "",
  description: "",
  imageUrl: "",
  startAt: "",
  durationMinutes: 120,
  slots: 0,
  status: "open",
  assignments: [],
};

function EditMissionForm({ missionId, onSaved }: { missionId: number; onSaved: () => void }) {
  const { data, isLoading } = useGetMission(missionId);
  if (isLoading) return <div className="font-mono text-nc-cyan animate-pulse">Loading mission...</div>;
  if (!data) return <div className="font-mono text-destructive">Mission not found.</div>;
  const initial: FormValues = {
    title: data.title,
    tier: data.tier,
    playerPay: data.playerPay,
    location: data.location ?? "",
    description: data.description ?? "",
    imageUrl: data.imageUrl ?? "",
    startAt: toLocalInputValue(data.startAt),
    durationMinutes: data.durationMinutes,
    slots: data.slots,
    status: data.status,
    assignments: data.assignments.map((a) => ({
      userId: a.userId,
      character: a.characterId ? { id: a.characterId, name: a.characterName ?? "(character)" } : null,
    })),
  };
  return <MissionForm key={`edit-${missionId}`} missionId={missionId} initial={initial} onSaved={onSaved} />;
}

function MissionForm({
  missionId,
  initial,
  onSaved,
}: {
  missionId?: number;
  initial?: FormValues;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState<FormValues>(initial ?? EMPTY);
  useEffect(() => {
    if (initial) setV(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  const create = useCreateMission({ mutation: { onSuccess: onSaved } });
  const update = useUpdateMission({ mutation: { onSuccess: onSaved } });
  const busy = create.isPending || update.isPending;
  const errMsg = errOf(create.error) ?? errOf(update.error);

  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) => setV((p) => ({ ...p, [k]: val }));

  const addAssignment = (c: CharacterPickerValue) => {
    if (!c) return;
    setV((p) => {
      if (p.assignments.some((a) => a.character?.id === c.id)) return p;
      return { ...p, assignments: [...p.assignments, { userId: null, character: c }] };
    });
  };
  const removeAssignment = (idx: number) =>
    setV((p) => ({ ...p, assignments: p.assignments.filter((_, i) => i !== idx) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.title.trim()) return;
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

    const payload = {
      title: v.title.trim(),
      tier: v.tier,
      playerPay: v.playerPay,
      location: v.location || undefined,
      description: v.description || undefined,
      imageUrl: v.imageUrl || undefined,
      startAt: v.startAt ? new Date(v.startAt).toISOString() : undefined,
      durationMinutes: v.durationMinutes,
      slots: v.slots,
      status: v.status,
      assignments,
    };

    if (missionId != null) {
      update.mutate(
        { id: missionId, data: payload },
        { onSuccess: () => qc.invalidateQueries() },
      );
    } else {
      create.mutate({ data: payload }, { onSuccess: () => setV(EMPTY) });
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
            <Label className="text-xs">START (local)</Label>
            <Input
              type="datetime-local"
              value={v.startAt}
              onChange={(e) => set("startAt", e.target.value)}
              className="rounded-none"
              data-testid="input-mission-start"
            />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">DURATION (min)</Label>
            <Input
              type="number"
              min={1}
              value={v.durationMinutes || ""}
              onChange={(e) => set("durationMinutes", Number(e.target.value))}
              className="rounded-none"
              data-testid="input-mission-duration"
            />
          </div>
          <div className="md:col-span-3">
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
          <div className="md:col-span-3">
            <Label className="text-xs">SLOTS (0 = open)</Label>
            <Input
              type="number"
              min={0}
              value={v.slots || ""}
              onChange={(e) => set("slots", Number(e.target.value))}
              className="rounded-none"
              data-testid="input-mission-slots"
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
            <Label className="text-xs">IMAGE URL</Label>
            <Input
              value={v.imageUrl}
              onChange={(e) => set("imageUrl", e.target.value)}
              placeholder="/api/storage/objects/..."
              className="rounded-none"
              data-testid="input-mission-image"
            />
          </div>

          <div className="md:col-span-12">
            <Label className="text-xs">DESCRIPTION</Label>
            <Textarea
              value={v.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              className="rounded-none"
              data-testid="input-mission-description"
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

          <div className="md:col-span-12 flex items-center gap-3">
            <Button
              type="submit"
              disabled={busy || !v.title.trim()}
              className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
              data-testid="button-save-mission"
            >
              {busy ? "SAVING..." : missionId != null ? "SAVE MISSION" : "CREATE MISSION"}
            </Button>
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
