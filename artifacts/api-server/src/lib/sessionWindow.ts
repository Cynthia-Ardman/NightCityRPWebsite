// The live RP session window: Sundays 2pm–9pm Pacific Time. Both the weekly
// attendance claim and the "open shop" action are only allowed during this
// window. We use Intl.DateTimeFormat against America/Los_Angeles so DST is
// handled correctly (PST ↔ PDT shifts twice a year and naive UTC offset math
// would silently drift).
const SESSION_TZ = "America/Los_Angeles";
const SESSION_DAY = "Sun";
const SESSION_HOUR_START = 14; // 2pm inclusive
const SESSION_HOUR_END = 21;   // 9pm exclusive (window closes at 21:00)

export const SESSION_WINDOW_HINT = "Sundays 2:00pm–9:00pm Pacific";

function pacificParts(now: Date): { weekday: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: SESSION_TZ,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  // Intl reports midnight as "24" with hour12:false in some runtimes.
  const hourNum = parseInt(hourStr, 10);
  const hour = Number.isNaN(hourNum) ? 0 : (hourNum === 24 ? 0 : hourNum);
  return { weekday, hour };
}

export function isSessionWindowOpen(now: Date = new Date()): boolean {
  const { weekday, hour } = pacificParts(now);
  return weekday === SESSION_DAY && hour >= SESSION_HOUR_START && hour < SESSION_HOUR_END;
}

// The Pacific calendar date (YYYY-MM-DD) of the Sunday that anchors the
// current session week. The weekly attendance claim is keyed on this rather
// than a UTC ISO week: the session window (Sun 2–9pm Pacific) straddles UTC
// midnight (Sun 21:00 → Mon 04:00 UTC), so a UTC-derived week key would split
// a single Sunday window across two different keys and let a user claim twice
// in one session. Anchoring on the Pacific Sunday date yields exactly one key
// per weekly session.
export function sessionWeekKey(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SESSION_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value ?? "1970");
  const m = Number(parts.find((p) => p.type === "month")?.value ?? "1");
  const d = Number(parts.find((p) => p.type === "day")?.value ?? "1");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const order: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const daysSinceSunday = order[weekday] ?? 0;
  // Build a plain UTC date from the Pacific Y-M-D, step back to that week's
  // Sunday, and re-stringify. Only whole-day arithmetic happens here, so no
  // timezone conversion is involved — the result is purely a date label.
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - daysSinceSunday);
  return base.toISOString().slice(0, 10);
}

// Legacy UTC-ISO-week-Monday keys that a claim for the CURRENT Pacific session
// week may have been stored under before the key scheme switched to
// `sessionWeekKey`. A Sunday-2-9pm-Pacific claim's UTC instant lands either on
// the Sunday (ISO Monday = Sunday−6d) or the following Monday (ISO Monday =
// Sunday+1d). These keys overlap with OTHER weeks' legacy keys, so callers must
// disambiguate a matched row by `claimedAt` (compare sessionWeekKey(claimedAt)
// against the current key) — never trust the legacy key alone.
export function legacySessionWeekKeys(now: Date = new Date()): string[] {
  const sunday = sessionWeekKey(now);
  const [y, m, d] = sunday.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const minus6 = new Date(base);
  minus6.setUTCDate(base.getUTCDate() - 6);
  const plus1 = new Date(base);
  plus1.setUTCDate(base.getUTCDate() + 1);
  return [minus6.toISOString().slice(0, 10), plus1.toISOString().slice(0, 10)];
}

// Next Sunday-2pm-Pacific opening, computed by stepping hour-by-hour from
// `now`. Bounded to 9 days so we always terminate even if Intl returns
// something unexpected. Used purely for UI display.
export function nextSessionWindowStart(now: Date = new Date()): Date {
  const cursor = new Date(now.getTime());
  for (let i = 0; i < 24 * 9; i++) {
    cursor.setTime(cursor.getTime() + 60 * 60 * 1000);
    const { weekday, hour } = pacificParts(cursor);
    if (weekday === SESSION_DAY && hour === SESSION_HOUR_START) return cursor;
  }
  return cursor;
}
