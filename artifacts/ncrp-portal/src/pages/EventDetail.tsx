import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEvent,
  useSignUpAsEventNpc,
  useWithdrawEventNpcSignup,
  useListMyCharacters,
  useCreateActorPayout,
  getGetEventQueryKey,
  getListEventsQueryKey,
  getGetActorPayoutsQueryKey,
  type EventView,
  type EventSignupView,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  PartyPopper,
  ArrowLeft,
  CalendarDays,
  MapPin,
  Users,
  Pencil,
  AlertTriangle,
  Clock,
} from "lucide-react";
import Markdown from "@/components/Markdown";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Request failed" : null);
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  session: "Session",
  social: "Social",
  other: "Event",
};

function fmtRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime())) return "—";
  const date = start.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" });
  const startTime = start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (Number.isNaN(end.getTime())) return `${date} · ${startTime}`;
  const endTime = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${startTime} – ${endTime}`;
}

export default function EventDetail() {
  const { id } = useParams();
  const eventId = Number(id);
  const { data, isLoading, error } = useGetEvent(eventId, {
    query: { enabled: Number.isInteger(eventId), queryKey: getGetEventQueryKey(eventId) },
  });

  if (isLoading) {
    return <div className="max-w-7xl mx-auto font-mono text-nc-cyan animate-pulse">Loading event...</div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-7xl mx-auto space-y-4">
        <Link
          href="/directory/calendar"
          className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" /> back to calendar
        </Link>
        <div className="font-mono text-destructive">Event not found or you don't have access.</div>
      </div>
    );
  }

  return <EventDetailView data={data} />;
}

function EventDetailView({ data }: { data: EventView }) {
  const cancelled = data.status === "cancelled";
  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link
        href="/directory/calendar"
        className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1"
        data-testid="link-back-calendar"
      >
        <ArrowLeft className="w-4 h-4" /> back to calendar
      </Link>

      {data.canManage && <MissionTestModeBanner />}

      {data.imageUrl && (
        <div className="w-full overflow-hidden border border-border rounded-none bg-card/40">
          <img src={data.imageUrl} alt={data.title} className="w-full max-h-72 object-cover" />
        </div>
      )}

      <div>
        <div className="flex items-center gap-3 text-nc-cyan">
          <PartyPopper className="w-6 h-6" />
          <span className="font-display text-xs uppercase tracking-widest">Event</span>
        </div>
        <h1
          className="text-3xl md:text-4xl font-display text-foreground tracking-wider mt-1"
          data-testid="text-event-title"
        >
          {data.title}
        </h1>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          <Badge
            variant="outline"
            className="rounded-none font-bold tracking-widest uppercase border-nc-cyan text-nc-cyan"
          >
            {EVENT_TYPE_LABEL[data.eventType] ?? "Event"}
          </Badge>
          {cancelled && (
            <Badge
              variant="outline"
              className="rounded-none font-bold tracking-widest uppercase border-destructive text-destructive"
              data-testid="badge-cancelled"
            >
              Cancelled
            </Badge>
          )}
          {data.needsNpcs && (
            <Badge
              variant="outline"
              className="rounded-none font-bold tracking-widest uppercase border-nc-magenta text-nc-magenta"
            >
              Needs NPCs
            </Badge>
          )}
        </div>
      </div>

      {data.canManage && (
        <div className="flex flex-wrap items-center gap-3 border border-border bg-card/40 p-3">
          <Link
            href={`/fixer/events?edit=${data.id}`}
            className="rounded-none border border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 font-display tracking-widest inline-flex items-center gap-1 px-4 py-2 text-sm"
            data-testid="button-edit-event"
          >
            <Pencil className="w-4 h-4" /> EDIT EVENT
          </Link>
          {data.discordSyncError && (
            <span
              className="font-mono text-xs text-nc-yellow inline-flex items-center gap-1"
              data-testid="text-discord-sync-error"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Discord sync issue: {data.discordSyncError}
            </span>
          )}
          {!data.discordSyncError && data.hasDiscordEvent && (
            <span className="font-mono text-xs text-muted-foreground inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 shrink-0" /> Linked to a Discord scheduled event.
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-sm">
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <CalendarDays className="w-4 h-4 shrink-0" />
          <span data-testid="text-event-when">{fmtRange(data.startAt, data.endAt)}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <MapPin className="w-4 h-4 shrink-0" />
          <span>{data.location || <span className="italic">No location</span>}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <Users className="w-4 h-4 shrink-0" />
          <span>
            {data.signupCount} NPC{data.signupCount === 1 ? "" : "s"} signed up
          </span>
        </div>
      </div>

      {data.description && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
              Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown className="font-mono text-sm text-foreground">{data.description}</Markdown>
          </CardContent>
        </Card>
      )}

      {/* NPC sign-up — only when the event needs NPCs and isn't cancelled, OR the
          viewer already signed up (so they can see/withdraw their status). */}
      <NpcSignupSection data={data} />

      {/* Roster — managers only (mirrors the server, which only returns the full
          signups list to fixers/admins). */}
      {data.canManage && <NpcRoster event={data} signups={data.signups ?? []} />}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Organizer
          </CardTitle>
        </CardHeader>
        <CardContent className="font-mono text-sm">
          {data.createdByName ? (
            data.createdById ? (
              // users.id IS the organizer's Discord snowflake, so link straight
              // to their Discord profile (same pattern as guidebook author links).
              <a
                href={`https://discord.com/users/${data.createdById}`}
                target="_blank"
                rel="noreferrer"
                className="text-nc-cyan hover:underline"
                data-testid="link-event-organizer"
              >
                {data.createdByName}
              </a>
            ) : (
              <span className="text-foreground" data-testid="text-event-organizer">
                {data.createdByName}
              </span>
            )
          ) : (
            <span className="text-muted-foreground italic">Unknown</span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NpcSignupSection({ data }: { data: EventView }) {
  const qc = useQueryClient();
  // Refresh both this event's detail and the list/calendar (signup counts).
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetEventQueryKey(data.id) });
    qc.invalidateQueries({ queryKey: getListEventsQueryKey() });
  };
  const chars = useListMyCharacters();
  const signUp = useSignUpAsEventNpc({ mutation: { onSuccess: invalidate } });
  const withdraw = useWithdrawEventNpcSignup({ mutation: { onSuccess: invalidate } });

  const [characterId, setCharacterId] = useState<number | "">("");
  const [note, setNote] = useState("");

  const mine = data.mySignup;
  const err = errOf(signUp.error) ?? errOf(withdraw.error);
  const open = data.needsNpcs && data.status !== "cancelled";

  if (mine) {
    return (
      <Card className="rounded-none border-border bg-card/50" data-testid="block-my-npc-signup">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Your NPC Sign-up
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 font-mono text-sm">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="rounded-none text-[10px] border-nc-magenta text-nc-magenta bg-nc-magenta/10"
            >
              Signed up
            </Badge>
            {mine.characterName && <span className="text-foreground">{mine.characterName}</span>}
          </div>
          {mine.note && <p className="text-muted-foreground whitespace-pre-wrap">{mine.note}</p>}
          {open && (
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

  if (!open) return null;

  return (
    <Card className="rounded-none border-border bg-nc-magenta/5 border-nc-magenta/40" data-testid="block-npc-signup">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-nc-magenta">
          Sign Up as an NPC
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        {data.npcBlurb ? (
          <p className="text-muted-foreground whitespace-pre-wrap" data-testid="text-npc-blurb">
            {data.npcBlurb}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">Volunteer to play an NPC at this event.</p>
        )}
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
        <div>
          <Label className="text-xs">NOTE (optional)</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="rounded-none"
            placeholder="Anything the organizer should know…"
            data-testid="input-npc-note"
          />
        </div>
        <Button
          type="button"
          disabled={signUp.isPending}
          onClick={() =>
            signUp.mutate(
              {
                id: data.id,
                data: { characterId: characterId === "" ? null : Number(characterId), note: note || null },
              },
              {
                onSuccess: () => {
                  setCharacterId("");
                  setNote("");
                },
              },
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

function NpcRoster({ event, signups }: { event: EventView; signups: EventSignupView[] }) {
  const qc = useQueryClient();
  const pay = useCreateActorPayout({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetActorPayoutsQueryKey() }) },
  });
  const [amount, setAmount] = useState(0);

  // One payout per distinct user, even if they signed up more than once.
  const userIds = Array.from(new Set(signups.map((s) => s.userId).filter((x): x is string => !!x)));
  const payErr = errOf(pay.error);
  const canPay = userIds.length > 0 && amount > 0 && !pay.isPending;
  const submitPay = () =>
    pay.mutate({
      data: {
        eventName: event.title,
        eventType: event.eventType,
        eventDate: event.startAt,
        userIds,
        amount,
      },
    });

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          NPC Sign-ups ({signups.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {signups.length === 0 ? (
          <p className="font-mono text-muted-foreground italic">No NPC sign-ups yet.</p>
        ) : (
          <ul className="divide-y divide-border/40 font-mono text-sm">
            {signups.map((s) => (
              <li key={s.id} className="py-2 flex flex-col gap-0.5" data-testid={`row-signup-${s.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-foreground">{s.userName ?? "(unknown)"}</span>
                  {s.characterName && (
                    <span className="text-nc-cyan text-xs">as {s.characterName}</span>
                  )}
                </div>
                {s.note && <p className="text-muted-foreground text-xs whitespace-pre-wrap">{s.note}</p>}
              </li>
            ))}
          </ul>
        )}

        {/* Pay everyone who signed up, in one click — no need to re-type names on
            the Pay Actors page. Pays each distinct signup the same flat fee and
            records it under ACTOR PAYMENTS on the reports page. */}
        {userIds.length > 0 && (
          <div className="mt-4 border-t border-border/40 pt-4 space-y-3" data-testid="block-pay-npcs">
            <div className="font-display tracking-widest text-xs uppercase text-nc-magenta">
              Pay these NPCs
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              Pay every signed-up NPC the same flat fee for this event ({userIds.length} actor
              {userIds.length === 1 ? "" : "s"}). Re-paying the same event won't double up.
            </p>
            <div className="flex flex-wrap items-end gap-3 font-mono text-sm">
              <div className="space-y-1">
                <Label className="text-xs">FEE PER NPC €$</Label>
                <Input
                  type="number"
                  min={0}
                  value={amount || ""}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  className="rounded-none w-40"
                  data-testid="input-npc-pay-amount"
                />
              </div>
              <Button
                type="button"
                disabled={!canPay}
                onClick={submitPay}
                className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                data-testid="button-pay-npcs"
              >
                {pay.isPending ? "PAYING..." : `PAY ${userIds.length} NPC${userIds.length === 1 ? "" : "S"}`}
              </Button>
              {pay.data && (
                <span className="text-xs text-muted-foreground" data-testid="text-npc-pay-result">
                  {pay.data.result.live
                    ? `Paid ${pay.data.result.paid}, failed ${pay.data.result.failed}.`
                    : `Simulated ${pay.data.result.simulated} (Test mode — no real payout).`}
                </span>
              )}
            </div>
            {payErr && (
              <div className="text-destructive text-xs" data-testid="text-npc-pay-error">
                {payErr}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
