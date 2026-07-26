import { db, characters, characterTagOptions, users } from "@workspace/db";
import { eq, isNotNull, ne, and } from "drizzle-orm";
import { addGuildMemberRole, removeGuildMemberRole } from "./discord";
import { mergeTags, normalizeTag } from "./characterTags";
import { logger } from "./logger";

// Sync Discord roles derived from character tags. Tag options may carry a
// discordRoleId (fixer-managed); when a character gains such a tag its OWNER
// earns the mapped Discord role, and when it loses the tag the role is
// removed — unless another character owned by the same player still carries
// the tag. Best-effort and fire-and-forget: callers `void` this AFTER the tag
// write commits; Discord misses must never block or roll back a tag edit.
// addGuildMemberRole / removeGuildMemberRole are idempotent and gated behind
// externalWritesAllowed(), so dev environments only log.
export async function syncTagRolesForCharacter(
  characterId: number,
  addedTags: string[],
  removedTags: string[],
  reason: string,
): Promise<void> {
  try {
    if (addedTags.length === 0 && removedTags.length === 0) return;
    const linked = await db
      .select({
        name: characterTagOptions.name,
        discordRoleId: characterTagOptions.discordRoleId,
      })
      .from(characterTagOptions)
      .where(isNotNull(characterTagOptions.discordRoleId));
    if (linked.length === 0) return;
    const roleByTag = new Map<string, string>();
    for (const o of linked) {
      const key = normalizeTag(o.name).toLowerCase();
      if (key && o.discordRoleId) roleByTag.set(key, o.discordRoleId);
    }
    const addRoles = new Map<string, string>(); // roleId -> tag name (for the reason)
    for (const t of addedTags) {
      const key = normalizeTag(t).toLowerCase();
      const roleId = roleByTag.get(key);
      if (roleId) addRoles.set(roleId, t);
    }
    const removeRoles = new Map<string, string>();
    for (const t of removedTags) {
      const key = normalizeTag(t).toLowerCase();
      const roleId = roleByTag.get(key);
      // A tag both added and removed in one call (shouldn't happen) nets to add.
      if (roleId && !addRoles.has(roleId)) removeRoles.set(roleId, t);
    }
    if (addRoles.size === 0 && removeRoles.size === 0) return;
    const [c] = await db
      .select({ ownerId: characters.ownerId })
      .from(characters)
      .where(eq(characters.id, characterId));
    if (!c?.ownerId) return; // unclaimed character — nobody to grant to
    const [owner] = await db
      .select({ discordId: users.discordId })
      .from(users)
      .where(eq(users.id, c.ownerId));
    if (!owner?.discordId) return;
    // Removal guard: if ANOTHER character owned by the same player still
    // carries a role-linked tag, keep the role.
    if (removeRoles.size > 0) {
      const siblings = await db
        .select({ appliedTags: characters.appliedTags, manualTags: characters.manualTags })
        .from(characters)
        .where(and(eq(characters.ownerId, c.ownerId), ne(characters.id, characterId)));
      const siblingTagKeys = new Set<string>();
      for (const s of siblings) {
        for (const t of mergeTags(s.appliedTags, s.manualTags)) {
          siblingTagKeys.add(t.toLowerCase());
        }
      }
      for (const [roleId, tag] of Array.from(removeRoles.entries())) {
        if (siblingTagKeys.has(normalizeTag(tag).toLowerCase())) removeRoles.delete(roleId);
      }
    }
    for (const [roleId, tag] of addRoles) {
      await addGuildMemberRole(owner.discordId, roleId, `Character tag "${tag}" — ${reason}`);
    }
    for (const [roleId, tag] of removeRoles) {
      await removeGuildMemberRole(owner.discordId, roleId, `Character tag "${tag}" removed — ${reason}`);
    }
  } catch (err) {
    logger.warn({ err, characterId, addedTags, removedTags }, "syncTagRolesForCharacter failed");
  }
}
