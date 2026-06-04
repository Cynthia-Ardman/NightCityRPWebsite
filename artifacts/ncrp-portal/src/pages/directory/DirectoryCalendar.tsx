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
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Briefcase, PartyPopper, Users, UserPlus, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ErrorBoundary from "@/components/ErrorBoundary";
import { expandOccurrences } from "@/lib/eventRecurrence";
import { useQuickNpcSignup } from "@/lib/useQuickNpcSignup";

type CalKind = "mission" | "event";

// The viewer's personal signup status for an item: confirmed as a player
// (accepted application / assigned character), signed up as an NPC, or neither.
type SignupStatus = "player" | "npc" | null;

type CalFilter = "all" | "mission" | "event";
type CalView = "month" | "week";

interface CalItem {
  kind: CalKind;
  id: number;
  title: string;
  start: Date;
  href: string;
  subtype: string; // tier label or event type
  // Raw event type (session/social/other) for colour coding; undefined for missions.
  eventType?: string;
  myStatus: SignupStatus;
  // Whether this item is accepting NPC sign-ups (event needsNpcs — sessions are
  // always true server-side — or mission npcSignupOpen). Drives the one-tap
  // sign-up affordance shown only when the viewer hasn't already joined.
  npcOpen: boolean;
  // Distinguishes individual occurrences of a recurring event so each renders
  // with a stable, unique key.
  occMs: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // Sunday-start to match the grid columns
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  social: "Social",
  session: "Main Session",
  mission: "Mission",
  other: "Event",
};

// How many chips a month cell shows before collapsing into "+N more". Kept low
// so a busy day doesn't blow out the row height; the overflow jumps to week view.
const MONTH_CHIP_CAP = 3;

