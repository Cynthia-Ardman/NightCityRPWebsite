// Expand a (possibly recurring) event into the concrete occurrence start times
// that fall within a visible window. Discord recurrence rules are normalised
// server-side onto EventView.recurrence; we expand them here so a weekly event
// shows on every occurrence rather than just its first.
//
// frequency: 0=yearly, 1=monthly, 2=weekly, 3=daily.
// byWeekday uses Discord's 0=Mon..6=Sun (JS getDay() is 0=Sun..6=Sat).
export interface RecurrenceRule {
  frequency: number;
  interval: number;
  byWeekday?: number[] | null;
  count?: number | null;
  until?: string | null;
}

const MAX_ITER = 5000;

// Discord weekday (0=Mon..6=Sun) -> JS getDay (0=Sun..6=Sat).
function toJsWeekday(wd: number): number {
  return (wd + 1) % 7;
}

function startOfWeekMon(d: Date): Date {
  const r = new Date(d);
  const offset = (r.getDay() + 6) % 7; // days since Monday
  r.setDate(r.getDate() - offset);
  r.setHours(0, 0, 0, 0);
  return r;
}

function atTimeOf(base: Date, day: Date): Date {
  const d = new Date(day);
  d.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
  return d;
}

/**
 * Return the occurrence start times of an event within [rangeStart, rangeEnd]
 * (inclusive). A null/undefined rule yields the single base occurrence if it
 * falls in range. The series never produces occurrences before baseStart, and
 * honours an optional `count` (total occurrences) or `until` end.
 */
export function expandOccurrences(
  baseStart: Date,
  rule: RecurrenceRule | null | undefined,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  if (Number.isNaN(baseStart.getTime())) return [];
  if (!rule) {
    return baseStart >= rangeStart && baseStart <= rangeEnd ? [baseStart] : [];
  }

  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const until = rule.until ? new Date(rule.until) : null;
  const limit = rule.count != null && rule.count > 0 ? rule.count : Infinity;
  const out: Date[] = [];
  let produced = 0;

  // Records an occurrence toward the series total and collects it when in range.
  // Returns false to signal the series has ended (count/until reached).
  const consider = (d: Date): boolean => {
    if (d.getTime() < baseStart.getTime()) return true; // pre-series, skip but keep going
    if (until && d.getTime() > until.getTime()) return false;
    if (produced >= limit) return false;
    produced++;
    if (d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime()) out.push(d);
    return true;
  };

  if (rule.frequency === 2) {
    // WEEKLY — possibly on multiple weekdays, every `interval` weeks.
    const weekdays = (rule.byWeekday && rule.byWeekday.length
      ? rule.byWeekday.map(toJsWeekday)
      : [baseStart.getDay()]
    ).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday-first ordering
    let week = startOfWeekMon(baseStart);
    for (let i = 0; i < MAX_ITER; i++) {
      if (week.getTime() > rangeEnd.getTime()) break;
      for (const wd of weekdays) {
        const day = new Date(week);
        day.setDate(week.getDate() + ((wd + 6) % 7)); // offset from Monday
        if (!consider(atTimeOf(baseStart, day))) return out;
      }
      week = new Date(week);
      week.setDate(week.getDate() + 7 * interval);
    }
    return out;
  }

  // DAILY / MONTHLY / YEARLY (and any unknown frequency) advance from baseStart.
  let cur = new Date(baseStart);
  for (let i = 0; i < MAX_ITER; i++) {
    if (cur.getTime() > rangeEnd.getTime()) break;
    if (!consider(cur)) return out;
    const next = new Date(cur);
    if (rule.frequency === 3) next.setDate(next.getDate() + interval); // daily
    else if (rule.frequency === 1) next.setMonth(next.getMonth() + interval); // monthly
    else if (rule.frequency === 0) next.setFullYear(next.getFullYear() + interval); // yearly
    else next.setDate(next.getDate() + 7 * interval); // unknown -> weekly-ish
    cur = next;
  }
  return out;
}
