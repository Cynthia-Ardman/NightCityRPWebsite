import { and, eq } from "drizzle-orm";
import { db, characters, type Character } from "@workspace/db";
import { hasRole } from "./discord";

// Character-access helpers shared by the routes that operate on a character on
// behalf of its owner or of staff (fixer/admin). Centralized so the
// "staff may touch any character, players only their own" rule can't drift
// between route files.

// Null-tolerant staff predicate (some callers hold users whose roles column
// may be null).
export function isStaffUser(user: { roles?: string[] | null }): boolean {
  return hasRole(user.roles ?? [], "ADMIN") || hasRole(user.roles ?? [], "FIXER");
}

// The character row iff it exists AND is owned by userId, else null (callers
// 404 without leaking whether the id exists).
export async function loadOwnedChar(userId: string, id: number): Promise<Character | null> {
  const [c] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, userId)));
  return c ?? null;
}

// Inventory CRUD is a "one-stop-shop" for staff: fixers/admins may add/edit/
// remove items (gear, guns, cyberware) on ANY character from the edit dialog,
// while players remain scoped to their own characters. Returns the character
// row if the caller is staff (any character) or the owner (their own), else
// null so callers 404 exactly as before.
export async function loadOwnedOrStaffChar(
  user: { id: string; roles?: string[] | null },
  id: number,
): Promise<Character | null> {
  if (isStaffUser(user)) {
    const [c] = await db.select().from(characters).where(eq(characters.id, id));
    return c ?? null;
  }
  return loadOwnedChar(user.id, id);
}
