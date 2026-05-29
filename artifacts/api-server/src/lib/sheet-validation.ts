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

  const gearList = d.gear;
  if (!Array.isArray(gearList) || gearList.filter((g) => typeof g === "string" && g.trim()).length === 0) {
    return "Missing required field: gear/equipment (at least one entry)";
  }

  return null;
}
