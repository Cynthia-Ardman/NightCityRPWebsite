import { useMemo, useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";

// When2Meet-style availability picker (Task #244).
//
// The grid spans a rolling 14-day window starting today, one column per day,
// 48 half-hour rows covering the full day. Everything is computed in the
// VIEWER'S LOCAL time: a selected cell is converted to an absolute UTC instant
// (its `toISOString()`), so a fixer can overlap applicants who picked in
// different time zones simply by comparing instant strings — the same local
// cell on both sides resolves to the same instant.

export const AVAIL_DAYS = 14;
const START_HOUR = 0;
const END_HOUR = 24; // exclusive
const SLOT_MINUTES = 30;
export const AVAIL_ROWS = ((END_HOUR - START_HOUR) * 60) / SLOT_MINUTES; // 48

export type AvailabilitySlot = { weekday: number; minutes: number };

/** Local midnight today through today+13. */
export function buildDayColumns(now: Date = new Date()): Date[] {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  return Array.from({ length: AVAIL_DAYS }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d;
  });
}

/** Minutes-from-local-midnight for a grid row. */
export function rowMinutes(row: number): number {
  return START_HOUR * 60 + row * SLOT_MINUTES;
}

/** The absolute UTC ISO instant for a (day, row) cell. */
export function cellInstant(day: Date, row: number): string {
  const d = new Date(day);
  d.setHours(0, rowMinutes(row), 0, 0);
  return d.toISOString();
}

