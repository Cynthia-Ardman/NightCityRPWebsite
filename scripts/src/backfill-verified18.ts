import { inArray } from "drizzle-orm";
import { db, pool, users } from "@workspace/db";

/**
 * One-off backfill for the age-verification gate.
 *
 * Walks the guild's member list (via the bot token) and flips
 * `users.verified18 = true` for every existing portal user who currently holds
 * the "Verified 18+" Discord role. New logins compute this flag automatically
 * in the auth callback; this script seeds the flag for members who were imported
 * or who logged in before the gate existed.
 *
 * Idempotent: only the holders found in the guild are set to true; it does NOT
 * clear the flag for anyone (a transient pagination failure must never lock out
 * verified members). Run again any time to pick up newly-verified members.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-verified18.ts
 */

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VERIFIED_18_ROLE_ID = "1351048862323834952";
const API = "https://discord.com/api/v10";

if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN missing");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("DISCORD_GUILD_ID missing");
  process.exit(1);
}

async function collectHolders(): Promise<string[]> {
  const holders: string[] = [];
  let after = "0";
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${API}/guilds/${GUILD_ID}/members?limit=1000&after=${after}`,
      {
        headers: { Authorization: `Bot ${TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`members fetch failed: ${res.status} ${body}`);
    }
    const members = (await res.json()) as Array<{
      user?: { id: string };
      roles?: string[];
    }>;
    if (members.length === 0) break;
    for (const m of members) {
      if (m.user && m.roles?.includes(VERIFIED_18_ROLE_ID)) {
        holders.push(m.user.id);
      }
    }
    after = members[members.length - 1]?.user?.id ?? after;
    if (members.length < 1000) break;
  }
  return holders;
}

async function main() {
  console.log("Collecting Verified 18+ holders from Discord…");
  const holders = await collectHolders();
  console.log(`Discord reports ${holders.length} members with the role.`);

  if (holders.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Only touch rows that actually exist as portal users (a user's id IS their
  // Discord snowflake) and aren't already flagged.
  const existing = await db
    .select({ id: users.id, verified18: users.verified18 })
    .from(users)
    .where(inArray(users.id, holders));

  const toSet = existing.filter((u) => !u.verified18).map((u) => u.id);
  console.log(
    `${existing.length} of the holders are portal users; ${toSet.length} need updating.`,
  );

  if (toSet.length > 0) {
    await db
      .update(users)
      .set({ verified18: true })
      .where(inArray(users.id, toSet));
    console.log(`Set verified18=true for ${toSet.length} users.`);
  } else {
    console.log("All matching portal users already verified.");
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
