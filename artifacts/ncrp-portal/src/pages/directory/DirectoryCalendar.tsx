import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListMissions,
  useListEvents,
  getListMissionsQueryKey,
  getListEventsQueryKey,
  type MissionSummary,
  type EventView,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Button } from "@/components/ui/button";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Briefcase, PartyPopper } from "lucide-react";
import ErrorBoundary from "@/components/ErrorBoundary";

type CalKind = "mission" | "event";

interface CalItem {
  kind: CalKind;
  id: number;
  title: string;
  start: Date;
  href: string;
  subtype: string; // tier label or event type
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  session: "Session",
  social: "Social",
  other: "Event",
};

export default function DirectoryCalendar() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);

  const missionsQ = useListMissions(undefined, {
    query: { queryKey: getListMissionsQueryKey() },
  });
  const eventsQ = useListEvents(undefined, {
    query: { queryKey: getListEventsQueryKey() },
  });

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  // Build a flat list of calendar items from both sources. Missions and events
  // are filtered to those with a real start time; cancelled missions are hidden
  // (the events endpoint already excludes cancelled events server-side).
  const items = useMemo<CalItem[]>(() => {
    const out: CalItem[] = [];
    for (const m of (missionsQ.data ?? []) as MissionSummary[]) {
      if (!m.startAt) continue;
      if (m.status === "cancelled") continue;
      const start = new Date(m.startAt);
      if (Number.isNaN(start.getTime())) continue;
      out.push({
        kind: "mission",
        id: m.id,
        title: m.title,
        start,
        href: `/missions/${m.id}`,
        subtype: `Tier ${m.tier}`,
      });
    }
    for (const e of (eventsQ.data ?? []) as EventView[]) {
      const start = new Date(e.startAt);
      if (Number.isNaN(start.getTime())) continue;
      out.push({
        kind: "event",
        id: e.id,
        title: e.title,
        start,
        href: `/events/${e.id}`,
        subtype: EVENT_TYPE_LABEL[e.eventType] ?? "Event",
      });
    }
    return out;
  }, [missionsQ.data, eventsQ.data]);

  // Bucket items by local-day key for O(1) lookup while rendering the grid.
  const byDay = useMemo(() => {
    const map = new Map<string, CalItem[]>();
    for (const it of items) {
      const key = dayKey(it.start);
      const list = map.get(key) ?? [];
      list.push(it);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start.getTime() - b.start.getTime());
    }
    return map;
  }, [items]);

  // Compute the 6-week grid (42 cells) that covers the visible month, padded by
  // leading/trailing days from adjacent months so each week is a full row.
  const cells = useMemo(() => {
    const first = startOfMonth(cursor);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      out.push(d);
    }
    return out;
  }, [cursor]);

  const today = new Date();
  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const loading = missionsQ.isLoading || eventsQ.isLoading;

  return (
    <div className="max-w-[1600px] mx-auto space-y-6 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-display text-nc-cyan tracking-widest flex items-center gap-3">
            <CalendarDays className="w-7 h-7" /> CALENDAR
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Every scheduled mission and event in Night City, shown in your local time.
          </p>
        </div>
        {isStaff && (
          <Link href="/fixer/events">
            <Button
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-create-event"
            >
              <Plus className="w-4 h-4 mr-1" /> CREATE EVENT
            </Button>
          </Link>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border border-border bg-card/40 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-none font-display tracking-widest"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
          data-testid="button-prev-month"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-3">
          <span className="font-display text-xl tracking-widest text-foreground" data-testid="text-month-label">
            {monthLabel.toUpperCase()}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-none font-mono text-xs text-nc-cyan"
            onClick={() => setCursor(startOfMonth(new Date()))}
            data-testid="button-today"
          >
            TODAY
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-none font-display tracking-widest"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
          data-testid="button-next-month"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 bg-nc-magenta/30 border border-nc-magenta/60" /> Mission
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 bg-nc-cyan/30 border border-nc-cyan/60" /> Event
        </span>
      </div>

      {loading ? (
        <div className="font-mono text-nc-cyan animate-pulse">Loading calendar...</div>
      ) : (
        <ErrorBoundary>
          <div className="border border-border bg-card/20">
            <div className="grid grid-cols-7 border-b border-border">
              {WEEKDAYS.map((w) => (
                <div
                  key={w}
                  className="px-2 py-2 text-center font-display text-xs tracking-widest text-muted-foreground uppercase"
                >
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d, i) => {
                const inMonth = d.getMonth() === cursor.getMonth();
                const isToday = sameDay(d, today);
                const dayItems = byDay.get(dayKey(d)) ?? [];
                return (
                  <div
                    key={i}
                    className={`min-h-[7rem] border-b border-r border-border/50 p-1.5 flex flex-col gap-1 ${
                      inMonth ? "" : "bg-background/40"
                    } ${(i + 1) % 7 === 0 ? "border-r-0" : ""}`}
                    data-testid={`cell-day-${dayKey(d)}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`font-mono text-xs ${
                          isToday
                            ? "bg-nc-cyan text-background px-1.5 py-0.5 font-bold"
                            : inMonth
                              ? "text-foreground"
                              : "text-muted-foreground/50"
                        }`}
                      >
                        {d.getDate()}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {dayItems.map((it) => (
                        <CalChip key={`${it.kind}-${it.id}`} item={it} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </ErrorBoundary>
      )}
    </div>
  );
}

function CalChip({ item }: { item: CalItem }) {
  const time = item.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isMission = item.kind === "mission";
  const cls = isMission
    ? "bg-nc-magenta/20 border-nc-magenta/50 hover:bg-nc-magenta/30 text-nc-magenta"
    : "bg-nc-cyan/20 border-nc-cyan/50 hover:bg-nc-cyan/30 text-nc-cyan";
  const Icon = isMission ? Briefcase : PartyPopper;
  return (
    <Link
      href={item.href}
      className={`block border rounded-none px-1.5 py-1 transition-colors ${cls}`}
      data-testid={`chip-${item.kind}-${item.id}`}
      title={`${item.title} · ${item.subtype} · ${time}`}
    >
      <div className="flex items-center gap-1 font-mono text-[10px] leading-tight">
        <Icon className="w-3 h-3 shrink-0" />
        <span className="opacity-70">{time}</span>
      </div>
      <div className="font-mono text-[11px] leading-tight text-foreground truncate">{item.title}</div>
    </Link>
  );
}
