export type Gun = {
  id: number;
  name: string;
  category?: string | null;
  manufacturer?: string | null;
  damage?: string | null;
  magSize?: number | null;
  price: number;
  notes?: string | null;
  wholesalePrice?: number | null;
  restriction?: string | null;
  status?: string | null;
  powerLevel?: string | null;
  weaponType?: string | null;
  fireMode?: string | null;
  imageUrl?: string | null;
};

// Common fire-mode presets offered in the editor. Stored as free text so the
// catalog can still hold anything legacy/imported, but staff get one-tap presets.
export const FIRE_MODES = ["Semi-Auto", "Burst", "Full-Auto"] as const;

// Dropdown presets for the gun classification fields. Each field still keeps a
// "Custom…" escape (see SelectOrCustom), so anything off-list is allowed. Values
// are the human-readable forms we store going forward; legacy lowercase/
// underscore/abbreviated rows resolve to these via the alias maps below.
export const GUN_CATEGORIES = ["Power", "Tech", "Smart"] as const;
export const GUN_WEAPON_TYPES = [
  "Pistol",
  "Revolver",
  "SMG",
  "Assault Rifle",
  "Precision Rifle",
  "Sniper",
  "Shotgun",
  "LMG",
  "HMG",
] as const;
export const GUN_POWER_LEVELS = ["Low", "Medium", "High"] as const;
export const GUN_RESTRICTIONS = ["Basic", "Controlled", "Restricted"] as const;

// Alias maps keyed on the canonical (lowercased, separator-stripped) form of a
// stored value, so imported variants land on the right preset instead of
// showing a false "Custom…". Direct case/separator matches are handled by
// SelectOrCustom itself; only genuinely different spellings need an entry here.
export const GUN_WEAPON_TYPE_ALIASES: Record<string, string> = {
  submachinegun: "SMG",
  lightmachinegun: "LMG",
  heavymachinegun: "HMG",
  sniperrifle: "Sniper",
};
export const GUN_POWER_LEVEL_ALIASES: Record<string, string> = {
  l: "Low",
  m: "Medium",
  h: "High",
  med: "Medium",
};

// Catalog imports left raw values like "heavy_machine_gun" / "POWER" /
// "tech-shotgun". Normalise on render so the listing reads like English
// without having to scrub the database. Underscores AND hyphens collapse
// to spaces, then we Title Case each word.
export function humanize(v: string | null | undefined): string {
  if (!v) return "—";
  const cleaned = String(v).replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "—";
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export const GUN_STATUSES = ["draft", "live", "retired"] as const;
export type GunStatus = (typeof GUN_STATUSES)[number];

// Shared editable form shape. Numbers are held as strings while editing so
// inputs can be cleared without coercing to 0; convert on submit.
export type GunFormState = {
  name: string;
  status: GunStatus;
  manufacturer: string;
  category: string;
  weaponType: string;
  fireMode: string;
  powerLevel: string;
  restriction: string;
  price: string;
  wholesalePrice: string;
  damage: string;
  magSize: string;
  notes: string;
  imageUrl: string;
};

export function emptyForm(): GunFormState {
  return {
    name: "",
    status: "draft",
    manufacturer: "",
    category: "",
    weaponType: "",
    fireMode: "",
    powerLevel: "",
    restriction: "",
    price: "0",
    wholesalePrice: "",
    damage: "",
    magSize: "",
    notes: "",
    imageUrl: "",
  };
}

export function formFromGun(g: Gun): GunFormState {
  const status = (g.status ?? "draft").toLowerCase();
  return {
    name: g.name ?? "",
    status: (GUN_STATUSES as readonly string[]).includes(status)
      ? (status as GunStatus)
      : "live",
    manufacturer: g.manufacturer ?? "",
    category: g.category ?? "",
    weaponType: g.weaponType ?? "",
    fireMode: g.fireMode ?? "",
    powerLevel: g.powerLevel ?? "",
    restriction: g.restriction ?? "",
    price: String(g.price ?? 0),
    wholesalePrice: g.wholesalePrice == null ? "" : String(g.wholesalePrice),
    damage: g.damage ?? "",
    magSize: g.magSize == null ? "" : String(g.magSize),
    notes: g.notes ?? "",
    imageUrl: g.imageUrl ?? "",
  };
}

// Turn a form string field into a nullable trimmed string for the API.
function textOrNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

// Turn a form numeric string into a nullable integer for the API.
function intOrNull(s: string): number | null {
  const t = s.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Build the full create payload from the form.
export function formToCreatePayload(f: GunFormState) {
  const priceN = intOrNull(f.price);
  return {
    name: f.name.trim(),
    status: f.status,
    manufacturer: textOrNull(f.manufacturer),
    category: textOrNull(f.category),
    weaponType: textOrNull(f.weaponType),
    fireMode: textOrNull(f.fireMode),
    powerLevel: textOrNull(f.powerLevel),
    restriction: textOrNull(f.restriction),
    price: priceN ?? 0,
    wholesalePrice: intOrNull(f.wholesalePrice),
    damage: textOrNull(f.damage),
    magSize: intOrNull(f.magSize),
    notes: textOrNull(f.notes),
    imageUrl: textOrNull(f.imageUrl),
  };
}

// Build a patch containing ONLY the fields that differ from the original gun,
// so the audit log records a tight before/after diff and the API doesn't 400
// on a no-op edit.
export function formToPatch(f: GunFormState, original: Gun): Record<string, unknown> {
  const next = formToCreatePayload(f);
  const cur = {
    name: original.name ?? "",
    status: (original.status ?? "draft").toLowerCase(),
    manufacturer: original.manufacturer ?? null,
    category: original.category ?? null,
    weaponType: original.weaponType ?? null,
    fireMode: original.fireMode ?? null,
    powerLevel: original.powerLevel ?? null,
    restriction: original.restriction ?? null,
    price: original.price ?? 0,
    wholesalePrice: original.wholesalePrice ?? null,
    damage: original.damage ?? null,
    magSize: original.magSize ?? null,
    notes: original.notes ?? null,
    imageUrl: original.imageUrl ?? null,
  };
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (JSON.stringify(next[key] ?? null) !== JSON.stringify(cur[key] ?? null)) {
      patch[key] = next[key];
    }
  }
  return patch;
}
