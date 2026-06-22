import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEvent,
  useSignUpAsEventNpc,
  useWithdrawEventNpcSignup,
  useConfirmEventNpcSignup,
  useListMyCharacters,
  useConvertEventToMission,
  getGetEventQueryKey,
  getListEventsQueryKey,
  getListMissionsQueryKey,
  type EventView,
  type EventSignupView,
  type EventToMissionConvertInput,
  type EventToMissionConvertInputTier,
  type EventToMissionConvertInputJobType,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  PartyPopper,
  ArrowLeft,
  CalendarDays,
  MapPin,
  Users,
  Pencil,
  AlertTriangle,
  Clock,
  Briefcase,
} from "lucide-react";
import Markdown from "@/components/Markdown";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";
import { useToast } from "@/hooks/use-toast";

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

const CONVERT_TIER_OPTIONS: { value: EventToMissionConvertInputTier; label: string }[] = [
  { value: 1, label: "Tier 1" },
  { value: 2, label: "Tier 2" },
  { value: 3, label: "Tier 3" },
  { value: 4, label: "Tier 4" },
];

const CONVERT_JOB_TYPE_OPTIONS: { value: EventToMissionConvertInputJobType | ""; label: string }[] = [
  { value: "", label: "— none —" },
  { value: "combat", label: "Combat" },
  { value: "non_combat", label: "Non-Combat" },
  { value: "mixed", label: "Mixed" },
];

