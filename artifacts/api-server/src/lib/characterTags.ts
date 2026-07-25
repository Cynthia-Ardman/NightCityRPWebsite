import { db, characterTagOptions } from "@workspace/db";

// Character tag helpers, shared by the staff archive editor (directory.ts),
// the player/staff tag endpoint (characters.ts), and sheet materialization
// (sheets.ts). Storage is split across two columns on `characters`:
//   - appliedTags: owned by the Discord importer, OVERWRITTEN on re-sync.
//   - manualTags:  owned by the portal; the importer never touches it.
// Display/filter is always the case-insensitive UNION of both.

export function normalizeTag(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function mergeTags(applied: string[] | null, manual: string[] | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...(applied ?? []), ...(manual ?? [])]) {
    const norm = normalizeTag(t);
    if (norm.length === 0) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

// Split a desired merged tag set back into the two storage columns. Tags that
// already exist on the Discord-synced list stay there (so we don't duplicate
// them into manualTags); everything else becomes a manual tag. A tag the user
// removed simply won't appear in `desired`, so it drops from whichever column
// held it. NOTE: removing a Discord-origin tag here only suppresses it until
// the next import re-derives appliedTags from the live thread.
export function splitDesiredTags(
  desired: string[],
  currentApplied: string[] | null,
): { applied: string[]; manual: string[] } {
  const desiredMerged = mergeTags(desired, []);
  const appliedLower = new Set((currentApplied ?? []).map((t) => normalizeTag(t).toLowerCase()));
  const applied: string[] = [];
  const manual: string[] = [];
  for (const t of desiredMerged) {
    if (appliedLower.has(t.toLowerCase())) applied.push(t);
    else manual.push(t);
  }
  return { applied, manual };
}

// Resolve a user-supplied tag list against the shared tag-option registry
// (character_tag_options), case-insensitively, returning the registry's
// canonical display names. Player-facing write paths must only accept
// registry tags — the vocabulary is managed by staff in the archive, and the
// same list drives character sheets, so a tag created there is immediately
// usable here. `extraAllowed` lets an edit keep tags the character ALREADY
// has even if they aren't (or are no longer) in the registry — e.g. a
// Discord-imported tag — without letting the caller invent new free-form tags.
// Returns BOTH the resolved canonical tags and any unknown names: strict
// callers (player/staff writes, sheet submission) must reject when
// `unknown.length > 0`; lenient callers (sheet close, where the registry may
// have changed since submit) keep `tags` and drop the stale ones.
export async function resolveRegistryTags(
  desired: string[],
  extraAllowed: string[] = [],
): Promise<{ tags: string[]; unknown: string[] }> {
  const options = await db.select({ name: characterTagOptions.name }).from(characterTagOptions);
  const canonical = new Map<string, string>();
  for (const o of options) {
    const norm = normalizeTag(o.name);
    if (norm) canonical.set(norm.toLowerCase(), norm);
  }
  for (const t of extraAllowed) {
    const norm = normalizeTag(t);
    if (norm && !canonical.has(norm.toLowerCase())) canonical.set(norm.toLowerCase(), norm);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const raw of desired) {
    const norm = normalizeTag(raw);
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = canonical.get(key);
    if (hit) out.push(hit);
    else unknown.push(norm);
  }
  return { tags: out, unknown };
}
