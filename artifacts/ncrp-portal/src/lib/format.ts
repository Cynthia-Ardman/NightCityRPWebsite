// Shared display formatters. Centralized so currency renders consistently as
// the in-world "€$" prefix everywhere, instead of the ad-hoc mix of "$", "€$ ",
// and "{n} €$" scattered across pages.

export function formatEddies(amount: number): string {
  return `€$${amount.toLocaleString()}`;
}

// Signed variant for ledgers / deltas, e.g. "+€$1,000" / "-€$250".
export function formatEddiesSigned(amount: number): string {
  const sign = amount < 0 ? "-" : amount > 0 ? "+" : "";
  return `${sign}€$${Math.abs(amount).toLocaleString()}`;
}

// Shared date formatter so dates render consistently as "Jan 1, 2026"
// everywhere, instead of the browser-default toLocaleDateString() drift
// (which varies by user locale between MM/DD/YYYY, DD/MM/YYYY, etc).
// Accepts an ISO string, Date, or null/undefined; falls back to "—".
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