/** Derive a weekly pattern (local weekday + minutes) from absolute instants. */
export function patternFromInstants(instants: string[]): AvailabilitySlot[] {
  const seen = new Set<string>();
  const out: AvailabilitySlot[] = [];
  for (const iso of instants) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    const weekday = d.getDay();
    const minutes = d.getHours() * 60 + d.getMinutes();
    const key = `${weekday}:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ weekday, minutes });
  }
  return out;
}

/** Project a weekly pattern onto concrete instants within the visible window. */
export function expandPattern(pattern: AvailabilitySlot[], days: Date[]): string[] {
  const byWeekday = new Map<number, number[]>();
  for (const p of pattern) {
    const list = byWeekday.get(p.weekday) ?? [];
    list.push(p.minutes);
    byWeekday.set(p.weekday, list);
  }
  const out: string[] = [];
  for (const day of days) {
    const mins = byWeekday.get(day.getDay());
    if (!mins) continue;
    for (const m of mins) {
      const d = new Date(day);
      d.setHours(0, m, 0, 0);
      out.push(d.toISOString());
    }
  }
  return out;
}

// Display formatting is deliberately locale-NEUTRAL so every player sees the
// same grid regardless of their device locale (some were seeing a 12-hour AM/PM
// clock and "6/21" dates while others saw a 24-hour clock and "21/06"). Times
// stay in the viewer's local TIMEZONE (intentional for cross-tz overlap) — only
// the clock/date FORMAT is standardized: 24-hour times + "Jun 21" dates.
function dayHeader(d: Date): { dow: string; date: string } {
  return {
    dow: d.toLocaleDateString("en-US", { weekday: "short" }),
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  };
}

function rowLabel(row: number): string {
  const mins = rowMinutes(row);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

type EditProps = {
  mode: "edit";
  value: string[];
  onChange: (next: string[]) => void;
  heatmap?: never;
};

type HeatmapProps = {
  mode: "heatmap";
  /** One entry per applicant who supplied availability. */
  heatmap: { name: string; slots: string[] }[];
  value?: never;
  onChange?: never;
};

type Props = (EditProps | HeatmapProps) & { className?: string };

export function AvailabilityGrid(props: Props) {
  const days = useMemo(() => buildDayColumns(), []);
  const rows = useMemo(() => Array.from({ length: AVAIL_ROWS }, (_, r) => r), []);

  if (props.mode === "edit") {
    return <EditGrid days={days} rows={rows} value={props.value} onChange={props.onChange} className={props.className} />;
  }
  return <HeatmapGrid days={days} rows={rows} applicants={props.heatmap} className={props.className} />;
}

const GRID_SHELL =
  "overflow-auto max-h-[460px] border border-border bg-background/40 select-none font-mono";

function TimeColHeader() {
  return (
    <div className="sticky left-0 top-0 z-30 bg-card border-r border-b border-border/60 w-[58px] shrink-0" />
  );
}

function DayHeaders({ days }: { days: Date[] }) {
  return (
    <>
      {days.map((d, i) => {
        const h = dayHeader(d);
        return (
          <div
            key={i}
            className="sticky top-0 z-20 bg-card border-r border-b border-border/60 text-center py-1 min-w-[40px]"
          >
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">{h.dow}</div>
            <div className="text-[10px] text-foreground leading-tight">{h.date}</div>
          </div>
        );
      })}
    </>
  );
}

function RowTimeLabel({ row }: { row: number }) {
  const onHour = rowMinutes(row) % 60 === 0;
  return (
    <div className="sticky left-0 z-10 bg-card border-r border-border/60 w-[58px] shrink-0 h-[13px] flex items-start justify-end pr-1">
      {onHour && (
        <span className="text-[9px] text-muted-foreground leading-none -translate-y-[1px] whitespace-nowrap">{rowLabel(row)}</span>
      )}
    </div>
  );
}

function EditGrid({
  days,
  rows,
  value,
  onChange,
  className,
}: {
  days: Date[];
  rows: number[];
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const selected = useMemo(() => new Set(value), [value]);
  const draggingRef = useRef(false);
  const addModeRef = useRef(true);

  const applyCell = useCallback(
    (iso: string) => {
      const next = new Set(selected);
      if (addModeRef.current) next.add(iso);
      else next.delete(iso);
      onChange([...next].sort());
    },
    [selected, onChange],
  );

  const startDrag = useCallback(
    (iso: string) => {
      draggingRef.current = true;
      addModeRef.current = !selected.has(iso);
      applyCell(iso);
    },
    [selected, applyCell],
  );

  const endDrag = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="text-[11px] text-muted-foreground">
        Drag to paint the times you're available (shown in your local time).
      </div>
      <div
        className={GRID_SHELL}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        data-testid="availability-grid-edit"
      >
        <div className="grid" style={{ gridTemplateColumns: `58px repeat(${days.length}, minmax(40px, 1fr))` }}>
          <TimeColHeader />
          <DayHeaders days={days} />
          {rows.map((row) => (
            <Row key={row} row={row}>
              {days.map((day, di) => {
                const iso = cellInstant(day, row);
                const on = selected.has(iso);
                const hourBorder = rowMinutes(row) % 60 === 0;
                return (
                  <button
                    type="button"
                    key={di}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startDrag(iso);
                    }}
                    onPointerEnter={() => {
                      if (draggingRef.current) applyCell(iso);
                    }}
                    aria-pressed={on}
                    data-iso={iso}
                    data-on={on ? "1" : "0"}
                    className={cn(
                      "h-[13px] border-r border-border/30 touch-none",
                      hourBorder ? "border-t border-t-border/50" : "border-t border-t-transparent",
                      on ? "bg-nc-cyan" : "bg-transparent hover:bg-nc-cyan/20",
                    )}
                  />
                );
              })}
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ row, children }: { row: number; children: React.ReactNode }) {
  return (
    <>
      <RowTimeLabel row={row} />
      {children}
    </>
  );
}

function HeatmapGrid({
  days,
  rows,
  applicants,
  className,
}: {
  days: Date[];
  rows: number[];
  applicants: { name: string; slots: string[] }[];
  className?: string;
}) {
  const counts = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of applicants) {
      for (const iso of new Set(a.slots)) {
        const list = map.get(iso) ?? [];
        list.push(a.name);
        map.set(iso, list);
      }
    }
    return map;
  }, [applicants]);

  const total = applicants.length;
  const peak = useMemo(() => {
    let max = 0;
    for (const list of counts.values()) max = Math.max(max, list.length);
    return max;
  }, [counts]);

  const [hover, setHover] = useState<{ iso: string; names: string[] } | null>(null);

  if (total === 0) {
    return (
      <p className="text-muted-foreground italic font-mono text-xs" data-testid="availability-heatmap-empty">
        No applicants have shared their availability yet.
      </p>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px] font-display tracking-widest uppercase text-nc-cyan" data-testid="availability-peak">
          Max {peak} of {total} player{total === 1 ? "" : "s"} available
        </div>
        <div className="text-[11px] text-muted-foreground min-h-[15px]" data-testid="availability-hover">
          {hover
            ? `${new Date(hover.iso).toLocaleString("en-GB", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })} — ${hover.names.join(", ")}`
            : "Hover a block to see who's free"}
        </div>
      </div>
      <div className={GRID_SHELL} data-testid="availability-grid-heatmap">
        <div className="grid" style={{ gridTemplateColumns: `58px repeat(${days.length}, minmax(40px, 1fr))` }}>
          <TimeColHeader />
          <DayHeaders days={days} />
          {rows.map((row) => (
            <Row key={row} row={row}>
              {days.map((day, di) => {
                const iso = cellInstant(day, row);
                const names = counts.get(iso) ?? [];
                const n = names.length;
                const hourBorder = rowMinutes(row) % 60 === 0;
                // Intensity scales with the fraction of applicants free.
                const opacity = n === 0 ? 0 : 0.18 + 0.82 * (n / total);
                return (
                  <div
                    key={di}
                    onMouseEnter={() => setHover(n > 0 ? { iso, names } : null)}
                    onMouseLeave={() => setHover(null)}
                    title={n > 0 ? `${n}/${total}: ${names.join(", ")}` : undefined}
                    data-iso={iso}
                    data-count={n}
                    className={cn(
                      "h-[13px] border-r border-border/30",
                      hourBorder ? "border-t border-t-border/50" : "border-t border-t-transparent",
                    )}
                    style={n > 0 ? { backgroundColor: `rgba(34, 211, 238, ${opacity})` } : undefined}
                  />
                );
              })}
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}
