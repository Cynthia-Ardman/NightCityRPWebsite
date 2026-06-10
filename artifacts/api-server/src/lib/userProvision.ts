import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchDiscordUser } from "./discord";

// Resolve a Discord id to a `users` row, provisioning a minimal stub for a
// Discord member who has never signed in to the portal. The portal lets staff
// act on ANY guild member (assign a character as their owner, pay them as an
// actor, etc.); if the target has no `users` row yet we mint one keyed on their
// Discord id — which is also the users PK. When that member later signs in, the
// OAuth callback's upsert matches this same id and fills in the live session
// fields, so the data we set now (ownership, actor-payment history) is preserved
// seamlessly. Returns the row, or null if the id matches neither an existing
// user nor a reachable Discord user.
export async function resolveOrProvisionUser(
  discordId: string,
): Promise<typeof users.$inferSelect | null> {
  const [existing] = await db.select().from(users).where(eq(users.id, discordId));
  if (existing) return existing;
  const profile = await fetchDiscordUser(discordId);
  if (!profile) return null;
  const [created] = await db
    .insert(users)
    .values({
      id: profile.id,
      discordId: profile.id,
      username: profile.username,
      globalName: profile.globalName,
      avatarUrl: profile.avatarUrl,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost an insert race — read the row the other writer just created.
  const [row] = await db.select().from(users).where(eq(users.id, discordId));
  return row ?? null;
}
