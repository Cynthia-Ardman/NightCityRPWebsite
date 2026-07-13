import { useGetGunMechanicsOverrides } from "@workspace/api-client-react";
import type { GunMechanicsOverrides } from "./gunMechanics";

// Fetches the admin text overrides for the shared gun-mechanics copy (Weapons
// guidebook page + gun-catalog hover blurbs). Returns an empty object while
// loading or on error, so callers seamlessly render the code defaults.
export function useGunMechanicsOverrides(): GunMechanicsOverrides {
  const { data } = useGetGunMechanicsOverrides();
  return (data?.overrides ?? {}) as GunMechanicsOverrides;
}
