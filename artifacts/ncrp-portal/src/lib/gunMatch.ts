// Catalog-gun name matching shared by the sheet form (picker / near-miss
// nudge) and the sheet close dialog (catalog vs custom split). The loose key
// MUST mirror the server's looseNameKey (api-server/src/lib/strings.ts) so the
// client's catalog/custom classification never disagrees with what the server
// auto-resolves at approval.

// Lower-case + strip every non-alphanumeric (matches server looseNameKey).
export function looseGunKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Small bounded Levenshtein (early-exit when distance must exceed `max`).
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let best = (prev[0] = i) as number;
    let left = i - 1; // prev diagonal
    for (let j = 1; j <= b.length; j++) {
      const diag = left;
      left = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev[j] < best) best = prev[j];
    }
    if (best > max) return max + 1;
  }
  return prev[b.length];
}

// Given a free-typed name and the catalog names, return the catalog name to
// suggest ("did you mean X?"), or null when the input is empty, already an
// exact loose match, or nothing is close. "Close" = small typo (edit distance
// scaled to length) or one side containing the other ("Lexington" →
// "Militech M-10AF Lexington").
export function bestGunSuggestion(input: string, catalogNames: string[]): string | null {
  const key = looseGunKey(input);
  if (key.length < 3) return null;
  let best: { name: string; score: number } | null = null;
  for (const name of catalogNames) {
    const cKey = looseGunKey(name);
    if (!cKey) continue;
    if (cKey === key) return null; // exact catalog match — nothing to suggest
    let score: number | null = null;
    if (cKey.includes(key) || key.includes(cKey)) {
      score = Math.abs(cKey.length - key.length); // containment: prefer closest length
    } else {
      const max = key.length <= 6 ? 1 : 2;
      const d = editDistance(key, cKey, max);
      if (d <= max) score = d;
    }
    if (score !== null && (!best || score < best.score)) best = { name, score };
  }
  return best?.name ?? null;
}
