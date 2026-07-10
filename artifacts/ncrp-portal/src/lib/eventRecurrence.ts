// Expand a (possibly recurring) event into the concrete occurrence start times
// that fall within a visible window. Discord recurrence rules are normalised
// server-side onto EventView.recurrence; we expand them here so a weekly event
// shows on every occurrence rather than just its first.
//
// frequency: 0=yearly, 1=monthly, 2=weekly, 3=daily.
// byWeekday uses Discord's 0=Mon..6=Sun, expressed in the event's UTC start
// frame (it always matches the UTC weekday of `startAt`). We therefore never
// place occurrences on an absolute weekday — that would land on the UTC day,
// not the viewer's local day (e.g. Wed 6pm Pacific is stored as Thu 01:00 UTC,
// so byWeekday says Thursday). Instead we step the base instant by whole weeks
// and, for multi-weekday rules, by day-offsets relative to the base's own
// weekday, so every occurrence keeps the base event's exact local day & time.
export interface RecurrenceRule {
  frequency: number;
  interval: number;
  byWeekday?: number[] | null;
  count?: number | null;
  until?: string | null;
}

const MAX_ITER = 5000;

// Discord weekday (0=Mon..6=Sun) -> JS getUTCDay (0=Sun..6=Sat). byWeekday is in
// the UTC frame, so we compare it against the base instant's UTC weekday.
function toJsWeekday(wd: number): number {
  return (wd + 1) % 7;
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
  // Bounded series (explicit `count` or `until`) treat baseStart as the
  // authoritative series origin and never emit occurrences before it. Open-ended
  // series are different: Discord rolls a recurring event's stored start_at
  // forward to the *next* occurrence once the current one starts, so an earlier
  // occurrence that still falls inside the visible window (e.g. this week's, which
  // already began earlier today) is real and must still render. For those we walk
  // backward from baseStart to cover the window.
  const openEnded = limit === Infinity && !until;
  const out: Date[] = [];
  let produced = 0;

  // Records an occurrence toward the series total and collects it when in range.
  // Returns false to signal the series has ended (count/until reached).
  const consider = (d: Date): boolean => {
    if (d.getTime() < baseStart.getTime()) {
      // Pre-baseStart occurrences only surface for open-ended series, only inside
      // the visible window, and never count toward the occurrence budget.
      if (openEnded && d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime()) {
        out.push(d);
      }
      return true; // keep going
    }
    if (until && d.getTime() > until.getTime()) return false;
    if (produced >= limit) return false;
    produced++;
    if (d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime()) out.push(d);
    return true;
  };

  if (rule.frequency === 2) {
    // WEEKLY — possibly on multiple weekdays, every `interval` weeks. We anchor
    // on the base instant and only ever ADD whole days, so each occurrence keeps
    // the base event's exact wall-clock day & time when rendered locally.
    // byWeekday is in the UTC frame, so day-offsets are taken relative to the
    // base's own UTC weekday (the base entry therefore always yields offset 0).
    const baseUtcWd = baseStart.getUTCDay();
    const offsets = Array.from(
      new Set(
        (rule.byWeekday && rule.byWeekday.length ? rule.byWeekday.map(toJsWeekday) : [baseUtcWd]).map(
          (wd) => (wd - baseUtcWd + 7) % 7,
        ),
      ),
    ).sort((a, b) => a - b);
    // For open-ended series, start the week index far enough in the past to reach
    // rangeStart so earlier in-window occurrences are generated too.
    let startI = 0;
    if (openEnded && rangeStart.getTime() < baseStart.getTime()) {
      const weekMs = 7 * interval * 86400000;
      startI = -Math.ceil((baseStart.getTime() - rangeStart.getTime()) / weekMs) - 1;
      startI = Math.max(startI, -MAX_ITER); // keep total iterations bounded
    }
    for (let i = startI; i < MAX_ITER; i++) {
      const weekBase = new Date(baseStart);
      weekBase.setDate(weekBase.getDate() + 7 * interval * i);
      if (weekBase.getTime() > rangeEnd.getTime()) break;
      for (const off of offsets) {
        const occ = new Date(weekBase);
        occ.setDate(occ.getDate() + off);
        if (!consider(occ)) return out;
      }
    }
    return out;
  }

  // DAILY / MONTHLY / YEARLY (and any unknown frequency) advance from baseStart.
  let cur = new Date(baseStart);
  // Open-ended series: rewind to (just before) the window so earlier in-window
  // occurrences are emitted as well.
  if (openEnded && rangeStart.getTime() < baseStart.getTime()) {
    for (let i = 0; i < MAX_ITER && cur.getTime() > rangeStart.getTime(); i++) {
      const prev = new Date(cur);
      if (rule.frequency === 3) prev.setDate(prev.getDate() - interval); // daily
      else if (rule.frequency === 1) prev.setMonth(prev.getMonth() - interval); // monthly
      else if (rule.frequency === 0) prev.setFullYear(prev.getFullYear() - interval); // yearly
      else prev.setDate(prev.getDate() - 7 * interval); // unknown -> weekly-ish
      cur = prev;
    }
  }
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

/**
 * Millisecond timestamps of the occurrences the viewer is actively signed up
 * for (EventView.myOccurrences). Used to badge only the signed-up
 * occurrence(s) of a recurring event, not every projected one.
 */
export function myOccurrenceSet(myOccurrences: string[] | undefined | null): Set<number> {
  const out = new Set<number>();
  for (const s of myOccurrences ?? []) {
    const t = new Date(s).getTime();
    if (!Number.isNaN(t)) out.add(t);
  }
  return out;
}
