// Pure (non-cyberware) sheet-submission validation helpers.
//
// Like ./cyberware-cap, this module is intentionally free of any database or
// framework imports so the field/age/skills/gear rules and the NPC role gate can
// be exercised by fast, isolated unit tests. The cyberware CWP cap lives in
// ./cyberware-cap and is composed with these checks by the route layer.
//
// The one non-trivial dependency, hasRole, is itself pure (it only matches role
// names against a static table), so it's safe to import here.
import { hasRole } from "./discord";

// Fields that must be present (non-empty strings) on every submitted sheet:
// Identity (sheetType/fullName/pronouns/occupation), Physical Description,
// Psychological Profile, and Background. Skills/Gear are validated separately
// (free-text + list). Cyberware is optional — organic characters are valid.
export const REQUIRED_SHEET_FIELDS = [
  "sheetType",
  "fullName",
  "pronouns",
  "occupation",
  "psychProfile",
  "physicalDescription",
  "background",
] as const;

// Runs every non-cyberware submission rule. Returns null on success, or an error
// message on the first failed rule. `roles` is the submitting user's role list;
// it gates NPC sheets to fixers/admins only. Cyberware is validated separately.
export function validateSheetFields(data: unknown, roles: string[]): string | null {
  if (!data || typeof data !== "object") return "data required";
  const d = data as Record<string, unknown>;

  for (const f of REQUIRED_SHEET_FIELDS) {
    if (typeof d[f] !== "string" || !(d[f] as string).trim()) {
      return `Missing required field: ${f}`;
    }
  }

  if (!["PC", "NPC"].includes(d.sheetType as string)) {
    return "sheetType must be PC or NPC";
  }

  if (d.sheetType === "NPC" && !hasRole(roles, "FIXER") && !hasRole(roles, "ADMIN")) {
    return "Only fixers can create NPC sheets";
  }

  if (typeof d.age !== "number" || (d.age as number) <= 0) {
    return "Missing required field: age (positive integer)";
  }

  // Skills is now free-text. Accept a non-empty string (current) or a legacy
  // non-empty object (older drafts) so they can still be resubmitted.
  const skills = d.skills;
  const skillsOk =
    (typeof skills === "string" && skills.trim().length > 0) ||
    (skills != null && typeof skills === "object" && Object.keys(skills as object).length > 0);
  if (!skillsOk) {
    return "Missing required field: skills";
  }

  // Gear/equipment is optional — a sheet may be submitted with no starting gear.

  // Portrait and stats images are required to submit (but not to save a draft).
  const portraits = d.portraitUrls;
  if (!Array.isArray(portraits) || portraits.filter((u) => typeof u === "string" && u.trim()).length === 0) {
    return "Missing required field: portrait image (at least one)";
  }
  const stats = d.statsImageUrls;
  if (!Array.isArray(stats) || stats.filter((u) => typeof u === "string" && u.trim()).length === 0) {
    return "Missing required field: stats image (at least one)";
  }

  return null;
}

// Normalize a gun name for catalog comparison: lower-case and strip every
// non-alphanumeric so "Militech  Widow-Maker," matches the catalog entry.
// Mirrors the server's looseNameKey (lib/strings.ts) — the tech-gun names
// passed in are already keyed that way (they come from the loose-keyed catalog
// map), so both sides of the comparison must normalize identically.
function normalizeGunName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// New characters may not start with Tech weapons. Given the sheet's `guns`
// list and the (already-fetched) catalog names of Tech-type guns, return the
// first offending entry name, or null when the list is clean. Matching is
// normalized-exact OR containment (an entered "Widow Maker (modded)" still
// matches the catalog's "Widow Maker") so a decorated entry can't slip past.
// Free-typed names with no catalog resemblance still pass — staff review
// remains the backstop for those.
export function findTechStartingGun(guns: unknown, techGunNames: string[]): string | null {
  if (!Array.isArray(guns)) return null;
  const tech = techGunNames.map(normalizeGunName).filter((n) => n.length > 0);
  if (tech.length === 0) return null;
  for (const g of guns) {
    if (typeof g !== "string") continue;
    const entered = normalizeGunName(g);
    if (!entered) continue;
    if (tech.some((t) => entered === t || entered.includes(t))) {
      return g.trim();
    }
  }
  return null;
}
