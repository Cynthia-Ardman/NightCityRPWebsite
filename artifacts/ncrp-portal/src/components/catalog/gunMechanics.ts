// Single source of truth for the in-game gun mechanics reference, drawn from
// the staff weapons spreadsheet. Consumed by BOTH the Weapons guidebook page
// (full reference) and the gun catalog hover explanations (per-cell blurbs), so
// the wording can never drift between the two surfaces.
import {
  canonicalLabel,
  GUN_CATEGORIES,
  GUN_POWER_LEVELS,
  GUN_POWER_LEVEL_ALIASES,
  GUN_RESTRICTIONS,
} from "./gunTypes";

export type MechanicEntry = { label: string; blurb: string };

// Keyed on the canonical category label (Power / Tech / Smart).
export const GUN_CATEGORY_INFO: Record<string, MechanicEntry> = {
  Power: {
    label: "Power",
    blurb: "Power guns are regular guns that hit hard and can ricochet.",
  },
  Smart: {
    label: "Smart",
    blurb:
      "Smart guns are lock-on guns whose bullets track targets as long as the shooter keeps the target in sight.",
  },
  Tech: {
    label: "Tech",
    blurb: "Tech guns are charge-up guns that can punch through cover.",
  },
};

// Keyed on the canonical power level (L / M / H).
export const GUN_POWER_INFO: Record<string, MechanicEntry> = {
  L: {
    label: "Low",
    blurb: "A cheap gun that can hurt unarmored targets — usually the cheaper option.",
  },
  M: {
    label: "Medium",
    blurb: "Can punch through light armor and deals enough damage to easily kill.",
  },
  H: {
    label: "High",
    blurb: "Can crack armor, shoot long distances, or fire at an extreme rate.",
  },
};

// Keyed on the canonical restriction label (Basic / Controlled / Restricted).
export const GUN_RESTRICTION_INFO: Record<string, MechanicEntry> = {
  Basic: { label: "Basic", blurb: "Requires money and that's it." },
  Controlled: {
    label: "Controlled",
    blurb: "Requires money plus approval from the store owner.",
  },
  Restricted: {
    label: "Restricted",
    blurb: "Requires money, store owner approval, and Fixer approval.",
  },
};

// Power-level color codes from the spreadsheet. Power guns and Tech/Smart guns
// use different palettes for the same Low/Medium/High tiers.
export const GUN_POWER_COLORS = {
  power: { L: "#FFFFFF", M: "#FF9900", H: "#FF0000" },
  techSmart: { L: "#01FFFF", M: "#0000FF", H: "#9900FF" },
} as const;

// Caliber examples grouped by power tier (examples, not exhaustive).
export const GUN_CALIBERS: Record<"L" | "M" | "H", string[]> = {
  L: [".22 LR", ".380 ACP", "9mm", ".40 S&W", ".45 ACP", "10mm"],
  M: [
    "5.7 FN",
    ".38 Special",
    ".357 Magnum",
    ".44 Magnum",
    ".50 AE",
    "5.56",
    "7.72",
    ".308",
    "30.06",
  ],
  H: [".300 Win Mag", ".338 Lapua", ".50 BMG"],
};

// Miscellaneous weapon rules from the spreadsheet.
export const GUN_MISC_RULES: string[] = [
  "All used guns need small repairs (missing parts or electronics) before they're fully functional again — the seller tells the buyer what the gun needs.",
  "Tech weapons are marked at their default power level, but when charged they fire a stronger round (with a color change when fired) and are considered piercing damage.",
  "Smart EMP guns have a low, percent-based chance to EMP.",
];

// Resolve a stored category value to its mechanics blurb (or null if it's a
// custom/off-list value we don't have copy for).
export function categoryInfo(category: string | null | undefined): MechanicEntry | null {
  const key = canonicalLabel(category, GUN_CATEGORIES);
  return GUN_CATEGORY_INFO[key] ?? null;
}

// Resolve a stored power-level value to its mechanics blurb.
export function powerInfo(powerLevel: string | null | undefined): MechanicEntry | null {
  const key = canonicalLabel(powerLevel, GUN_POWER_LEVELS, GUN_POWER_LEVEL_ALIASES);
  return GUN_POWER_INFO[key] ?? null;
}

// Resolve a stored restriction value to its acquisition blurb.
export function restrictionInfo(restriction: string | null | undefined): MechanicEntry | null {
  const key = canonicalLabel(restriction, GUN_RESTRICTIONS);
  return GUN_RESTRICTION_INFO[key] ?? null;
}

// Pick the swatch color for a gun's power tier, using the palette appropriate to
// its category family (Power vs Tech/Smart). Returns null when either the tier
// or the category can't be resolved, so callers can fall back to plain text.
export function powerColor(
  category: string | null | undefined,
  powerLevel: string | null | undefined,
): string | null {
  const tier = canonicalLabel(powerLevel, GUN_POWER_LEVELS, GUN_POWER_LEVEL_ALIASES);
  if (tier !== "L" && tier !== "M" && tier !== "H") return null;
  const cat = canonicalLabel(category, GUN_CATEGORIES);
  if (cat === "Power") return GUN_POWER_COLORS.power[tier];
  if (cat === "Tech" || cat === "Smart") return GUN_POWER_COLORS.techSmart[tier];
  return null;
}
