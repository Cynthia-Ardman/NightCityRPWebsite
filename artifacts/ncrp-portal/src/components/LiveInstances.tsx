import { useMemo } from "react";
import {
  useListVrchatInstances,
  getListVrchatInstancesQueryKey,
  useListEvents,
  type VrchatInstance,
  type VrchatInstanceAccessType,
  type EventView,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, Globe, Users, Radio, ShieldCheck } from "lucide-react";
import { expandOccurrences } from "@/lib/eventRecurrence";

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
    for (const occ of expandOccurrences(base, e.recurrence ?? null, rangeStart, rangeEnd, e.excludedOccurrences)) {
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

// Live VRChat instances surfaced on the dashboard. Renders NOTHING when no group
// instance is currently open, so the dashboard stays clean until the streets
// light up. When at least one instance is live, it shows the joinable card grid.
export default function LiveInstances() {
  const { data, dataUpdatedAt } = useListVrchatInstances({
    query: { queryKey: getListVrchatInstancesQueryKey(), refetchInterval: 60000 },
  });
  const { data: events } = useListEvents();

  const now = useMemo(() => new Date(dataUpdatedAt || Date.now()), [dataUpdatedAt]);
  const running = useMemo(
    () => computeRunningEvents((events ?? []) as EventView[], now),
    [events, now],
  );

  const instances = data?.instances ?? [];
  // Total players across every open group instance — surfaced big on the banner
  // so members can see how busy the city is at a glance.
  const totalPlayers = instances.reduce((sum, i) => sum + (i.userCount ?? 0), 0);

  // Core requirement: invisible when nothing is live.
  if (instances.length === 0) return null;

  return (
    <section className="space-y-4" data-testid="section-live-instances">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display text-foreground flex items-center gap-3" data-testid="text-live-title">
            <Radio className="w-6 h-6 text-nc-green animate-pulse" />
            LIVE INSTANCES
          </h2>
          <p className="font-mono text-muted-foreground text-sm mt-1">
            Night City RP VRChat group instances open right now. Jump straight in from your browser.
          </p>
        </div>
        {totalPlayers > 0 && (
          <div
            className="flex items-center gap-3 border border-nc-green/40 bg-nc-green/5 px-5 py-2 shadow-[0_0_18px_hsl(var(--nc-green)/0.25)]"
            data-testid="text-live-total-players"
          >
            <Users className="w-7 h-7 text-nc-green shrink-0" />
            <div className="leading-none">
              <div className="font-display text-4xl font-bold text-nc-green tabular-nums">
                {totalPlayers.toLocaleString()}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-nc-green/70 mt-1">
                {totalPlayers === 1 ? "Player in the city" : "Players in the city"}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
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
              <CardHeader className="items-center text-center">
                <CardTitle className="font-display text-xl line-clamp-1">{inst.worldName}</CardTitle>
                <CardDescription className="font-mono text-xs flex items-center justify-center gap-2">
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
                {inst.roleNames.length > 0 ? (
                  <div
                    className="flex flex-wrap items-center justify-center gap-1 pt-2"
                    data-testid={`roles-instance-${inst.instanceShortId}`}
                  >
                    <ShieldCheck className="w-3 h-3 text-nc-orange shrink-0" />
                    {inst.roleNames.map((role) => (
                      <Badge
                        key={role}
                        variant="outline"
                        className="rounded-none border-nc-orange/60 text-nc-orange font-mono text-[10px] uppercase tracking-wide"
                      >
                        {role}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="mt-auto flex flex-col items-center gap-4 text-center">
                <span className="font-mono text-xs text-muted-foreground" data-testid={`text-instance-uptime-${inst.instanceShortId}`}>
                  UP {formatUptime(inst.firstSeenAt, now)}
                  {inst.region ? ` · ${inst.region.toUpperCase()}` : ""}
                </span>
                <a href={inst.launchUrl} target="_blank" rel="noopener noreferrer">
                  <Button
                    className="rounded-none h-16 px-12 text-2xl font-display uppercase tracking-wide bg-nc-green text-black hover:bg-nc-green/90 shadow-[0_0_28px_hsl(var(--nc-green)/0.6)] hover:shadow-[0_0_44px_hsl(var(--nc-green)/0.85)] transition-shadow"
                    data-testid={`button-join-${inst.instanceShortId}`}
                  >
                    Join <ExternalLink className="w-6 h-6 ml-2" />
                  </Button>
                </a>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
