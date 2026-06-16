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
