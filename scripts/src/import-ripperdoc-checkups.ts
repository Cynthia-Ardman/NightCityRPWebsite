/**
 * Import ripperdoc checkups from the #ripperdoc-checkups Discord channel and
 * set characters.last_checkup_at so the weekly cyberpsychosis-meds cron
 * (cyberware_humanity) bills players from their REAL last checkup instead of
 * falling back to each character's creation date (which makes almost everyone
 * look 12+ weeks overdue and charges the band cap).
 *
 * Data source: .local/checkup-byowner.json — produced by _resolve-checkups.ts
 * from a full scrape of the channel. It is a list of
 *   { owner: <discordId>, ts: <ISO latest checkup>, char, how, n }
 * keyed by Discord user id (DB-independent), one row per player.
 *
 * SAFETY (critical): a checkup date is applied to a character ONLY when it is
 * strictly MORE RECENT than that character's current effective date
 * (last_checkup_at ?? created_at). A character's creation already counts as an
 * implicit initial checkup (see the cron + dashboard), so applying an OLDER
 * channel date would push the effective date BACK and INCREASE the charge.
 * This guarantees the import can never raise anyone's bill — it only ever
 * moves the effective checkup date forward (lower or equal charge).
 *
 * The cron bills per-USER from max(last_checkup_at ?? created_at) across the
 * household, so we apply the owner's latest channel checkup to every one of
 * their billable PCs that it improves.
 *
 * Mirrors the per-user bot_cyberware_status row (display only — the dashboard
 * trusts it first) for owners that already have one, so the projected-meds
 * card matches what the cron will actually charge. The cron does NOT read that
 * table, so this is cosmetic; we never create new rows.
 *
 * Targets process.env.DATABASE_URL. To hit a specific DB:
 *   dev   (default): pnpm --filter @workspace/scripts exec tsx src/import-ripperdoc-checkups.ts
 *   live prod:       DATABASE_URL="$LIVE_PROD_DATABASE_URL" APPLY=1 CONFIRM_LIVE=1 \
 *                      pnpm --filter @workspace/scripts exec tsx src/import-ripperdoc-checkups.ts
 *
 * Without APPLY=1 the script is a dry run (no writes). Writing to a non-dev
 * (non-helium) host additionally requires CONFIRM_LIVE=1.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, characters, users, botCyberwareStatus, activityEvents } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const APPLY = process.env.APPLY === "1";
const CONFIRM_LIVE = process.env.CONFIRM_LIVE === "1";
const BYOWNER_PATH = resolve(import.meta.dirname, "..", "..", ".local", "checkup-byowner.json");

// Cap mirrors CYBERWARE_MAX_STREAK in api-server/src/lib/jobs.ts. Inlined to
// avoid a cross-artifact import from a standalone script.
const CYBERWARE_MAX_STREAK = 12;
function weeksSinceLastCheckup(lastCheckupAt: Date | null, runAt: Date): number {
  if (!lastCheckupAt) return CYBERWARE_MAX_STREAK;
  const ms = runAt.getTime() - lastCheckupAt.getTime();
  if (ms <= 0) return 1;
  const weeks = Math.floor(ms / (7 * 86400000)) + 1;
  return Math.max(1, Math.min(CYBERWARE_MAX_STREAK, weeks));
}

const dbUrl = process.env.DATABASE_URL ?? "";
const host = dbUrl.replace(/:[^@]+@/, ":***@").split("@")[1]?.split("/")[0] ?? "(unknown)";
const isDevHost = /helium/.test(host);
console.log(`DATABASE_URL host: ${host}  (dev=${isDevHost})`);
console.log(`mode: ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
if (APPLY && !isDevHost && !CONFIRM_LIVE) {
  console.error("\nRefusing to write to a non-dev host without CONFIRM_LIVE=1. Aborting.");
  process.exit(1);
}

type ByOwner = { owner: string; ts: string; char?: string; how?: string; n?: number };
const byOwnerRows = JSON.parse(readFileSync(BYOWNER_PATH, "utf8")) as ByOwner[];
const ownerLatest = new Map<string, Date>();
for (const r of byOwnerRows) ownerLatest.set(r.owner, new Date(r.ts));
console.log(`loaded ${ownerLatest.size} owners with a channel checkup from ${BYOWNER_PATH}`);

async function main(): Promise<void> {
  const now = new Date();

  // Billable population mirrors the cron filter exactly.
  const chars = await db
    .select({
      id: characters.id,
      name: characters.name,
      ownerId: characters.ownerId,
      createdAt: characters.createdAt,
      lastCheckupAt: characters.lastCheckupAt,
      discordId: users.discordId,
    })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .where(and(eq(characters.kind, "pc"), eq(characters.approved, true), eq(characters.archived, false)));
  console.log(`approved non-archived PCs: ${chars.length}`);

  type Plan = { id: number; name: string; ownerKey: string; newTs: Date; oldEff: Date; oldWeeks: number; newWeeks: number };
  const plan: Plan[] = [];
  let noOwner = 0;
  let noChannelCheckup = 0;
  let skippedNoImprove = 0;
  const skippedExamples: string[] = [];

  for (const c of chars) {
    const ownerKey = c.discordId ?? c.ownerId; // ownerId == discordId, but prefer the joined value
    if (!ownerKey) { noOwner++; continue; }
    const newTs = ownerLatest.get(ownerKey);
    if (!newTs) { noChannelCheckup++; continue; }
    const oldEff = c.lastCheckupAt ?? c.createdAt;
    if (!oldEff) { // no floor at all -> any real checkup is an improvement
      // treat as null effective (max streak); applying helps.
    } else if (!(newTs.getTime() > oldEff.getTime())) {
      skippedNoImprove++;
      if (skippedExamples.length < 8) {
        skippedExamples.push(`${c.name} (owner ${ownerKey}): channel ${newTs.toISOString().slice(0, 10)} <= floor ${oldEff.toISOString().slice(0, 10)}`);
      }
      continue;
    }
    const oldWeeks = weeksSinceLastCheckup(oldEff ?? null, now);
    const newWeeks = weeksSinceLastCheckup(newTs, now);
    plan.push({ id: c.id, name: c.name, ownerKey, newTs, oldEff: oldEff ?? new Date(0), oldWeeks, newWeeks });
  }

  // SAFETY ASSERTION: no plan row may ever increase weeks.
  const regressions = plan.filter((p) => p.newWeeks > p.oldWeeks);
  if (regressions.length > 0) {
    console.error(`ABORT: ${regressions.length} planned updates would INCREASE the charge:`);
    for (const r of regressions.slice(0, 10)) console.error(`  ${r.name}: ${r.oldWeeks}w -> ${r.newWeeks}w`);
    process.exit(1);
  }

  // Reporting
  const ownersTouched = new Set(plan.map((p) => p.ownerKey));
  console.log(`\n--- plan ---`);
  console.log(`chars to update:        ${plan.length}`);
  console.log(`owners helped:          ${ownersTouched.size}`);
  console.log(`skipped (no owner):     ${noOwner}`);
  console.log(`skipped (no checkup):   ${noChannelCheckup}`);
  console.log(`skipped (no improve):   ${skippedNoImprove}`);
  const improved = plan.filter((p) => p.newWeeks < p.oldWeeks).length;
  console.log(`charge strictly lower:  ${improved} (others equal, none higher)`);
  // new-weeks histogram (lower = cheaper)
  const hist: Record<number, number> = {};
  for (const p of plan) hist[p.newWeeks] = (hist[p.newWeeks] ?? 0) + 1;
  console.log(`new weeksUnpaid histogram:`, hist);
  if (skippedExamples.length) {
    console.log(`\nexamples skipped to AVOID raising a bill (channel date older than floor):`);
    for (const s of skippedExamples) console.log(`  ${s}`);
  }

  // reported users
  for (const [uid, label] of [["797182391030513745", "Curtis/knuckson"], ["1121147736155242508", "Celeste/bensubean"]] as const) {
    const inPlan = plan.filter((p) => p.ownerKey === uid);
    const latest = ownerLatest.get(uid);
    console.log(`\nreported ${label}: channel-latest=${latest ? latest.toISOString().slice(0, 10) : "NONE"}; chars updated=${inPlan.length}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — no writes. Re-run with APPLY=1 to commit.`);
    process.exit(0);
  }

  // ---- WRITE ----
  console.log(`\napplying ${plan.length} character updates...`);
  let updated = 0;
  // Group by date so we can batch updates that share the same new timestamp.
  const byTs = new Map<number, number[]>();
  for (const p of plan) {
    const k = p.newTs.getTime();
    if (!byTs.has(k)) byTs.set(k, []);
    byTs.get(k)!.push(p.id);
  }
  for (const [ms, ids] of byTs) {
    await db.update(characters).set({ lastCheckupAt: new Date(ms) }).where(inArray(characters.id, ids));
    updated += ids.length;
  }
  console.log(`updated last_checkup_at on ${updated} characters`);

  // Mirror into bot_cyberware_status for owners that ALREADY have a row
  // (display consistency only; never create new rows).
  let mirrored = 0;
  for (const ownerKey of ownersTouched) {
    const latest = ownerLatest.get(ownerKey)!;
    const within7 = now.getTime() - latest.getTime() < 7 * 86400000;
    const weeks = within7 ? 0 : weeksSinceLastCheckup(latest, now);
    const existing = await db
      .select({ userId: botCyberwareStatus.userId })
      .from(botCyberwareStatus)
      .where(eq(botCyberwareStatus.userId, ownerKey))
      .limit(1);
    if (existing.length === 0) continue;
    await db
      .update(botCyberwareStatus)
      .set({ weeks, lastProcessed: now, updatedAt: now })
      .where(eq(botCyberwareStatus.userId, ownerKey));
    mirrored++;
  }
  console.log(`mirrored bot_cyberware_status for ${mirrored} owners (existing rows only)`);

  // Single audit/activity breadcrumb.
  await db.insert(activityEvents).values({
    kind: "checkup",
    actorId: null,
    actorName: "system",
    message: `Imported ${updated} ripperdoc checkups from #ripperdoc-checkups (${ownersTouched.size} players) to correct weekly meds billing`,
  });

  console.log(`\nDONE. characters updated=${updated}, owners=${ownersTouched.size}, mirror rows=${mirrored}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("import failed:", err);
  process.exit(1);
});
