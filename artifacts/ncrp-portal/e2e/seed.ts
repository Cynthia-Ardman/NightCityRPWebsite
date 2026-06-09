// Database seeding helpers for the e2e suite. We talk to the dev/Test database
// directly with `pg` (raw SQL) rather than importing the workspace Drizzle
// package, to avoid TypeScript-transpile-of-dependency issues under Playwright's
// loader. Everything seeded here is namespaced with the `e2e-` prefix so a rerun
// is idempotent and never disturbs real imported data.

import pg from "pg";
import { ROLES, TEST_PREFIX } from "./fixtures/roles";

const { Pool } = pg;

export async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to seed the e2e database.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Upsert every test user, resetting role/gate flags each run so the suite is deterministic. */
export async function seedUsers(pool: pg.Pool): Promise<void> {
  for (const u of ROLES) {
    await pool.query(
      `insert into users (id, discord_id, username, roles, verified18, rules_accepted, login_count)
       values ($1, $2, $3, $4, $5, $6, 1)
       on conflict (id) do update set
         username = excluded.username,
         roles = excluded.roles,
         verified18 = excluded.verified18,
         rules_accepted = excluded.rules_accepted`,
      [u.id, u.id, u.username, u.roles, u.verified18, u.rulesAccepted],
    );
  }
}

/** A stable character owned by the player, plus a small wallet ledger, for the
 *  character/wallet/ledger journeys. Idempotent: re-seeds the same named row. */
export interface SeededCharacter {
  id: number;
  name: string;
}

// Seeded ledger memos, asserted against in the wallet spec. The account balance
// itself comes from UnbelievaBoat (per discordId) and is not seedable, so the
// transactions are the deterministic, DB-backed visible outcome.
export const STARTING_FUNDS_MEMO = "E2E seed: starting funds";
export const GEAR_PURCHASE_MEMO = "E2E seed: gear purchase";

export async function seedPlayerCharacter(pool: pg.Pool): Promise<SeededCharacter> {
  const ownerId = `${TEST_PREFIX}player`;
  const name = "E2E Test Runner";
  const existing = await pool.query<{ id: number }>(
    `select id from characters where owner_id = $1 and name = $2 limit 1`,
    [ownerId, name],
  );
  let id: number;
  if (existing.rows[0]) {
    id = existing.rows[0].id;
    await pool.query(`update characters set kind = 'pc', claimed = true where id = $1`, [id]);
  } else {
    const inserted = await pool.query<{ id: number }>(
      `insert into characters (owner_id, name, kind, claimed, archetype, background)
       values ($1, $2, 'pc', true, 'Solo', 'Seeded by the e2e suite.')
       returning id`,
      [ownerId, name],
    );
    id = inserted.rows[0].id;
  }

  // Reset and re-seed a tiny, deterministic ledger for this character.
  await pool.query(`delete from wallet_transactions where character_id = $1 and source = 'e2e'`, [id]);
  const ledger: Array<[number, string, string]> = [
    [50000, "credit", "E2E seed: starting funds"],
    [-12500, "debit", "E2E seed: gear purchase"],
  ];
  for (const [amount, kind, memo] of ledger) {
    await pool.query(
      `insert into wallet_transactions (character_id, user_id, amount, kind, memo, category, source, sync_status)
       values ($1, $2, $3, $4, $5, 'other', 'e2e', 'synced')`,
      [id, ownerId, amount, kind, memo],
    );
  }
  return { id, name };
}

export async function seedAll(): Promise<{ playerCharacter: SeededCharacter }> {
  return withPool(async (pool) => {
    await seedUsers(pool);
    const playerCharacter = await seedPlayerCharacter(pool);
    return { playerCharacter };
  });
}
