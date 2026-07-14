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
] as const;

export type DistrictValue = (typeof DISTRICTS)[number]["value"];

export function districtLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return DISTRICTS.find((d) => d.value === value)?.label ?? value;
}
