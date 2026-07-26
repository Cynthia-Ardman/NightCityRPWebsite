// Case/whitespace-insensitive matching key for names, categories, and other
// free-text identifiers (catalog lookups, cyberware category checks, legacy
// handle matching, …). Single definition so every matcher normalizes the same
// way. NOT the same as characterTags.normalizeTag, which preserves case and
// collapses inner whitespace for display.
export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}
