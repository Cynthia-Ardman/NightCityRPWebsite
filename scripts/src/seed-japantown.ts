import { and, eq, sql } from "drizzle-orm";
import { db, pool, catalogRent, catalogDistricts } from "@workspace/db";

/**
 * Seeds the Japantown district and its 6 business properties.
 *
 * Idempotent by (district, name): rows are only INSERTED when missing — an
 * existing row is never updated, so staff edits made in the portal survive
 * re-runs. No deletes.
 */

const DISTRICT = "Japantown";

type Seed = {
  name: string;
  tier: string | null;
  monthlyRent: number;
  leasable: boolean;
  description: string;
};

const LISTINGS: Seed[] = [
  {
    name: "Pharmacy",
    tier: null,
    monthlyRent: 0,
    leasable: false,
    description:
      "Ripper & Clinic. Claw-owned — not for lease. Open to contractors.",
  },
  {
    name: "Hikigane",
    tier: "Business Tier 1",
    monthlyRent: 2000,
    leasable: true,
    description: "Gun Store. Upgradeable to higher tiers.",
  },
  {
    name: "Pawn Shop",
    tier: "Business Tier 1",
    monthlyRent: 2000,
    leasable: true,
    description: "Pawn, tech, and melee weapons.",
  },
  {
    name: "Sushi",
    tier: "Business Tier 1",
    monthlyRent: 2000,
    leasable: true,
    description: "Food and drink (beer, sake, soda).",
  },
  {
    name: "Ramen",
    tier: "Business Tier 1",
    monthlyRent: 2000,
    leasable: true,
    description: "Food and non-drink (beers and sodas).",
  },
  {
    name: "Bar",
    tier: "Business Tier 1",
    monthlyRent: 2000,
    leasable: true,
    description: "Bar and entertainment.",
  },
];

async function main() {
  // District: unique on name; keep whatever exists.
  await db.insert(catalogDistricts).values({ name: DISTRICT }).onConflictDoNothing();

  let inserted = 0;
  let skipped = 0;
  for (const l of LISTINGS) {
    const [existing] = await db
      .select({ id: catalogRent.id })
      .from(catalogRent)
      .where(
        and(
          eq(catalogRent.district, DISTRICT),
          sql`lower(${catalogRent.name}) = lower(${l.name})`,
        ),
      )
      .limit(1);
    if (existing) {
      skipped++;
      console.log(`skip (exists): ${l.name} [id=${existing.id}]`);
      continue;
    }
    const [row] = await db
      .insert(catalogRent)
      .values({
        name: l.name,
        district: DISTRICT,
        tier: l.tier,
        monthlyRent: l.monthlyRent,
        description: l.description,
        imageUrl: null,
        kind: "business",
        leasable: l.leasable,
      })
      .returning({ id: catalogRent.id });
    inserted++;
    console.log(`inserted: ${l.name} [id=${row.id}]`);
  }
  console.log(`done — inserted ${inserted}, skipped ${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
