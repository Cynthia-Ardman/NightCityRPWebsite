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
