// Canonical Night City district tags. Values must match the OpenAPI
// LoreDistrict enum (lib/api-spec/openapi.yaml) and DISTRICTS in the
// api-server lore routes. Labels are the display names used on the map,
// lore badges, and the lore editor dropdown.
export const DISTRICTS = [
  { value: "watson", label: "Watson" },
  { value: "westbrook", label: "Westbrook" },
  { value: "city_center", label: "City Center" },
  { value: "heywood", label: "Heywood" },
  { value: "santo_domingo", label: "Santo Domingo" },
  { value: "pacifica", label: "Pacifica" },
  { value: "north_badlands", label: "North Badlands" },
  { value: "eastern_badlands", label: "Eastern Badlands" },
  { value: "southern_badlands", label: "Southern Badlands" },
  { value: "beastside", label: "Beastside" },
] as const;

export type DistrictValue = (typeof DISTRICTS)[number]["value"];

export function districtLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return DISTRICTS.find((d) => d.value === value)?.label ?? value;
}

// Canonical Night City sub-district (neighborhood) tags. Values must match the
// OpenAPI LoreSubDistrict enum and SUB_DISTRICTS in the api-server lore routes.
// Each sub-district belongs to exactly one parent district; the map component
// (CityMap) keys its traced neighborhood polygons on these values.
export const SUB_DISTRICTS = [
  { value: "northside", label: "Northside", parent: "watson" },
  { value: "arasaka_waterfront", label: "Arasaka Waterfront", parent: "watson" },
  { value: "kabuki", label: "Kabuki", parent: "watson" },
  { value: "little_china", label: "Little China", parent: "watson" },
  { value: "japantown", label: "Japantown", parent: "westbrook" },
  { value: "north_oaks", label: "North Oaks", parent: "westbrook" },
  { value: "charter_hill", label: "Charter Hill", parent: "westbrook" },
  { value: "casino", label: "Casino", parent: "westbrook" },
  { value: "downtown", label: "Downtown", parent: "city_center" },
  { value: "corpo_plaza", label: "Corpo Plaza", parent: "city_center" },
  { value: "wellsprings", label: "Wellsprings", parent: "heywood" },
  { value: "the_glen", label: "The Glen", parent: "heywood" },
  { value: "vista_del_rey", label: "Vista Del Rey", parent: "heywood" },
  { value: "arroyo", label: "Arroyo", parent: "santo_domingo" },
  { value: "rancho_coronado", label: "Rancho Coronado", parent: "santo_domingo" },
  { value: "coast_view", label: "Coast View", parent: "pacifica" },
  { value: "west_wind_estate", label: "West Wind Estate", parent: "pacifica" },
  { value: "dogtown", label: "Dogtown", parent: "pacifica" },
] as const satisfies readonly { value: string; label: string; parent: DistrictValue }[];

export type SubDistrictValue = (typeof SUB_DISTRICTS)[number]["value"];

export function subDistrictLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return SUB_DISTRICTS.find((s) => s.value === value)?.label ?? value;
}

export function subDistrictParent(value: string | null | undefined): DistrictValue | null {
  if (!value) return null;
  return SUB_DISTRICTS.find((s) => s.value === value)?.parent ?? null;
}
