// Display/reporting classification for a wallet transaction, independent of the
// load-bearing `kind` column. `kind` drives billing logic (autobill period
// guards in jobs.ts, the housing history filter) and MUST NOT be repurposed for
// display. `category` is a derived, coarse bucket used by the Ledger UI and the
// per-character rent / cyberware history sections.
//
// Legacy bot rows were imported with kind='historical', so their real type only
// survives in the memo text (e.g. "[legacy-bal:12] Housing Rent",
// "Cyberware meds week 3"). The classifier therefore consults the structured
// kind first (for live rows) and falls back to memo matching (for historical).

export type WalletCategory =
  | "rent"
  | "cyberware"
  | "mission"
  | "business"
  | "membership"
  | "fee"
  | "purchase"
  | "transfer"
  | "sink"
  | "other";

export function classifyWalletCategory(
  kind: string | null | undefined,
  memo: string | null | undefined,
): WalletCategory {
  const k = (kind ?? "").toLowerCase().trim();
  const m = (memo ?? "").toLowerCase();

  // 1) Structured kind wins for live (non-historical) rows.
  if (k === "transfer" || k === "transfer_in" || k === "transfer_out") return "transfer";
  if (k === "sink") return "sink";
  if (k === "rent" || k === "business_rent") return "rent";
  if (k === "meds") return "cyberware";
  if (k === "trauma_team" || k === "xanadu_gold") return "membership";
  if (k === "lifestyle" || k === "lifestyle_unpaid" || k === "baseline") return "fee";
  if (k === "shop_income") return "business";
  if (k === "mission") return "mission";
  if (
    k === "store_deposit" ||
    k === "store_withdraw" ||
    k === "ripperdoc_deposit" ||
    k === "ripperdoc_withdraw" ||
    k === "store" ||
    k === "shop"
  ) {
    return "purchase";
  }

  // 2) Fall back to memo text (covers legacy kind='historical' rows whose real
  //    type only lives in the memo). Order matters: "Business Rent" should be
  //    rent, and "Trauma Team" should resolve before the generic mission rules.
  if (/\brent\b/.test(m)) return "rent";
  if (/cyberware|cw catalogue|cw install|cw shop|\bmeds?\b/.test(m)) return "cyberware";
  if (/xanadu|trauma team/.test(m)) return "membership";
  if (/mission payout|actor pay|attendance/.test(m)) return "mission";
  if (/business activity|business reward/.test(m)) return "business";
  if (/flat monthly fee|monthly fee|baseline|living cost/.test(m)) return "fee";
  if (/\bpurchase\b|gun purchase|catalogue buy|\bbuy\b/.test(m)) return "purchase";
  if (/\btransfer\b/.test(m)) return "transfer";

  return "other";
}

// Human-readable label for a category (UI display).
export function walletCategoryLabel(category: WalletCategory): string {
  switch (category) {
    case "rent":
      return "Rent";
    case "cyberware":
      return "Cyberware";
    case "mission":
      return "Mission";
    case "business":
      return "Business";
    case "membership":
      return "Membership";
    case "fee":
      return "Fee";
    case "purchase":
      return "Purchase";
    case "transfer":
      return "Transfer";
    case "sink":
      return "Money Sink";
    default:
      return "Other";
  }
}
