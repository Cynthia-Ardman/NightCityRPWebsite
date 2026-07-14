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
  usePurchaseEventTicket,
  useRefundEventTicket,
  useListEventTickets,
  useSetEventTicketAttendance,
  useRetryEventTicketPayout,
  useListEventCheckinStaff,
  useSetEventCheckinStaff,
  useSearchFixerPlayers,
  getGetEventQueryKey,
  getListEventsQueryKey,
  getListMissionsQueryKey,
  getListEventTicketsQueryKey,
  getListMyTicketsQueryKey,
  getListEventCheckinStaffQueryKey,
  getSearchFixerPlayersQueryKey,
  type EventView,
  type EventSignupView,
  type EventTicketView,
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
  Ticket,
  CheckCircle2,
  RotateCcw,
  X,
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

      {/* Tickets — buy + your own tickets (everyone), when the event sells any. */}
      <TicketSection data={data} />

      {/* Check-in roster — managers and designated check-in staff. */}
      {data.canCheckIn && <CheckInRoster event={data} />}

      {/* Check-in staff picker — managers only. */}
      {data.canManage && (data.ticketTypes ?? []).length > 0 && <CheckinStaffEditor event={data} />}

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

function ticketStatusBadge(t: EventTicketView) {
  if (t.status === "refunded") {
    return (
      <Badge variant="outline" className="rounded-none text-[10px] border-destructive text-destructive bg-destructive/10">
        Refunded
      </Badge>
    );
  }
  if (t.attendedAt) {
    return (
      <Badge variant="outline" className="rounded-none text-[10px] border-green-500 text-green-400 bg-green-500/10">
        Checked in
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="rounded-none text-[10px] border-nc-cyan text-nc-cyan bg-nc-cyan/10">
      Valid
    </Badge>
  );
}

// Buy tickets + the viewer's own tickets on this event. Hidden entirely when
// the event has never sold tickets (no types and no owned tickets).
function TicketSection({ data }: { data: EventView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetEventQueryKey(data.id) });
    qc.invalidateQueries({ queryKey: getListMyTicketsQueryKey() });
    qc.invalidateQueries({ queryKey: getListEventTicketsQueryKey(data.id) });
  };
  const purchase = usePurchaseEventTicket({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: res.walletStatus === "dry_run" ? "Ticket reserved (test mode)" : "Ticket purchased",
          description:
            res.ticket.pricePaid > 0
              ? `€$${res.ticket.pricePaid.toLocaleString()} — ${res.ticket.ticketTypeName}`
              : res.ticket.ticketTypeName,
        });
      },
      onError: (e) => {
        toast({ title: "Purchase failed", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });
  const refund = useRefundEventTicket({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Ticket refunded", description: "The money is back in your wallet." });
      },
      onError: (e) => {
        toast({ title: "Refund failed", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });

  const types = data.ticketTypes ?? [];
  const mine = data.myTickets ?? [];
  if (types.length === 0 && mine.length === 0) return null;

  const onSale = data.status === "scheduled";

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="block-tickets">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-nc-cyan inline-flex items-center gap-2">
          <Ticket className="w-4 h-4" /> Tickets
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        {types.filter((t) => !t.archived).length > 0 && (
          <ul className="divide-y divide-border/40">
            {types
              .filter((t) => !t.archived)
              .map((t) => (
                <li key={t.id} className="py-3 flex items-center gap-3" data-testid={`row-ticket-type-${t.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground">{t.name}</span>
                      <span className="text-nc-cyan">{t.price > 0 ? `€$${t.price.toLocaleString()}` : "FREE"}</span>
                      {t.quantity > 0 && (
                        <span className="text-muted-foreground text-xs">
                          {t.soldOut ? "SOLD OUT" : `${t.remaining} left`}
                        </span>
                      )}
                    </div>
                    {t.description && <p className="text-muted-foreground text-xs">{t.description}</p>}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!onSale || t.soldOut || purchase.isPending}
                    onClick={() => purchase.mutate({ id: data.id, data: { ticketTypeId: t.id } })}
                    className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest shrink-0"
                    data-testid={`button-buy-ticket-${t.id}`}
                  >
                    {purchase.isPending ? "BUYING..." : "BUY"}
                  </Button>
                </li>
              ))}
          </ul>
        )}
        {!onSale && types.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Ticket sales are closed — this event is {data.status}.
          </p>
        )}

        {mine.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Your tickets</div>
            <ul className="divide-y divide-border/40">
              {mine.map((t) => (
                <li key={t.id} className="py-2 flex items-center gap-3" data-testid={`row-my-ticket-${t.id}`}>
                  <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
                    <span className="text-foreground">{t.ticketTypeName}</span>
                    <span className="text-muted-foreground text-xs">
                      {t.pricePaid > 0 ? `€$${t.pricePaid.toLocaleString()}` : "free"}
                    </span>
                    {ticketStatusBadge(t)}
                  </div>
                  {t.status === "purchased" && !t.attendedAt && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={refund.isPending}
                      onClick={() => {
                        if (window.confirm("Refund this ticket? The money returns to your wallet.")) {
                          refund.mutate({ id: data.id, ticketId: t.id });
                        }
                      }}
                      className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest shrink-0"
                      data-testid={`button-refund-ticket-${t.id}`}
                    >
                      REFUND
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Attendance roster for managers + designated check-in staff. Check-in is
// idempotent and undoable; refunds are blocked once a ticket is attended.
function CheckInRoster({ event }: { event: EventView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: tickets, isLoading } = useListEventTickets(event.id, {
    query: { queryKey: getListEventTicketsQueryKey(event.id) },
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListEventTicketsQueryKey(event.id) });
    qc.invalidateQueries({ queryKey: getGetEventQueryKey(event.id) });
  };
  const attendance = useSetEventTicketAttendance({
    mutation: {
      onSuccess: invalidate,
      onError: (e) => {
        toast({ title: "Check-in failed", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });
  const retry = useRetryEventTicketPayout({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Payout retried", description: "The runner credit went through." });
      },
      onError: (e) => {
        toast({ title: "Payout retry failed", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });
  const refund = useRefundEventTicket({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Ticket refunded", description: "The buyer got their money back." });
      },
      onError: (e) => {
        toast({ title: "Refund failed", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });

  const rows = (tickets ?? []).filter((t) => t.status !== "refunded");
  const attended = rows.filter((t) => !!t.attendedAt).length;

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="block-checkin-roster">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Ticket Check-in ({attended}/{rows.length} checked in)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        {isLoading ? (
          <p className="text-nc-cyan animate-pulse">Loading tickets…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground italic" data-testid="text-no-tickets-sold">
            No tickets sold yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {rows.map((t) => (
              <li key={t.id} className="py-3 flex items-start gap-3" data-testid={`row-checkin-${t.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground">{t.buyerName ?? t.buyerUserId}</span>
                    <span className="text-nc-cyan text-xs">{t.ticketTypeName}</span>
                    <span className="text-muted-foreground text-xs">
                      {t.pricePaid > 0 ? `€$${t.pricePaid.toLocaleString()}` : "free"}
                    </span>
                    {t.payoutStatus === "failed" && event.canManage && (
                      <Badge
                        variant="outline"
                        className="rounded-none text-[10px] border-nc-yellow text-nc-yellow bg-nc-yellow/10"
                        title={t.payoutError ?? undefined}
                      >
                        Payout failed
                      </Badge>
                    )}
                  </div>
                  {t.attendedAt && (
                    <p className="text-muted-foreground text-xs">
                      Checked in {new Date(t.attendedAt).toLocaleString()}
                      {t.attendedByName ? ` by ${t.attendedByName}` : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {t.payoutStatus === "failed" && event.canManage && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate({ id: event.id, ticketId: t.id })}
                      className="rounded-none border-nc-yellow text-nc-yellow hover:bg-nc-yellow/10 font-display tracking-widest"
                      data-testid={`button-retry-payout-${t.id}`}
                    >
                      <RotateCcw className="w-4 h-4 mr-1" /> RETRY PAYOUT
                    </Button>
                  )}
                  {t.attendedAt ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={attendance.isPending}
                      onClick={() =>
                        attendance.mutate({ id: event.id, ticketId: t.id, data: { attended: false } })
                      }
                      className="rounded-none border-border text-muted-foreground hover:bg-muted/20 font-display tracking-widest"
                      data-testid={`button-undo-checkin-${t.id}`}
                    >
                      <X className="w-4 h-4 mr-1" /> UNDO
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={attendance.isPending}
                        onClick={() =>
                          attendance.mutate({ id: event.id, ticketId: t.id, data: { attended: true } })
                        }
                        className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                        data-testid={`button-checkin-${t.id}`}
                      >
                        <CheckCircle2 className="w-4 h-4 mr-1" /> CHECK IN
                      </Button>
                      {event.canManage && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={refund.isPending}
                          onClick={() => {
                            if (window.confirm("Refund this ticket back to the buyer?")) {
                              refund.mutate({ id: event.id, ticketId: t.id });
                            }
                          }}
                          className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
                          data-testid={`button-staff-refund-${t.id}`}
                        >
                          REFUND
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Managers pick which portal users may run check-in (in addition to fixers/admins).
function CheckinStaffEditor({ event }: { event: EventView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: staff } = useListEventCheckinStaff(event.id, {
    query: { queryKey: getListEventCheckinStaffQueryKey(event.id) },
  });
  const save = useSetEventCheckinStaff({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListEventCheckinStaffQueryKey(event.id) });
        qc.invalidateQueries({ queryKey: getGetEventQueryKey(event.id) });
      },
      onError: (e) => {
        toast({ title: "Couldn't update check-in staff", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });
  const [q, setQ] = useState("");
  const enabled = q.trim().length >= 2;
  const params = { q: q.trim() };
  const search = useSearchFixerPlayers(params, {
    query: { enabled, queryKey: getSearchFixerPlayersQueryKey(params) },
  });

  const current = staff ?? [];
  const setIds = (ids: string[]) => save.mutate({ id: event.id, data: { userIds: ids } });

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="block-checkin-staff">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
          Check-in Staff
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-sm">
        <p className="text-muted-foreground text-xs">
          These players can open the check-in roster and mark ticket holders as attended (fixers/admins always can).
        </p>
        <div className="flex flex-wrap gap-2">
          {current.length === 0 && <span className="text-muted-foreground italic text-xs">No extra staff.</span>}
          {current.map((s) => (
            <Badge
              key={s.userId}
              variant="outline"
              className="rounded-none border-nc-cyan text-nc-cyan inline-flex items-center gap-1"
              data-testid={`badge-checkin-staff-${s.userId}`}
            >
              {s.userName ?? s.userId}
              <button
                type="button"
                onClick={() => setIds(current.filter((c) => c.userId !== s.userId).map((c) => c.userId))}
                className="hover:text-destructive"
                title="Remove"
                data-testid={`button-remove-checkin-staff-${s.userId}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="relative max-w-sm">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Add a player by name…"
            className="rounded-none"
            data-testid="input-checkin-staff-search"
          />
          {enabled && (search.data ?? []).length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 border border-border bg-card max-h-48 overflow-y-auto">
              {(search.data ?? [])
                .filter((p) => !current.some((c) => c.userId === p.id))
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setIds([...current.map((c) => c.userId), p.id]);
                      setQ("");
                    }}
                    className="block w-full text-left px-3 py-2 text-xs hover:bg-nc-cyan/10"
                    data-testid={`option-checkin-staff-${p.id}`}
                  >
                    {p.globalName || p.username}
                  </button>
                ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
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
              onClick={() =>
                withdraw.mutate({
                  id: data.id,
                  // Withdraw only this occurrence's signup (legacy
                  // null-occurrence rows also match server-side).
                  params: { occurrenceStartAt: mine.occurrenceStartAt ?? data.startAt },
                })
              }
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
                // Target the event's current (next) occurrence explicitly so
                // recurring-event signups never bleed onto other occurrences.
                data: {
                  characterId: characterId === "" ? null : Number(characterId),
                  note: note || null,
                  occurrenceStartAt: data.startAt,
                },
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
