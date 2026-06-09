// Shared role/user definitions for the e2e suite. These users are seeded into
// the dev/Test database by the global setup and signed in via the dev-only
// /api/auth/test-login backdoor (no Discord OAuth). All ids are deterministic
// and prefixed so they never collide with real imported members.

export const TEST_PREFIX = "e2e-";

export type RoleKey =
  | "player"
  | "fixer"
  | "archivist"
  | "admin"
  | "csapprover"
  | "fresh"
  | "unverified";

export interface SeedUser {
  key: RoleKey;
  id: string;
  username: string;
  /** Lowercased Discord role names; drives isFixer/isAdmin/isArchivist/isCsApprover. */
  roles: string[];
  verified18: boolean;
  rulesAccepted: boolean;
}

export const ROLES: SeedUser[] = [
  // The normal member: age-verified, rules accepted, no staff roles.
  { key: "player", id: `${TEST_PREFIX}player`, username: "E2E Player", roles: [], verified18: true, rulesAccepted: true },
  // Staff roles.
  { key: "fixer", id: `${TEST_PREFIX}fixer`, username: "E2E Fixer", roles: ["fixer"], verified18: true, rulesAccepted: true },
  { key: "archivist", id: `${TEST_PREFIX}archivist`, username: "E2E Archivist", roles: ["archivist"], verified18: true, rulesAccepted: true },
  { key: "admin", id: `${TEST_PREFIX}admin`, username: "E2E Admin", roles: ["admin"], verified18: true, rulesAccepted: true },
  { key: "csapprover", id: `${TEST_PREFIX}csapprover`, username: "E2E CS Approver", roles: ["cs approver"], verified18: true, rulesAccepted: true },
  // Gate fixtures. `fresh` has not accepted the rules (rules gate); `unverified`
  // lacks the 18+ role (verification gate). Both are reset every run by the seed.
  { key: "fresh", id: `${TEST_PREFIX}fresh`, username: "E2E Fresh", roles: [], verified18: true, rulesAccepted: false },
  { key: "unverified", id: `${TEST_PREFIX}unverified`, username: "E2E Unverified", roles: [], verified18: false, rulesAccepted: true },
];

export function roleById(key: RoleKey): SeedUser {
  const r = ROLES.find((x) => x.key === key);
  if (!r) throw new Error(`Unknown role key: ${key}`);
  return r;
}

/** storageState path (relative to the package root / Playwright cwd). */
export function stateFile(key: RoleKey): string {
  return `e2e/.auth/${key}.json`;
}

export const BASE_URL = `https://${process.env.REPLIT_DEV_DOMAIN}`;
