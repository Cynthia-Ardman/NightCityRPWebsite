import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVrchatInstances,
  getListVrchatInstancesQueryKey,
  useListEvents,
  useGetVrchatSession,
  getGetVrchatSessionQueryKey,
  useConnectVrchatSession,
  useVerifyVrchatSession,
  type VrchatInstance,
  type VrchatInstanceAccessType,
  type EventView,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExternalLink, Globe, Users, Radio, Plug, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { expandOccurrences } from "@/lib/eventRecurrence";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useToast } from "@/hooks/use-toast";

// How VRChat access types map to the kind of in-character activity that tends to
// run in them. Public/plus instances are open social spaces; members/invite/
// friends-gated instances are where curated mission play happens. This drives
// the event-matching heuristic below.
type ActivityCategory = "social" | "mission" | "unknown";

function accessCategory(t: VrchatInstanceAccessType): ActivityCategory {
  switch (t) {
    case "group_public":
    case "group_plus":
    case "public":
      return "social";
    case "group_members":
    case "invite_plus":
    case "friends_plus":
    case "invite":
      return "mission";
    default:
      return "unknown";
  }
}

const ACCESS_LABEL: Record<VrchatInstanceAccessType, string> = {
  group_public: "Public",
  group_plus: "Group+",
  group_members: "Members",
  invite_plus: "Invite+",
  friends_plus: "Friends+",
  invite: "Invite",
  public: "Public",
  unknown: "Unknown",
};

// An event's eventType expressed as the activity category it represents, so we
// can line it up against an instance's access category.
function eventCategory(eventType: EventView["eventType"]): ActivityCategory {
  if (eventType === "mission") return "mission";
  if (eventType === "social" || eventType === "session") return "social";
  return "unknown";
}

interface RunningEvent {
  id: number;
  title: string;
  category: ActivityCategory;
}

// Compute the set of scheduled events whose occurrence window contains `now`,
// expanding recurrence rules just like the dashboard/calendar do.
function computeRunningEvents(events: EventView[], now: Date): RunningEvent[] {
  // Look back far enough to catch a long event that began earlier, and forward a
  // touch so an occurrence starting "now" is found.
  const rangeStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rangeEnd = new Date(now.getTime() + 60 * 1000);
  const out: RunningEvent[] = [];
  for (const e of events) {
    if (e.status === "cancelled") continue;
    const base = new Date(e.startAt);
    const end = new Date(e.endAt);
    if (Number.isNaN(base.getTime()) || Number.isNaN(end.getTime())) continue;
    const durationMs = Math.max(0, end.getTime() - base.getTime());
    for (const occ of expandOccurrences(base, e.recurrence ?? null, rangeStart, rangeEnd)) {
      const occEnd = occ.getTime() + durationMs;
      if (occ.getTime() <= now.getTime() && now.getTime() <= occEnd) {
        out.push({ id: e.id, title: e.title, category: eventCategory(e.eventType) });
        break;
      }
    }
  }
  return out;
}

// Pick the best running event for an instance. With a single running event we
// attribute it directly; when several run at once we disambiguate using the
// instance's access category (open instance ↔ social event, gated instance ↔
// mission event). If that still leaves it ambiguous, we show nothing rather
// than guess.
function matchEvent(instance: VrchatInstance, running: RunningEvent[]): RunningEvent | null {
  if (running.length === 0) return null;
  if (running.length === 1) return running[0];
  const cat = accessCategory(instance.accessType);
  if (cat === "unknown") return null;
  const matches = running.filter((r) => r.category === cat);
  return matches.length === 1 ? matches[0] : null;
}

