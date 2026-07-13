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

// Per-viewer clock-format preference (12-hour AM/PM vs 24-hour). Default is the
// historical 24-hour format; the choice is remembered in localStorage so it
// sticks across visits. This only changes the FORMAT of the labels — times stay
// in the viewer's local timezone (intentional for cross-tz overlap).
const HOUR12_KEY = "ncrp.availability.hour12";
function readHour12Pref(): boolean {
  try {
    return localStorage.getItem(HOUR12_KEY) === "1";
  } catch {
    return false;
  }
}
function writeHour12Pref(v: boolean): void {
  try {
    localStorage.setItem(HOUR12_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

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

function rowLabel(row: number, hour12: boolean): string {
  const mins = rowMinutes(row);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(hour12 ? "en-US" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  });
}

// Locale-neutral "Mon, Jun 21 06:00" (or "06:00 AM") — date format stays fixed,
// only the clock format follows the viewer's toggle.
function formatInstant(iso: string, hour12: boolean): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(hour12 ? "en-US" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  });
  return `${date} ${time}`;
}

function ClockFormatToggle({ hour12, onChange }: { hour12: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className="inline-flex items-center rounded border border-border/60 overflow-hidden text-[10px] font-mono shrink-0"
      data-testid="availability-clock-toggle"
    >
      <button
        type="button"
        onClick={() => onChange(false)}
        aria-pressed={!hour12}
        className={cn(
          "px-2 py-0.5 leading-none transition-colors",
          !hour12 ? "bg-nc-cyan text-background" : "text-muted-foreground hover:text-foreground",
        )}
      >
        24h
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        aria-pressed={hour12}
        className={cn(
          "px-2 py-0.5 leading-none border-l border-border/60 transition-colors",
          hour12 ? "bg-nc-cyan text-background" : "text-muted-foreground hover:text-foreground",
        )}
      >
        12h
      </button>
    </div>
  );
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
  const [hour12, setHour12] = useState<boolean>(() => readHour12Pref());

  const onChangeHour12 = useCallback((v: boolean) => {
    setHour12(v);
    writeHour12Pref(v);
  }, []);

  if (props.mode === "edit") {
    return (
      <EditGrid
        days={days}
        rows={rows}
        value={props.value}
        onChange={props.onChange}
        className={props.className}
        hour12={hour12}
        onChangeHour12={onChangeHour12}
      />
    );
  }
  return (
    <HeatmapGrid
      days={days}
      rows={rows}
      applicants={props.heatmap}
      className={props.className}
      hour12={hour12}
      onChangeHour12={onChangeHour12}
    />
  );
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

function RowTimeLabel({ row, hour12 }: { row: number; hour12: boolean }) {
  const onHour = rowMinutes(row) % 60 === 0;
  return (
    <div className="sticky left-0 z-10 bg-card border-r border-border/60 w-[58px] shrink-0 h-[13px] flex items-start justify-end pr-1">
      {onHour && (
        <span className="text-[9px] text-muted-foreground leading-none -translate-y-[1px] whitespace-nowrap">{rowLabel(row, hour12)}</span>
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
  hour12,
  onChangeHour12,
}: {
  days: Date[];
  rows: number[];
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
  hour12: boolean;
  onChangeHour12: (v: boolean) => void;
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
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-muted-foreground">
          Drag to paint the times you're available (shown in your local time).
        </div>
        <ClockFormatToggle hour12={hour12} onChange={onChangeHour12} />
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
            <Row key={row} row={row} hour12={hour12}>
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

function Row({ row, hour12, children }: { row: number; hour12: boolean; children: React.ReactNode }) {
  return (
    <>
      <RowTimeLabel row={row} hour12={hour12} />
      {children}
    </>
  );
}

function HeatmapGrid({
  days,
  rows,
  applicants,
  className,
  hour12,
  onChangeHour12,
}: {
  days: Date[];
  rows: number[];
  applicants: { name: string; slots: string[] }[];
  className?: string;
  hour12: boolean;
  onChangeHour12: (v: boolean) => void;
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
        <div className="flex items-center gap-3">
          <div className="text-[11px] font-display tracking-widest uppercase text-nc-cyan" data-testid="availability-peak">
            Max {peak} of {total} player{total === 1 ? "" : "s"} available
          </div>
          <ClockFormatToggle hour12={hour12} onChange={onChangeHour12} />
        </div>
      </div>
      {/* One fixed-height, truncating line: long name lists must never wrap,
          or the grid shifts under the cursor and the hovered cell oscillates. */}
      <div
        className="text-[11px] text-muted-foreground h-[15px] leading-[15px] whitespace-nowrap overflow-hidden text-ellipsis"
        title={hover ? `${formatInstant(hover.iso, hour12)} — ${hover.names.join(", ")}` : undefined}
        data-testid="availability-hover"
      >
        {hover
          ? `${formatInstant(hover.iso, hour12)} — ${hover.names.join(", ")}`
          : "Hover over a cell to view player availability"}
      </div>
      <div className={GRID_SHELL} data-testid="availability-grid-heatmap">
        <div className="grid" style={{ gridTemplateColumns: `58px repeat(${days.length}, minmax(40px, 1fr))` }}>
          <TimeColHeader />
          <DayHeaders days={days} />
          {rows.map((row) => (
            <Row key={row} row={row} hour12={hour12}>
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
