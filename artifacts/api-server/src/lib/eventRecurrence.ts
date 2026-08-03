// Server-side port of the portal's recurrence expander (see
// artifacts/ncrp-portal/src/lib/eventRecurrence.ts for the full rationale).
// Used by the Discord/VRChat sync to compute the NEXT upcoming occurrence of a
// recurring event whose stored base start has slipped into the past — both
// mirrors reject past start times, so pushes must use the next occurrence.
//
// frequency: 0=yearly, 1=monthly, 2=weekly, 3=daily.
// byWeekday uses Discord's 0=Mon..6=Sun in the event's UTC start frame; we
// never place occurrences on an absolute weekday — we step the base instant so
// every occurrence keeps the base event's exact local day & time.
export interface RecurrenceRule {
  frequency: number;
  interval: number;
  byWeekday?: number[] | null;
  count?: number | null;
  until?: string | null;
}

const MAX_ITER = 5000;

// Discord weekday (0=Mon..6=Sun) -> JS getUTCDay (0=Sun..6=Sat).
function toJsWeekday(wd: number): number {
  return (wd + 1) % 7;
}

/**
 * Occurrence start times of an event within [rangeStart, rangeEnd] (inclusive).
 * A null rule yields the single base occurrence if in range. Never produces
 * occurrences before baseStart for bounded series; honours count/until.
 * `exclude` lists ISO instants split out via "edit just this occurrence".
 */
export function expandOccurrences(
  baseStart: Date,
  rule: RecurrenceRule | null | undefined,
  rangeStart: Date,
  rangeEnd: Date,
  exclude?: string[] | null,
): Date[] {
  const raw = expandOccurrencesRaw(baseStart, rule, rangeStart, rangeEnd);
  if (!exclude || exclude.length === 0) return raw;
  const excluded = new Set(exclude.map((s) => new Date(s).getTime()).filter((t) => !Number.isNaN(t)));
  return raw.filter((d) => !excluded.has(d.getTime()));
}

function expandOccurrencesRaw(
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
  const openEnded = limit === Infinity && !until;
  const out: Date[] = [];
  let produced = 0;

  const consider = (d: Date): boolean => {
    if (d.getTime() < baseStart.getTime()) {
      if (openEnded && d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime()) {
        out.push(d);
      }
      return true;
    }
    if (until && d.getTime() > until.getTime()) return false;
    if (produced >= limit) return false;
    produced++;
    if (d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime()) out.push(d);
    return true;
  };

  if (rule.frequency === 2) {
    // WEEKLY — possibly multiple weekdays, every `interval` weeks, anchored on
    // the base instant (offsets relative to the base's own UTC weekday).
    const baseUtcWd = baseStart.getUTCDay();
    const offsets = Array.from(
      new Set(
        (rule.byWeekday && rule.byWeekday.length ? rule.byWeekday.map(toJsWeekday) : [baseUtcWd]).map(
          (wd) => (wd - baseUtcWd + 7) % 7,
        ),
      ),
    ).sort((a, b) => a - b);
    let startI = 0;
    if (openEnded && rangeStart.getTime() < baseStart.getTime()) {
      const weekMs = 7 * interval * 86400000;
      startI = -Math.ceil((baseStart.getTime() - rangeStart.getTime()) / weekMs) - 1;
      startI = Math.max(startI, -MAX_ITER);
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

  // DAILY / MONTHLY / YEARLY (and unknown) advance from baseStart.
  let cur = new Date(baseStart);
  if (openEnded && rangeStart.getTime() < baseStart.getTime()) {
    for (let i = 0; i < MAX_ITER && cur.getTime() > rangeStart.getTime(); i++) {
      const prev = new Date(cur);
      if (rule.frequency === 3) prev.setDate(prev.getDate() - interval);
      else if (rule.frequency === 1) prev.setMonth(prev.getMonth() - interval);
      else if (rule.frequency === 0) prev.setFullYear(prev.getFullYear() - interval);
      else prev.setDate(prev.getDate() - 7 * interval);
      cur = prev;
    }
  }
  for (let i = 0; i < MAX_ITER; i++) {
    if (cur.getTime() > rangeEnd.getTime()) break;
    if (!consider(cur)) return out;
    const next = new Date(cur);
    if (rule.frequency === 3) next.setDate(next.getDate() + interval);
    else if (rule.frequency === 1) next.setMonth(next.getMonth() + interval);
    else if (rule.frequency === 0) next.setFullYear(next.getFullYear() + interval);
    else next.setDate(next.getDate() + 7 * interval);
    cur = next;
  }
  return out;
}
