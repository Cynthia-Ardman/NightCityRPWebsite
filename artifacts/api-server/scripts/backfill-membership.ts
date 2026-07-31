// One-off/resumable backfill of Discord membership events (growth timeline).
// Safe to re-run: the ingest walks forward from a stored cursor and inserts
// are idempotent. Run repeatedly until it prints caughtUp: true.
//   npx tsx scripts/backfill-membership.ts [maxPages]
import { ingestDiscordMembershipEvents } from "../src/lib/membershipEvents";

async function main() {
  const maxPages = Number(process.argv[2] ?? 350);
  const r = await ingestDiscordMembershipEvents({ maxPages });
  console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((err) => {
  console.error("backfill failed:", err?.message ?? err);
  process.exit(1);
});
