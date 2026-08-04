import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEvents,
  useGetEvent,
  useCreateEvent,
  useUpdateEvent,
  useCancelEvent,
  useCheckEventConflicts,
  useSearchFixerPlayers,
  getCheckEventConflictsQueryKey,
  getListEventsQueryKey,
  getSearchFixerPlayersQueryKey,
  type EventCreateInputEventType,
  type EventCreateInputTicketPayoutMode,
  type EventTicketTypeInput,
  type EventUpdateInput,
  type EventRecurrence,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { expandOccurrences, type RecurrenceRule } from "@/lib/eventRecurrence";
import { PartyPopper, Trash2, Ticket, Plus, X, RefreshCw } from "lucide-react";
import MarkdownEditor from "@/components/MarkdownEditor";
import SingleImageUpload from "@/components/SingleImageUpload";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Save failed" : null);
}

// datetime-local has no timezone, so values are treated as local time.
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "mission" is intentionally NOT offered here — mission-style events live in the
// Missions system, not the events calendar. The label map below still resolves
// any legacy mission-typed rows for display.
const EVENT_TYPE_OPTIONS: { value: EventCreateInputEventType; label: string }[] = [
  { value: "social", label: "Social" },
  { value: "session", label: "Main Session" },
  { value: "other", label: "Other" },
];

const EVENT_TYPE_LABEL: Record<string, string> = {
  social: "Social",
  session: "Main Session",
  mission: "Mission",
  other: "Other",
};

