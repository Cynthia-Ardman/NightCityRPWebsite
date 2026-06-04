import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEvents,
  useGetEvent,
  useCreateEvent,
  useUpdateEvent,
  useCancelEvent,
  useCheckEventConflicts,
  getCheckEventConflictsQueryKey,
  getListEventsQueryKey,
  type EventCreateInputEventType,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PartyPopper, Trash2 } from "lucide-react";
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

const EVENT_TYPE_OPTIONS: { value: EventCreateInputEventType; label: string }[] = [
  { value: "session", label: "Session" },
  { value: "social", label: "Social" },
  { value: "other", label: "Other" },
];

const EVENT_TYPE_LABEL: Record<string, string> = {
  session: "Session",
  social: "Social",
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
                          {new Date(e.startAt).toLocaleString()}
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
};

const EVENT_DRAFT_KEY = "ncrp:event-create-draft";

function EditEventForm({ eventId, onSaved }: { eventId: number; onSaved: () => void }) {
  const { data, isLoading } = useGetEvent(eventId);
  if (isLoading) return <div className="font-mono text-nc-cyan animate-pulse">Loading event...</div>;
  if (!data) return <div className="font-mono text-destructive">Event not found.</div>;
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
  };
  return <EventForm key={`edit-${eventId}`} eventId={eventId} initial={initial} onSaved={onSaved} />;
}

function EventForm({
  eventId,
  initial,
  onSaved,
}: {
  eventId?: number;
  initial?: FormValues;
  onSaved: () => void;
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.title.trim() || !v.startAt || !v.endAt || endBeforeStart) return;
    const payload = {
      title: v.title.trim(),
      eventType: v.eventType,
      location: v.location || null,
      description: v.description || null,
      imageUrl: v.imageUrl || null,
      startAt: new Date(v.startAt).toISOString(),
      endAt: new Date(v.endAt).toISOString(),
      needsNpcs: v.needsNpcs,
      npcBlurb: v.needsNpcs ? v.npcBlurb || null : null,
    };
    if (eventId != null) {
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
              min={v.startAt || undefined}
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

          <div className="md:col-span-12 flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={busy || !v.title.trim() || !v.startAt || !v.endAt || endBeforeStart}
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
    </Card>
  );
}
