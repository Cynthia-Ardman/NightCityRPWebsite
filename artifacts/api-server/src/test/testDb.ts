import { db, pool, users, characters } from "@workspace/db";

// Wipes every table in the test database between cases. Reads the table list
// dynamically so new tables are covered automatically without maintaining a
// hardcoded list. RESTART IDENTITY keeps serial ids predictable per test.
export async function truncateAll(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export async function createUser(
  opts: { id?: string; username?: string; roles?: string[]; activeCharacterId?: number | null } = {},
) {
  const id = opts.id ?? uniq("user");
  const [u] = await db
    .insert(users)
    .values({
      id,
      discordId: id,
      username: opts.username ?? `name_${id}`,
      roles: opts.roles ?? [],
      activeCharacterId: opts.activeCharacterId ?? null,
    })
    .returning();
  return u;
}

export function createAdmin(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["admin"] });
}

export async function createCharacter(
  opts: {
    ownerId?: string | null;
    name?: string;
    kind?: string;
    approved?: boolean;
    lifeStatus?: string;
    cyberwareLevel?: string;
  } = {},
) {
  const [c] = await db
    .insert(characters)
    .values({
      ownerId: opts.ownerId ?? null,
      name: opts.name ?? uniq("Char"),
      kind: opts.kind ?? "pc",
      approved: opts.approved ?? true,
      lifeStatus: opts.lifeStatus ?? "active",
      cyberwareLevel: opts.cyberwareLevel ?? "none",
    })
    .returning();
  return c;
}