export default function FixerEvents() {
  const qc = useQueryClient();
  const search = useSearch();
  const editId = (() => {
    const v = new URLSearchParams(search).get("edit");
    const n = v ? Number(v) : NaN;
    return Number.isInteger(n) ? n : null;
  })();

  const { data: events, isLoading } = useListEvents(undefined, {
    query: { queryKey: getListEventsQueryKey() },
  });
  const invalidateList = () => qc.invalidateQueries({ queryKey: getListEventsQueryKey() });

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-events-title">
        <PartyPopper className="w-7 h-7 text-nc-cyan" /> EVENTS
      </h1>

      <MissionTestModeBanner />

      {editId != null ? (
        <EditEventForm eventId={editId} onSaved={invalidateList} />
      ) : (
        <EventForm key="create" onSaved={invalidateList} />
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">SCHEDULED EVENTS</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading events...</div>
          ) : !events || events.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No events scheduled.</p>
          ) : (
            <table className="w-full font-mono text-sm">
              <thead className="border-b border-border bg-card">
                <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                  <th className="text-left p-2">When</th>
                  <th className="text-left p-2">Title</th>
                  <th className="text-left p-2">Type</th>
                  <th className="text-left p-2">Organizer</th>
                  <th className="text-right p-2">NPCs</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const href = `/events/${e.id}`;
                  return (
                    <tr
                      key={e.id}
                      className="border-b border-border/30 hover:bg-card/80 cursor-pointer"
                      data-testid={`row-event-${e.id}`}
                    >
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-muted-foreground text-xs">
                          {formatDateTime(e.startAt)}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-foreground">
                          {e.title}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2">
                          {EVENT_TYPE_LABEL[e.eventType] ?? e.eventType}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={href} className="block p-2 text-nc-magenta">
                          {e.createdByName ?? "—"}
                        </Link>
                      </td>
                      <td className="p-2 text-right">
                        {e.needsNpcs ? (
                          <Badge variant="outline" className="rounded-none text-[10px] px-1 py-0 border-nc-magenta text-nc-magenta">
                            {e.signupCount}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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

type TicketTypeRow = {
  id: number | null;
  name: string;
  description: string;
  price: string;
  quantity: string;
};

type FormValues = {
  title: string;
  eventType: EventCreateInputEventType;
  location: string;
  description: string;
  imageUrl: string;
  startAt: string;
  endAt: string;
  needsNpcs: boolean;
  npcBlurb: string;
  // Repeat / recurrence. repeatMode === "weekly" means the event recurs every
  // repeatInterval weeks (anchored on the startAt weekday; no end date).
  // "none" = single occurrence. Disabled for sessions (those are discrete rows).
  repeatMode: "none" | "weekly";
  repeatInterval: number;
  ticketPayoutMode: EventCreateInputTicketPayoutMode;
  ticketRunnerUserId: string | null;
  ticketRunnerName: string;
  ticketTypes: TicketTypeRow[];
};

const EMPTY: FormValues = {
  title: "",
  eventType: "social",
  location: "",
  description: "",
  imageUrl: "",
  startAt: "",
  endAt: "",
  needsNpcs: false,
  npcBlurb: "",
  repeatMode: "none",
  repeatInterval: 1,
  ticketPayoutMode: "runner",
  ticketRunnerUserId: null,
  ticketRunnerName: "",
  ticketTypes: [],
};

const EVENT_DRAFT_KEY = "ncrp:event-create-draft";

// Type-ahead picker for the ticket-revenue runner. Default (null) = the event
// creator; picking a player routes every ticket credit to them instead.
function RunnerPicker({
  userId,
  userName,
  onPick,
}: {
  userId: string | null;
  userName: string;
  onPick: (id: string | null, name: string) => void;
}) {
  const [q, setQ] = useState("");
  const enabled = q.trim().length >= 2;
  const params = { q: q.trim() };
  const search = useSearchFixerPlayers(params, {
    query: { enabled, queryKey: getSearchFixerPlayersQueryKey(params) },
  });
  return (
    <div>
      <Label className="text-xs">EVENT RUNNER (leave empty = event creator)</Label>
      {userId ? (
        <div className="flex items-center gap-2 h-10">
          <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan" data-testid="badge-ticket-runner">
            {userName || userId}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onPick(null, "")}
            className="rounded-none text-destructive hover:bg-destructive/10"
            data-testid="button-clear-ticket-runner"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <div className="relative">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search players by name…"
            className="rounded-none"
            data-testid="input-ticket-runner-search"
          />
          {enabled && (search.data ?? []).length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 border border-border bg-card max-h-48 overflow-y-auto">
              {(search.data ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onPick(p.id, p.globalName || p.username);
                    setQ("");
                  }}
                  className="block w-full text-left px-3 py-2 text-xs hover:bg-nc-cyan/10"
                  data-testid={`option-ticket-runner-${p.id}`}
                >
                  {p.globalName || p.username}
                  {p.characterNames.length > 0 && (
                    <span className="text-muted-foreground"> — {p.characterNames.join(", ")}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EditEventForm({ eventId, onSaved }: { eventId: number; onSaved: () => void }) {
  const { data, isLoading } = useGetEvent(eventId);
  if (isLoading) return <div className="font-mono text-nc-cyan animate-pulse">Loading event...</div>;
  if (!data) return <div className="font-mono text-destructive">Event not found.</div>;
  const existingRule = data.recurrence ?? null;
  const initial: FormValues = {
    title: data.title,
    eventType: data.eventType as EventCreateInputEventType,
    location: data.location ?? "",
    description: data.description ?? "",
    imageUrl: data.imageUrl ?? "",
    startAt: toLocalInputValue(data.startAt),
    endAt: toLocalInputValue(data.endAt),
    needsNpcs: data.needsNpcs,
    npcBlurb: data.npcBlurb ?? "",
    // Prefill repeat control from the stored recurrence rule.
    repeatMode: existingRule ? "weekly" : "none",
    repeatInterval: existingRule?.interval ?? 1,
    ticketPayoutMode: (data.ticketPayoutMode ?? "runner") as EventCreateInputTicketPayoutMode,
    ticketRunnerUserId: data.ticketRunnerUserId ?? null,
    ticketRunnerName: data.ticketRunnerName ?? "",
    // Archived tiers are excluded: the PATCH is a replace-set, so re-sending
    // only live tiers keeps archived ones archived (server preserves sold rows).
    ticketTypes: (data.ticketTypes ?? [])
      .filter((t) => !t.archived)
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? "",
        price: String(t.price),
        quantity: String(t.quantity),
      })),
  };
  return (
    <EventForm
      key={`edit-${eventId}`}
      eventId={eventId}
      initial={initial}
      onSaved={onSaved}
      recurrence={(data.recurrence ?? null) as RecurrenceRule | null}
      baseStartAt={data.startAt}
      excludedOccurrences={data.excludedOccurrences ?? []}
    />
  );
}

function EventForm({
  eventId,
  initial,
  onSaved,
  recurrence,
  baseStartAt,
  excludedOccurrences,
}: {
  eventId?: number;
  initial?: FormValues;
  onSaved: () => void;
  // Edit mode only: the event's recurrence rule + base start. When recurring,
  // saving prompts "whole series or just one occurrence?".
  recurrence?: RecurrenceRule | null;
  baseStartAt?: string;
  excludedOccurrences?: string[];
}) {
  const qc = useQueryClient();
  const isCreate = eventId == null;
  const [v, setV] = useState<FormValues>(() => {
    if (initial) return initial;
    if (eventId == null) {
      try {
        const raw = localStorage.getItem(EVENT_DRAFT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<FormValues>;
          return { ...EMPTY, ...parsed };
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
  }, [eventId]);

  // Persist the in-progress create form so a refresh doesn't lose work.
  useEffect(() => {
    if (!isCreate) return;
    try {
      localStorage.setItem(EVENT_DRAFT_KEY, JSON.stringify(v));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [v, isCreate]);

  const clearDraft = () => {
    try {
      localStorage.removeItem(EVENT_DRAFT_KEY);
    } catch {
      /* ignore */
    }
  };

  const create = useCreateEvent({ mutation: { onSuccess: onSaved } });
  const update = useUpdateEvent({ mutation: { onSuccess: onSaved } });
  const cancel = useCancelEvent({ mutation: { onSuccess: onSaved } });

  // Recurring-edit scope prompt: the built payload is parked here while the
  // fixer picks "whole series" vs "just one occurrence".
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scope, setScope] = useState<"series" | "occurrence">("series");
  const [scopeOcc, setScopeOcc] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<EventUpdateInput | null>(null);
  // Next occurrences of the series the fixer can target (skips already-split
  // ones). 120-day horizon, capped at 10 options.
  const upcomingOccurrences: Date[] = (() => {
    if (!recurrence || !baseStartAt) return [];
    const base = new Date(baseStartAt);
    const now = new Date();
    const horizon = new Date(now.getTime() + 120 * 86400000);
    // Include an occurrence that already started earlier today.
    const windowStart = new Date(now.getTime() - 86400000);
    return expandOccurrences(base, recurrence, windowStart, horizon, excludedOccurrences).slice(0, 10);
  })();

  const confirmScope = () => {
    if (!pendingPayload || eventId == null) return;
    if (scope === "series") {
      update.mutate({ id: eventId, data: pendingPayload }, { onSuccess: () => qc.invalidateQueries() });
      setScopeOpen(false);
      return;
    }
    if (!scopeOcc || !baseStartAt) return;
    const occ = new Date(scopeOcc);
    const base = new Date(baseStartAt);
    // The form shows the SERIES base times; shift the edited times onto the
    // chosen occurrence by the same delta the fixer applied to the base.
    const startDelta = new Date(pendingPayload.startAt!).getTime() - base.getTime();
    const endDelta = new Date(pendingPayload.endAt!).getTime() - base.getTime();
    // Ticket tiers and recurrenceRule stay series-wide — the server rejects
    // both in occurrence scope, so strip them from the occurrence payload.
    const { ticketTypes: _tt, recurrenceRule: _rr, ...rest } = pendingPayload;
    update.mutate(
      {
        id: eventId,
        data: {
          ...rest,
          startAt: new Date(occ.getTime() + startDelta).toISOString(),
          endAt: new Date(occ.getTime() + endDelta).toISOString(),
          applyScope: "occurrence",
          occurrenceStartAt: occ.toISOString(),
        },
      },
      { onSuccess: () => qc.invalidateQueries() },
    );
    setScopeOpen(false);
  };
  const busy = create.isPending || update.isPending || cancel.isPending;
  const errMsg = errOf(create.error) ?? errOf(update.error) ?? errOf(cancel.error);

  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) => setV((p) => ({ ...p, [k]: val }));

  const endBeforeStart = !!v.startAt && !!v.endAt && new Date(v.endAt) <= new Date(v.startAt);

  // Surface overlapping Discord events so a fixer can avoid creating a duplicate.
  // Never blocks submission. Only queried once both times are set and valid.
  // In edit mode, exclude this event so it can't flag itself as an overlap.
  const startDate = v.startAt ? new Date(v.startAt) : null;
  const endDate = v.endAt ? new Date(v.endAt) : null;
  const datesValid =
    !!startDate && !Number.isNaN(startDate.getTime()) && !!endDate && !Number.isNaN(endDate.getTime());
  const conflictParams = {
    startAt: datesValid ? startDate!.toISOString() : "",
    endAt: datesValid ? endDate!.toISOString() : "",
    ...(eventId != null ? { excludeEventId: String(eventId) } : {}),
  };
  const conflictReady = datesValid && !endBeforeStart;
  const conflictQuery = useCheckEventConflicts(conflictParams, {
    query: { enabled: conflictReady, queryKey: getCheckEventConflictsQueryKey(conflictParams) },
  });
  const conflict = conflictReady ? conflictQuery.data : undefined;

  const ticketRowsValid = v.ticketTypes.every(
    (t) => t.name.trim().length > 0 && Number.isFinite(Number(t.price)) && Number(t.price) >= 0,
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.title.trim() || !v.startAt || !v.endAt || endBeforeStart || !ticketRowsValid) return;
    const ticketTypes: EventTicketTypeInput[] = v.ticketTypes.map((t) => ({
      ...(t.id != null ? { id: t.id } : {}),
      name: t.name.trim(),
      description: t.description.trim() || null,
      price: Math.max(0, Math.floor(Number(t.price) || 0)),
      quantity: Math.max(0, Math.floor(Number(t.quantity) || 0)),
    }));
    // Build the recurrenceRule payload value.
    // sessions are always discrete rows — never set recurrence on them.
    const recurrenceRule: EventRecurrence | null =
      v.eventType !== "session" && v.repeatMode === "weekly"
        ? { frequency: 2, interval: Math.max(1, v.repeatInterval), byWeekday: null, count: null, until: null }
        : null;

    const payload = {
      ticketPayoutMode: v.ticketPayoutMode,
      ticketRunnerUserId: v.ticketPayoutMode === "runner" ? v.ticketRunnerUserId : null,
      ticketTypes,
      title: v.title.trim(),
      eventType: v.eventType,
      location: v.location || null,
      description: v.description || null,
      imageUrl: v.imageUrl || null,
      startAt: new Date(v.startAt).toISOString(),
      endAt: new Date(v.endAt).toISOString(),
      needsNpcs: v.needsNpcs,
      npcBlurb: v.needsNpcs ? v.npcBlurb || null : null,
      recurrenceRule,
    };
    if (eventId != null) {
      // Recurring event: ask whether the edit applies to the whole series or
      // just one occurrence before sending anything.
      if (recurrence) {
        setPendingPayload(payload);
        setScope("series");
        setScopeOcc(null);
        setScopeOpen(true);
        return;
      }
      update.mutate({ id: eventId, data: payload }, { onSuccess: () => qc.invalidateQueries() });
    } else {
      create.mutate(
        { data: payload },
        {
          onSuccess: () => {
            clearDraft();
            setV(EMPTY);
          },
        },
      );
    }
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest">
          {eventId != null ? "EDIT EVENT" : "NEW EVENT"}
        </CardTitle>
        {eventId != null && (
          <Link href="/fixer/events" className="text-nc-cyan font-mono text-xs hover:underline">
            cancel edit
          </Link>
        )}
      </CardHeader>
      <CardContent>
        <form className="grid grid-cols-1 md:grid-cols-12 gap-3 font-mono text-sm" onSubmit={submit}>
          <div className="md:col-span-8">
            <Label className="text-xs">TITLE</Label>
            <Input
              value={v.title}
              onChange={(e) => set("title", e.target.value)}
              required
              className="rounded-none"
              data-testid="input-event-title"
            />
          </div>
          <div className="md:col-span-4">
            <Label className="text-xs">TYPE</Label>
            <select
              value={v.eventType}
              onChange={(e) => set("eventType", e.target.value as EventCreateInputEventType)}
              className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
              data-testid="select-event-type"
            >
              {EVENT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label.toUpperCase()}
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
              required
              className="rounded-none"
              data-testid="input-event-start"
            />
          </div>
          <div className="md:col-span-4">
            <Label className="text-xs">END (date &amp; time, local)</Label>
            <Input
              type="datetime-local"
              value={v.endAt}
              onChange={(e) => set("endAt", e.target.value)}
              required
              className="rounded-none"
              data-testid="input-event-end"
            />
            {endBeforeStart && (
              <p className="text-destructive text-[10px] mt-1" data-testid="text-end-before-start">
                End must be after start.
              </p>
            )}
          </div>
          <div className="md:col-span-4">
            <Label className="text-xs">LOCATION</Label>
            <Input
              value={v.location}
              onChange={(e) => set("location", e.target.value)}
              className="rounded-none"
              data-testid="input-event-location"
            />
          </div>

          {/* ---- Repeat / recurrence control ---- */}
          <div className="md:col-span-4">
            <Label className="text-xs flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />
              REPEAT
              {v.eventType === "session" && (
                <span className="text-muted-foreground normal-case tracking-normal ml-1">
                  (sessions use discrete rows — not applicable)
                </span>
              )}
            </Label>
            <select
              value={v.eventType === "session" ? "none" : v.repeatMode}
              onChange={(e) => set("repeatMode", e.target.value as "none" | "weekly")}
              disabled={v.eventType === "session"}
              className="w-full h-10 bg-background border border-border px-2 font-mono text-sm disabled:opacity-50"
              data-testid="select-repeat-mode"
            >
              <option value="none">NONE (single occurrence)</option>
              <option value="weekly">WEEKLY</option>
            </select>
          </div>
          {v.repeatMode === "weekly" && v.eventType !== "session" && (
            <div className="md:col-span-4">
              <Label className="text-xs">REPEAT EVERY (weeks)</Label>
              <Input
                type="number"
                min={1}
                max={52}
                step={1}
                value={v.repeatInterval}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(52, Math.floor(Number(e.target.value) || 1)));
                  set("repeatInterval", n);
                }}
                className="rounded-none"
                data-testid="input-repeat-interval"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Anchors to the start time's weekday. Runs open-ended; each occurrence is
                pushed to Discord automatically.
              </p>
            </div>
          )}

          {conflict && conflict.conflicts.length > 0 && (
            <div
              className="md:col-span-12 border border-nc-yellow/50 bg-nc-yellow/10 px-3 py-2 text-xs text-nc-yellow"
              data-testid="warning-discord-conflict"
            >
              <span className="font-display tracking-widest">⚠ OVERLAPPING EVENT</span> — this window overlaps{" "}
              {conflict.conflicts.length} existing event
              {conflict.conflicts.length > 1 ? "s" : ""}: {conflict.conflicts.map((c) => c.name).join(", ")}. Check
              whether one already covers this before creating a duplicate. You can still save.
            </div>
          )}
          {conflict && !conflict.checked && conflict.error && (
            <div
              className="md:col-span-12 border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              data-testid="warning-discord-conflict-unchecked"
            >
              Couldn't check Discord for overlapping events ({conflict.error}). Proceeding anyway.
            </div>
          )}

          <div className="md:col-span-12">
            <Label className="text-xs">BANNER IMAGE</Label>
            <div className="mt-1">
              <SingleImageUpload
                value={v.imageUrl}
                onChange={(url) => set("imageUrl", url)}
                testIdPrefix="event"
                alt="event"
              />
            </div>
          </div>

          <div className="md:col-span-12">
            <Label className="text-xs">DESCRIPTION</Label>
            <div className="mt-1">
              <MarkdownEditor
                value={v.description}
                onChange={(val) => set("description", val)}
                placeholder="What's happening, who it's for, what to expect…"
                testId="input-event-description"
              />
            </div>
          </div>

          <div className="md:col-span-12 border border-border bg-background/40 p-3 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer" data-testid="label-needs-npcs">
              <input
                type="checkbox"
                checked={v.needsNpcs}
                onChange={(e) => set("needsNpcs", e.target.checked)}
                className="h-4 w-4 accent-nc-magenta"
                data-testid="checkbox-needs-npcs"
              />
              <span className="text-xs uppercase tracking-widest text-nc-magenta">Need NPCs for this event</span>
            </label>
            {v.needsNpcs && (
              <div>
                <Label className="text-xs">NPC CALL-OUT (shown on the sign-up form)</Label>
                <Textarea
                  value={v.npcBlurb}
                  onChange={(e) => set("npcBlurb", e.target.value)}
                  rows={2}
                  className="rounded-none"
                  placeholder="What kind of NPCs you need, the vibe, any requirements…"
                  data-testid="input-npc-blurb"
                />
              </div>
            )}
          </div>

          <div className="md:col-span-12 border border-border bg-background/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-nc-cyan inline-flex items-center gap-2">
                <Ticket className="w-4 h-4" /> Tickets (optional)
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  set("ticketTypes", [
                    ...v.ticketTypes,
                    { id: null, name: "", description: "", price: "0", quantity: "0" },
                  ])
                }
                className="rounded-none border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display tracking-widest"
                data-testid="button-add-ticket-type"
              >
                <Plus className="w-4 h-4 mr-1" /> ADD TICKET TYPE
              </Button>
            </div>
            {v.ticketTypes.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No tickets — this event is free-entry. Add a ticket type to sell entry with UnbelievaBoat money.
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  {v.ticketTypes.map((t, i) => (
                    <div
                      key={t.id ?? `new-${i}`}
                      className="grid grid-cols-1 md:grid-cols-12 gap-2 border border-border/50 p-2"
                      data-testid={`row-ticket-type-${i}`}
                    >
                      <div className="md:col-span-4">
                        <Label className="text-xs">NAME</Label>
                        <Input
                          value={t.name}
                          onChange={(e) => {
                            const next = [...v.ticketTypes];
                            next[i] = { ...t, name: e.target.value };
                            set("ticketTypes", next);
                          }}
                          className="rounded-none"
                          placeholder="General admission"
                          data-testid={`input-ticket-name-${i}`}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <Label className="text-xs">PRICE €$</Label>
                        <Input
                          type="number"
                          min={0}
                          value={t.price}
                          onChange={(e) => {
                            const next = [...v.ticketTypes];
                            next[i] = { ...t, price: e.target.value };
                            set("ticketTypes", next);
                          }}
                          className="rounded-none"
                          data-testid={`input-ticket-price-${i}`}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <Label className="text-xs">QTY (0 = ∞)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={t.quantity}
                          onChange={(e) => {
                            const next = [...v.ticketTypes];
                            next[i] = { ...t, quantity: e.target.value };
                            set("ticketTypes", next);
                          }}
                          className="rounded-none"
                          data-testid={`input-ticket-quantity-${i}`}
                        />
                      </div>
                      <div className="md:col-span-3">
                        <Label className="text-xs">DESCRIPTION (optional)</Label>
                        <Input
                          value={t.description}
                          onChange={(e) => {
                            const next = [...v.ticketTypes];
                            next[i] = { ...t, description: e.target.value };
                            set("ticketTypes", next);
                          }}
                          className="rounded-none"
                          data-testid={`input-ticket-description-${i}`}
                        />
                      </div>
                      <div className="md:col-span-1 flex items-end justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => set("ticketTypes", v.ticketTypes.filter((_, j) => j !== i))}
                          className="rounded-none text-destructive hover:bg-destructive/10"
                          title={t.id != null ? "Remove (archived if any were sold; holders keep their tickets)" : "Remove"}
                          data-testid={`button-remove-ticket-type-${i}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-4">
                    <Label className="text-xs">TICKET MONEY GOES TO</Label>
                    <select
                      value={v.ticketPayoutMode}
                      onChange={(e) => set("ticketPayoutMode", e.target.value as EventCreateInputTicketPayoutMode)}
                      className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
                      data-testid="select-ticket-payout-mode"
                    >
                      <option value="runner">EVENT RUNNER</option>
                      <option value="sink">NIGHT CITY BOT (money sink)</option>
                    </select>
                  </div>
                  {v.ticketPayoutMode === "runner" && (
                    <div className="md:col-span-8">
                      <RunnerPicker
                        userId={v.ticketRunnerUserId}
                        userName={v.ticketRunnerName}
                        onPick={(id, name) =>
                          setV((p) => ({ ...p, ticketRunnerUserId: id, ticketRunnerName: name }))
                        }
                      />
                    </div>
                  )}
                </div>
                {!ticketRowsValid && (
                  <p className="text-destructive text-[10px]" data-testid="text-ticket-rows-invalid">
                    Every ticket type needs a name and a non-negative price.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="md:col-span-12 flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={busy || !v.title.trim() || !v.startAt || !v.endAt || endBeforeStart || !ticketRowsValid}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-save-event"
            >
              {busy ? "SAVING..." : eventId != null ? "SAVE CHANGES" : "CREATE EVENT"}
            </Button>
            {eventId != null && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Cancel this event? It will be removed from the calendar and Discord.")) {
                    cancel.mutate({ id: eventId });
                  }
                }}
                className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
                data-testid="button-cancel-event"
              >
                <Trash2 className="w-4 h-4 mr-1" /> {cancel.isPending ? "CANCELLING..." : "CANCEL EVENT"}
              </Button>
            )}
            {errMsg && (
              <span className="text-destructive text-xs" data-testid="text-event-error">
                {errMsg}
              </span>
            )}
          </div>
        </form>
      </CardContent>
      <Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
        <DialogContent className="rounded-none font-mono" data-testid="dialog-edit-scope">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest">EDIT RECURRING EVENT</DialogTitle>
            <DialogDescription>
              This event repeats. Apply your changes to every occurrence, or just one?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="edit-scope"
                checked={scope === "series"}
                onChange={() => setScope("series")}
                data-testid="radio-scope-series"
              />
              <span>All occurrences (edit the whole series)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="edit-scope"
                checked={scope === "occurrence"}
                onChange={() => {
                  setScope("occurrence");
                  if (!scopeOcc && upcomingOccurrences.length > 0) {
                    setScopeOcc(upcomingOccurrences[0].toISOString());
                  }
                }}
                data-testid="radio-scope-occurrence"
              />
              <span>Just one occurrence</span>
            </label>
            {scope === "occurrence" && (
              <div className="pl-6 space-y-2">
                {upcomingOccurrences.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No upcoming occurrences found.</p>
                ) : (
                  <select
                    className="w-full border border-border bg-background px-2 py-1.5 text-sm"
                    value={scopeOcc ?? ""}
                    onChange={(e) => setScopeOcc(e.target.value)}
                    data-testid="select-scope-occurrence"
                  >
                    {upcomingOccurrences.map((d) => (
                      <option key={d.toISOString()} value={d.toISOString()}>
                        {d.toLocaleString([], {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-muted-foreground">
                  That occurrence becomes its own standalone event with your changes; the rest of the
                  series stays as-is. Ticket tiers always stay on the series.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-none"
              onClick={() => setScopeOpen(false)}
              data-testid="button-scope-cancel"
            >
              CANCEL
            </Button>
            <Button
              type="button"
              className="rounded-none"
              disabled={busy || (scope === "occurrence" && !scopeOcc)}
              onClick={confirmScope}
              data-testid="button-scope-confirm"
            >
              {update.isPending ? "SAVING..." : "SAVE"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
