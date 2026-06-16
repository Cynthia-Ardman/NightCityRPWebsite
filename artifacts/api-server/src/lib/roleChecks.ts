import { hasRole } from "./discord";

// Shared role predicates. Centralized so the staff/admin gating used across
// route files (housing, requests, lore, guidebook, stores, ...) stays identical
// and can't drift between copies.

export function isAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN");
}

export function isFixerOrAdmin(user: { roles: string[] }): boolean {
  return hasRole(user.roles, "ADMIN") || hasRole(user.roles, "FIXER");
}

// Same as isFixerOrAdmin but for call sites that hold the bare roles array.
export function isStaffRoles(roles: string[]): boolean {
  return hasRole(roles, "ADMIN") || hasRole(roles, "FIXER");
}