function formatUptime(firstSeenAt: string, now: Date): string {
  const start = new Date(firstSeenAt);
  if (Number.isNaN(start.getTime())) return "—";
  const mins = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Staff-only card to (re)establish the VRChat poller session. VRChat forces an
// emailed one-time code for logins from this server's datacenter IP, so the
// handshake can't be fully automated: a staffer clicks Connect (which makes
// VRChat email a code to the account), then pastes that code here to finish.
function StaffConnectCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: session } = useGetVrchatSession({
    query: { queryKey: getGetVrchatSessionQueryKey(), refetchInterval: 30000 },
  });
  const [code, setCode] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: getGetVrchatSessionQueryKey() });

  const connect = useConnectVrchatSession({
    mutation: {
      onSuccess: (res) => {
        refresh();
        if (res.status === "connected") {
          toast({ title: "VRChat connected", description: res.displayName ? `Signed in as ${res.displayName}.` : "Session established." });
        } else {
          toast({ title: "Code sent", description: "VRChat emailed a 6-digit code to the account. Enter it below." });
        }
      },
      onError: (err) =>
        toast({
          title: "Connect failed",
          description: (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Could not start the VRChat login.",
          variant: "destructive",
        }),
    },
  });

  const verify = useVerifyVrchatSession({
    mutation: {
      onSuccess: (res) => {
        setCode("");
        refresh();
        toast({ title: "VRChat connected", description: res.displayName ? `Signed in as ${res.displayName}.` : "Session established." });
      },
      onError: (err) =>
        toast({
          title: "Verification failed",
          description: (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "That code was rejected.",
          variant: "destructive",
        }),
    },
  });

  const busy = connect.isPending || verify.isPending;
  const connected = !!session?.connected;
  const pending = !!session?.pending;

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-vrchat-connect">
      <CardHeader>
        <CardTitle className="font-display text-lg flex items-center gap-2">
          <Plug className="w-5 h-5 text-nc-cyan" />
          VRCHAT CONNECTION
          {connected ? (
            <Badge variant="outline" className="rounded-none border-nc-green text-nc-green uppercase flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-none border-nc-magenta text-nc-magenta uppercase flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Offline
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          {connected
            ? `The poller is signed in${session?.displayName ? ` as ${session.displayName}` : ""}. Reconnect only if it drops.`
            : "Sign the poller into VRChat. Click Connect, then paste the 6-digit code VRChat emails to the account."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!session?.configured ? (
          <p className="font-mono text-xs text-nc-magenta" data-testid="text-connect-unconfigured">
            VRChat credentials aren't configured on the server yet.
          </p>
        ) : null}
        {session?.lastError ? (
          <p className="font-mono text-xs text-nc-magenta break-words" data-testid="text-connect-error">
            Last error: {session.lastError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => connect.mutate()}
            disabled={busy || !session?.configured}
            className="rounded-none bg-nc-cyan text-black hover:bg-nc-cyan/80 font-display uppercase"
            data-testid="button-vrchat-connect"
          >
            {connect.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plug className="w-4 h-4 mr-1" />}
            {connected ? "Reconnect" : pending ? "Resend code" : "Connect"}
          </Button>
        </div>
        {pending && !connected ? (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <div className="space-y-1">
              <label className="font-mono text-xs text-muted-foreground block">Email code</label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="123456"
                className="rounded-none w-32 font-mono tracking-widest"
                data-testid="input-vrchat-code"
              />
            </div>
            <Button
              onClick={() => verify.mutate({ data: { code } })}
              disabled={busy || code.length !== 6}
              className="rounded-none bg-nc-green text-black hover:bg-nc-green/80 font-display uppercase"
              data-testid="button-vrchat-verify"
            >
              {verify.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Verify
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function VrchatInstances() {
  const { data: me } = useEffectiveMe();
  const isStaff = !!(me?.isAdmin || me?.isFixer);
  const { data, isLoading, dataUpdatedAt } = useListVrchatInstances({
    query: { queryKey: getListVrchatInstancesQueryKey(), refetchInterval: 60000 },
  });
  const { data: events } = useListEvents();

  const now = useMemo(() => new Date(dataUpdatedAt || Date.now()), [dataUpdatedAt]);
  const running = useMemo(
    () => computeRunningEvents((events ?? []) as EventView[], now),
    [events, now],
  );

  const instances = data?.instances ?? [];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-live-title">
            <Radio className="w-8 h-8 text-nc-green animate-pulse" />
            LIVE INSTANCES
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            Night City RP VRChat group instances that are open right now. Jump straight in from your browser.
          </p>
        </div>
      </div>

      {isStaff ? <StaffConnectCard /> : null}

      {data && !data.configured ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30" data-testid="state-not-configured">
          <Globe className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="font-display text-xl">LIVE BROWSER OFFLINE</h3>
          <p className="font-mono text-muted-foreground text-sm mt-2">
            The VRChat connection isn't configured yet. Check back soon.
          </p>
        </div>
      ) : isLoading ? (
        <div className="text-nc-green font-display animate-pulse">SCANNING NIGHT CITY...</div>
      ) : instances.length === 0 ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30" data-testid="state-empty">
          <Globe className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="font-display text-xl">NO OPEN INSTANCES</h3>
          <p className="font-mono text-muted-foreground text-sm mt-2">
            Nobody's online in a group instance right now. The streets are quiet.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {instances.map((inst) => {
            const event = matchEvent(inst, running);
            const cat = accessCategory(inst.accessType);
            return (
              <Card
                key={inst.location}
                className="rounded-none border-border bg-card/50 hover:border-nc-green transition-all h-full overflow-hidden flex flex-col"
                data-testid={`card-instance-${inst.instanceShortId}`}
              >
                {inst.thumbnailUrl ? (
                  <div className="w-full h-40 overflow-hidden border-b border-border bg-black/30 relative">
                    <img
                      src={inst.thumbnailUrl}
                      alt={`${inst.worldName} thumbnail`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      data-testid={`img-instance-${inst.instanceShortId}`}
                    />
                    <Badge className="absolute top-2 left-2 rounded-none border-nc-green bg-black/70 text-nc-green uppercase flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {inst.userCount}
                      {inst.capacity ? `/${inst.capacity}` : ""}
                    </Badge>
                  </div>
                ) : (
                  <div className="w-full h-40 flex items-center justify-center border-b border-border bg-card/30">
                    <Globe className="w-10 h-10 text-muted-foreground opacity-30" />
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="font-display text-xl line-clamp-1">{inst.worldName}</CardTitle>
                  <CardDescription className="font-mono text-xs flex items-center gap-2">
                    <span className="text-muted-foreground">#{inst.instanceShortId}</span>
                    <Badge
                      variant="outline"
                      className={`rounded-none uppercase ${cat === "mission" ? "border-nc-magenta text-nc-magenta" : "border-nc-cyan text-nc-cyan"}`}
                    >
                      {ACCESS_LABEL[inst.accessType]}
                    </Badge>
                  </CardDescription>
                  {event ? (
                    <CardDescription
                      className="font-mono text-xs text-nc-green pt-1"
                      data-testid={`text-instance-event-${inst.instanceShortId}`}
                    >
                      ● {event.title}
                    </CardDescription>
                  ) : null}
                </CardHeader>
                <CardContent className="mt-auto flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground" data-testid={`text-instance-uptime-${inst.instanceShortId}`}>
                    UP {formatUptime(inst.firstSeenAt, now)}
                    {inst.region ? ` · ${inst.region.toUpperCase()}` : ""}
                  </span>
                  <a href={inst.launchUrl} target="_blank" rel="noopener noreferrer">
                    <Button
                      size="sm"
                      className="rounded-none bg-nc-green text-black hover:bg-nc-green/80 font-display uppercase"
                      data-testid={`button-join-${inst.instanceShortId}`}
                    >
                      Join <ExternalLink className="w-3 h-3 ml-1" />
                    </Button>
                  </a>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