export default function DirectoryCalendar() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);

  const missionsQ = useListMissions(undefined, {
    query: { queryKey: getListMissionsQueryKey() },
  });
  const eventsQ = useListEvents(undefined, {
    query: { queryKey: getListEventsQueryKey() },
  });

  const [view, setView] = useState<CalView>("month");
  const [filter, setFilter] = useState<CalFilter>("all");
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const quickNpc = useQuickNpcSignup();

  // Grid cells: a 6-week (42-cell) block for month view, or a single 7-day row
  // for week view. Both start on a Sunday so the weekday header lines up.
  const cells = useMemo(() => {
    if (view === "week") {
      const start = startOfWeek(cursor);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = startOfMonth(cursor);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [cursor, view]);

  // Visible window for recurrence expansion: first cell 00:00 → last cell 23:59.
  const rangeStart = useMemo(() => {
    const d = new Date(cells[0]);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [cells]);
  const rangeEnd = useMemo(() => {
    const d = new Date(cells[cells.length - 1]);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [cells]);

  // Build a flat list of calendar items from both sources, expanding recurring
  // events into every occurrence inside the visible window. Missions and
  // single events contribute one occurrence; cancelled missions are hidden (the
  // events endpoint already excludes cancelled events server-side). The filter
  // narrows to missions-only or events-only.
  const items = useMemo<CalItem[]>(() => {
    const out: CalItem[] = [];
    if (filter !== "event") {
      for (const m of (missionsQ.data ?? []) as MissionSummary[]) {
        if (!m.startAt) continue;
        if (m.status === "cancelled") continue;
        const start = new Date(m.startAt);
        if (Number.isNaN(start.getTime())) continue;
        if (start < rangeStart || start > rangeEnd) continue;
        // Player = accepted application (or an assigned character); NPC = an
        // active NPC signup. Player wins when both are somehow present.
        const isPlayer = m.myApplication?.status === "accepted" || m.myCharacterId != null;
        const isNpc = m.mySignup?.state === "signed_up";
        out.push({
          kind: "mission",
          id: m.id,
          title: m.title,
          start,
          href: `/missions/${m.id}`,
          subtype: `Tier ${m.tier}`,
          myStatus: isPlayer ? "player" : isNpc ? "npc" : null,
          npcOpen: m.npcSignupOpen === true,
          occMs: start.getTime(),
        });
      }
    }
    if (filter !== "mission") {
      for (const e of (eventsQ.data ?? []) as EventView[]) {
        const base = new Date(e.startAt);
        if (Number.isNaN(base.getTime())) continue;
        // Events only have NPC signups; the list returns mySignup only for an
        // active signup, so its presence makes the viewer an NPC.
        const isNpc = e.mySignup != null;
        const occs = expandOccurrences(base, e.recurrence ?? null, rangeStart, rangeEnd);
        for (const occ of occs) {
          out.push({
            kind: "event",
            id: e.id,
            title: e.title,
            start: occ,
            href: `/events/${e.id}`,
            subtype: EVENT_TYPE_LABEL[e.eventType] ?? "Event",
            eventType: e.eventType,
            myStatus: isNpc ? "npc" : null,
            npcOpen: e.needsNpcs === true,
            occMs: occ.getTime(),
          });
        }
      }
    }
    return out;
  }, [missionsQ.data, eventsQ.data, filter, rangeStart, rangeEnd]);

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

  const today = new Date();
  const label =
    view === "week"
      ? `${cells[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${cells[6].toLocaleDateString(
          undefined,
          { month: "short", day: "numeric", year: "numeric" },
        )}`
      : cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const goPrev = () =>
    setCursor((c) => (view === "week" ? addDays(c, -7) : new Date(c.getFullYear(), c.getMonth() - 1, 1)));
  const goNext = () =>
    setCursor((c) => (view === "week" ? addDays(c, 7) : new Date(c.getFullYear(), c.getMonth() + 1, 1)));
  const goToday = () => setCursor(view === "week" ? startOfWeek(new Date()) : startOfMonth(new Date()));

  // Switching view keeps the focused period sensible: month→start of that month,
  // week→start of the week containing the cursor.
  const switchView = (next: CalView) => {
    if (next === view) return;
    setCursor((c) => (next === "week" ? startOfWeek(c) : startOfMonth(c)));
    setView(next);
  };

  const jumpToWeekOf = (d: Date) => {
    setCursor(startOfWeek(d));
    setView("week");
  };

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

        {/* Controls sit to the left of CREATE EVENT: a type filter and the
            month/week view toggle. */}
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Filter calendar"
            value={filter}
            onChange={(v) => setFilter(v as CalFilter)}
            options={[
              { value: "all", label: "All" },
              { value: "mission", label: "Missions" },
              { value: "event", label: "Events" },
            ]}
            testIdPrefix="filter"
          />
          <Segmented
            ariaLabel="Calendar view"
            value={view}
            onChange={(v) => switchView(v as CalView)}
            options={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
            ]}
            testIdPrefix="view"
          />
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
      </div>

      <div className="flex items-center justify-between gap-3 border border-border bg-card/40 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-none font-display tracking-widest"
          onClick={goPrev}
          data-testid="button-prev-period"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-3">
          <span className="font-display text-xl tracking-widest text-foreground" data-testid="text-period-label">
            {label.toUpperCase()}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-none font-mono text-xs text-nc-cyan"
            onClick={goToday}
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
          onClick={goNext}
          data-testid="button-next-period"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 bg-nc-magenta/30 border border-nc-magenta/60" /> Mission
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 bg-nc-cyan/30 border border-nc-cyan/60" /> Main Session
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 bg-nc-orange/30 border border-nc-orange/60" /> Social
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block px-1 text-[9px] font-display tracking-wider bg-nc-green/20 border border-nc-green/60 text-nc-green">
            PLAYER
          </span>{" "}
          You're playing
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block px-1 text-[9px] font-display tracking-wider bg-nc-yellow/20 border border-nc-yellow/60 text-nc-yellow">
            NPC
          </span>{" "}
          You're an NPC
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
                const inMonth = view === "week" || d.getMonth() === cursor.getMonth();
                const isToday = sameDay(d, today);
                const dayItems = byDay.get(dayKey(d)) ?? [];
                // Density: crowded days use smaller chips so the cell doesn't
                // explode. Week view has whole-row height, so it shows all items
                // (scrolling if needed); month view caps and offers "+N more".
                const dense = dayItems.length >= 3;
                const capped = view === "month" && dayItems.length > MONTH_CHIP_CAP;
                const visible = capped ? dayItems.slice(0, MONTH_CHIP_CAP) : dayItems;
                const hidden = dayItems.length - visible.length;
                return (
                  <div
                    key={i}
                    className={`${view === "week" ? "min-h-[20rem]" : "min-h-[7rem]"} border-b border-r border-border/50 p-1.5 flex flex-col gap-1 ${
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
                      {dayItems.length > 0 && (
                        <span className="font-mono text-[9px] text-muted-foreground">{dayItems.length}</span>
                      )}
                    </div>
                    <div className={`flex flex-col gap-1 ${view === "week" ? "overflow-y-auto" : ""}`}>
                      {visible.map((it) => (
                        <CalChip
                          key={`${it.kind}-${it.id}-${it.occMs}`}
                          item={it}
                          dense={dense}
                          onQuickSignup={() => quickNpc.signUp(it.kind, it.id)}
                          signingUp={quickNpc.pendingKey === `${it.kind}-${it.id}`}
                        />
                      ))}
                      {hidden > 0 && (
                        <button
                          type="button"
                          onClick={() => jumpToWeekOf(d)}
                          className="text-left font-mono text-[9px] text-nc-cyan hover:text-nc-cyan/80 px-1"
                          data-testid={`more-${dayKey(d)}`}
                        >
                          +{hidden} more
                        </button>
                      )}
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

function Segmented({
  value,
  onChange,
  options,
  ariaLabel,
  testIdPrefix,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
  testIdPrefix: string;
}) {
  return (
    <div className="inline-flex border border-border bg-card/40" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`px-3 py-1.5 font-display text-xs tracking-widest transition-colors ${
              active
                ? "bg-nc-cyan text-background"
                : "text-muted-foreground hover:text-nc-cyan hover:bg-nc-cyan/10"
            }`}
            data-testid={`button-${testIdPrefix}-${o.value}`}
          >
            {o.label.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

// Colour + icon per calendar item. Missions are magenta (Briefcase); events
// split by type so Main Sessions (cyan, the headline weekly game) read distinctly
// from Socials (orange) at a glance. Anything else falls back to cyan.
function chipStyle(item: CalItem): { cls: string; Icon: LucideIcon } {
  if (item.kind === "mission") {
    return { cls: "bg-nc-magenta/20 border-nc-magenta/50 hover:bg-nc-magenta/30 text-nc-magenta", Icon: Briefcase };
  }
  switch (item.eventType) {
    case "session":
      return { cls: "bg-nc-cyan/20 border-nc-cyan/50 hover:bg-nc-cyan/30 text-nc-cyan", Icon: Users };
    case "social":
      return { cls: "bg-nc-orange/20 border-nc-orange/50 hover:bg-nc-orange/30 text-nc-orange", Icon: PartyPopper };
    default:
      return { cls: "bg-nc-cyan/20 border-nc-cyan/50 hover:bg-nc-cyan/30 text-nc-cyan", Icon: CalendarDays };
  }
}

function CalChip({
  item,
  dense,
  onQuickSignup,
  signingUp,
}: {
  item: CalItem;
  dense?: boolean;
  onQuickSignup: () => void;
  signingUp: boolean;
}) {
  const time = item.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const { cls, Icon } = chipStyle(item);
  const statusLabel =
    item.myStatus === "player" ? "Signed up as player" : item.myStatus === "npc" ? "Signed up as NPC" : null;
  // The one-tap sign-up button only appears when the item wants NPCs and the
  // viewer hasn't already joined (as a player or NPC). It lives OUTSIDE the
  // <Link> (a button nested in an anchor is invalid), sitting in the corner
  // where the PLAYER/NPC badge would otherwise be — the two are mutually
  // exclusive so they never collide.
  const canQuickNpc = item.npcOpen && item.myStatus === null;
  return (
    <div
      className={`relative border rounded-none transition-colors ${cls}`}
      data-testid={`chip-${item.kind}-${item.id}`}
    >
      <Link
        href={item.href}
        className={`block ${dense ? "px-1 py-0.5" : "px-1.5 py-1"} ${canQuickNpc ? "pr-5" : ""}`}
        title={`${item.title} · ${item.subtype} · ${time}${statusLabel ? ` · ${statusLabel}` : ""}`}
      >
        <div className={`flex items-center gap-1 font-mono leading-tight ${dense ? "text-[10px]" : "text-[11px]"}`}>
          <Icon className={`shrink-0 ${dense ? "w-2.5 h-2.5" : "w-3 h-3"}`} />
          <span className="font-semibold tabular-nums tracking-tight text-foreground">{time}</span>
          {item.myStatus && (
            <span
              className={`ml-auto shrink-0 px-1 font-display tracking-wider border ${dense ? "text-[7px]" : "text-[8px]"} ${
                item.myStatus === "player"
                  ? "bg-nc-green/20 border-nc-green/60 text-nc-green"
                  : "bg-nc-yellow/20 border-nc-yellow/60 text-nc-yellow"
              }`}
              data-testid={`chip-status-${item.kind}-${item.id}`}
            >
              {item.myStatus === "player" ? "PLAYER" : "NPC"}
            </span>
          )}
        </div>
        <div
          className={`font-mono leading-tight text-foreground break-words ${dense ? "text-[9px]" : "text-[11px]"}`}
        >
          {item.title}
        </div>
      </Link>
      {canQuickNpc && (
        <button
          type="button"
          disabled={signingUp}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onQuickSignup();
          }}
          className="absolute top-0.5 right-0.5 inline-flex items-center justify-center h-4 w-4 border border-nc-yellow/60 bg-nc-yellow/15 text-nc-yellow hover:bg-nc-yellow/30 disabled:opacity-50"
          data-testid={`button-quick-npc-${item.kind}-${item.id}`}
          title="Sign up as NPC"
          aria-label={`Sign up as an NPC for ${item.title}`}
        >
          {signingUp ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <UserPlus className="w-2.5 h-2.5" />}
        </button>
      )}
    </div>
  );
}
