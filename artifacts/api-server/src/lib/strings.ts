// Case/whitespace-insensitive matching key for names, categories, and other
// free-text identifiers (catalog lookups, cyberware category checks, legacy
// handle matching, …). Single definition so every matcher normalizes the same
// way. NOT the same as characterTags.normalizeTag, which preserves case and
// collapses inner whitespace for display.
export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

// Punctuation/whitespace-tolerant matching key: lower-case and strip every
// non-alphanumeric, so "M-10AF  Lexington," , "M10AF Lexington" and "m 10af
// lexington" all resolve to the same key. Used where free-typed player input
// is matched against catalog names (sheet gun resolution); keep normalizeName
// for identifiers where punctuation/spacing is meaningful.
export function looseNameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