// Convert (replace) this event into a mission. The original event is soft-
// cancelled and its linked Discord scheduled event is handed off to the new
// mission row — no Discord teardown, no calendar duplicate. Collects the
// mission-only fields the event doesn't carry (tier, pay, slots, etc.).
function ConvertToMissionDialog({ event }: { event: EventView }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<EventToMissionConvertInputTier>(1);
  const [playerPay, setPlayerPay] = useState("0");
  const [npcPayAmount, setNpcPayAmount] = useState("0");
  const [slots, setSlots] = useState("0");
  const [maxPlayers, setMaxPlayers] = useState("0");
  const [jobType, setJobType] = useState<EventToMissionConvertInputJobType | "">("");
  const [worldLink, setWorldLink] = useState("");
  const [requestedSkills, setRequestedSkills] = useState("");
  const [client, setClient] = useState("");
  const [notesForPlayers, setNotesForPlayers] = useState("");

  const convert = useConvertEventToMission();
  const qc = useQueryClient();

  function num(v: string): number {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function submit() {
    const data: EventToMissionConvertInput = {
      tier,
      playerPay: num(playerPay),
      npcPayAmount: num(npcPayAmount),
      slots: num(slots),
      maxPlayers: num(maxPlayers),
      ...(jobType ? { jobType } : {}),
      ...(worldLink.trim() ? { worldLink: worldLink.trim() } : {}),
      ...(requestedSkills.trim() ? { requestedSkills: requestedSkills.trim() } : {}),
      ...(client.trim() ? { client: client.trim() } : {}),
      ...(notesForPlayers.trim() ? { notesForPlayers: notesForPlayers.trim() } : {}),
    };
    convert.mutate(
      { id: event.id, data },
      {
        onSuccess: (mission) => {
          qc.invalidateQueries({ queryKey: getGetEventQueryKey(event.id) });
          qc.invalidateQueries({ queryKey: getListEventsQueryKey() });
          qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
          toast({ title: "Converted to mission", description: `"${event.title}" is now a mission.` });
          setOpen(false);
          navigate(`/missions/${mission.id}`);
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
        onClick={() => setOpen(true)}
        className="rounded-none border-nc-magenta text-nc-magenta hover:bg-nc-magenta/10 font-display tracking-widest inline-flex items-center gap-1"
        data-testid="button-convert-to-mission"
      >
        <Briefcase className="w-4 h-4" /> CONVERT TO MISSION
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none border-border bg-card max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-magenta">Convert to Mission</DialogTitle>
            <DialogDescription className="font-mono text-xs text-muted-foreground">
              This replaces the event with a mission. The event is cancelled and its Discord scheduled event (if any)
              carries over — no duplicate on the calendar. This can't be undone automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">TIER</Label>
              <select
                value={tier}
                onChange={(e) => setTier(Number(e.target.value) as EventToMissionConvertInputTier)}
                className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
                data-testid="select-convert-tier"
              >
                {CONVERT_TIER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">JOB TYPE</Label>
              <select
                value={jobType}
                onChange={(e) => setJobType(e.target.value as EventToMissionConvertInputJobType | "")}
                className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
                data-testid="select-convert-job-type"
              >
                {CONVERT_JOB_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">PLAYER PAY (€$)</Label>
              <Input
                type="number"
                min={0}
                value={playerPay}
                onChange={(e) => setPlayerPay(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-player-pay"
              />
            </div>
            <div>
              <Label className="text-xs">NPC PAY (€$)</Label>
              <Input
                type="number"
                min={0}
                value={npcPayAmount}
                onChange={(e) => setNpcPayAmount(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-npc-pay"
              />
            </div>
            <div>
              <Label className="text-xs">SLOTS</Label>
              <Input
                type="number"
                min={0}
                value={slots}
                onChange={(e) => setSlots(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-slots"
              />
            </div>
            <div>
              <Label className="text-xs">MAX PLAYERS</Label>
              <Input
                type="number"
                min={0}
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-max-players"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">WORLD / JOIN LINK (staff-only)</Label>
              <Input
                value={worldLink}
                onChange={(e) => setWorldLink(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-world-link"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">CLIENT</Label>
              <Input
                value={client}
                onChange={(e) => setClient(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-client"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">REQUESTED SKILLS</Label>
              <Input
                value={requestedSkills}
                onChange={(e) => setRequestedSkills(e.target.value)}
                className="rounded-none"
                data-testid="input-convert-skills"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">NOTES FOR PLAYERS</Label>
              <Textarea
                value={notesForPlayers}
                onChange={(e) => setNotesForPlayers(e.target.value)}
                rows={2}
                className="rounded-none"
                data-testid="input-convert-notes"
              />
            </div>
          </div>

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
              disabled={convert.isPending}
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
          <img src={data.imageUrl} alt={data.title} className="w-full max-h-72 object-contain" />
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
          {data.status !== "cancelled" && <ConvertToMissionDialog event={data} />}
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
          {data.vrchatSyncError && (
            <span
              className="font-mono text-xs text-nc-yellow inline-flex items-center gap-1"
              data-testid="text-vrchat-sync-error"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> VRChat sync issue: {data.vrchatSyncError}
            </span>
          )}
          {!data.vrchatSyncError && data.hasVrchatEvent && (
            <span className="font-mono text-xs text-muted-foreground inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 shrink-0" /> Linked to a VRChat group calendar event.
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

  // Echo an existing sign-up back to the player so they see whether the
  // organizer confirmed attendance (and paid) or marked them a no-show — the
  // same lifecycle players already see on missions.
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
              The organizer marked this sign-up as a no-show — no payout for this one.
            </p>
          )}
          {mine.note && <p className="text-muted-foreground whitespace-pre-wrap">{mine.note}</p>}
          {!resolved && open && (
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

function NpcStateBadge({ state }: { state: EventSignupView["state"] }) {
  const cls =
    state === "attended"
      ? "border-green-500 text-green-400 bg-green-500/10"
      : state === "no_show"
        ? "border-destructive text-destructive bg-destructive/10"
        : "border-nc-magenta text-nc-magenta bg-nc-magenta/10";
  const label =
    state === "attended" ? "Attended" : state === "no_show" ? "No-show" : "Signed up";
  return (
    <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
      {label}
    </Badge>
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
        : status === "simulated"
          ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
          : "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
  const label =
    status === "paid" ? "Paid" : status === "failed" ? "Failed" : status === "simulated" ? "Test" : "Unpaid";
  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
        {label}
        {amount ? ` €$${amount.toLocaleString()}` : ""}
      </Badge>
      {error && (
        <span className="text-[10px] font-mono text-destructive max-w-[12rem] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

// Per-person attendance + pay-once roster. The organizer confirms each NPC as
// attended (paying the single fee in the FEE input) or no-show — mirroring the
// mission NPC roster. The backend dedups per (eventId, userId) so an NPC can
// only ever be paid ONCE for this event; resolved rows show a state/payment
// badge instead of buttons.
function NpcRoster({ event, signups }: { event: EventView; signups: EventSignupView[] }) {
  const qc = useQueryClient();
  const confirm = useConfirmEventNpcSignup({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetEventQueryKey(event.id) });
        qc.invalidateQueries({ queryKey: getListEventsQueryKey() });
      },
    },
  });
  const [amount, setAmount] = useState(0);

  const confirmErr = errOf(confirm.error);
  const outstanding = signups.filter((s) => s.state === "signed_up").length;
  const cancelled = event.status === "cancelled";

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
          Players who volunteered to NPC this event. Confirm attendance to credit each NPC, or mark a no-show. Set a fee
          to pay them, or leave it at 0 for unpaid volunteers. Each NPC can only be paid once for this event.
        </p>
        <div className="flex flex-wrap items-end gap-3">
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
        </div>
        {signups.length === 0 ? (
          <p className="text-muted-foreground italic" data-testid="text-no-npc-signups">
            No NPC sign-ups yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {signups.map((s) => (
              <li key={s.id} className="py-3 flex items-start gap-3" data-testid={`row-signup-${s.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground">{s.userName ?? "(unknown)"}</span>
                    {s.characterName && <span className="text-nc-cyan text-xs">as {s.characterName}</span>}
                  </div>
                  {s.note && <p className="text-muted-foreground text-xs whitespace-pre-wrap">{s.note}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.state === "signed_up" ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={cancelled || amount < 0 || confirm.isPending}
                        onClick={() =>
                          confirm.mutate({ id: event.id, signupId: s.id, data: { action: "attended", amount } })
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
                        disabled={cancelled || confirm.isPending}
                        onClick={() =>
                          confirm.mutate({ id: event.id, signupId: s.id, data: { action: "no_show" } })
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
        {amount <= 0 && outstanding > 0 && (
          <p className="text-muted-foreground text-xs" data-testid="text-fee-optional">
            No fee set — confirming will mark these NPCs as attended (unpaid).
          </p>
        )}
        {confirmErr && (
          <div className="text-destructive text-xs" data-testid="text-confirm-npc-error">
            {confirmErr}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
