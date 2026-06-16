// Shared billing/lease date helpers. Centralized so the lease "paid through"
// math stays identical across every route that starts or rolls a lease
// (housing.ts, requests.ts) and can't silently drift.

// First-of-next-month at 00:00:00 UTC = end of the current month (exclusive).
// Used to set a new lease's initial paid_through so it is already paid up for
// the current month until the monthly_rent cron rolls it forward.
export function endOfCurrentMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}
