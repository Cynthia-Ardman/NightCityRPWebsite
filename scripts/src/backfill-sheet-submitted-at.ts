/**
 * Backfill character_sheets.submitted_at for rows created before the column
 * existed, so the review queue and sheet detail show the real submission time
 * instead of the draft-creation time.
 *
 * Source priority (first non-null wins):
 *   1. discord_message_id snowflake — the #character-sheets announce post is
 *      created at submission time, and the millisecond timestamp embedded in a
 *      Discord snowflake gives a per-sheet-accurate moment (also disambiguates
 *      multiple same-name sheets for one owner, which the activity log cannot).
 *   2. activity_events kind='sheet_submitted' — the server logs the exact submit
 *      action ("<user> submitted sheet for <name>"). Used for rows that have no
 *      announce post (e.g. sheets submitted in dev, where outbound Discord
 *      writes are deployment-gated). Matched on actor_id == owner_id AND the
 *      trailing name == sheet.name, taking the latest event at/after creation.
 *
 * Rows with neither signal (never-submitted drafts) are left NULL; the API
 * already falls back to created_at at display time.
 *
 * Idempotent: only touches rows where submitted_at IS NULL.
 *
 * Target selection (mirrors the import-*.ts scripts):
 *   default            -> DATABASE_URL           (dev)
 *   IMPORT_TARGET=live -> LIVE_PROD_DATABASE_URL (the Neon DB the site uses)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-sheet-submitted-at.ts
 *   IMPORT_TARGET=live pnpm --filter @workspace/scripts exec tsx src/backfill-sheet-submitted-at.ts
 */
import { Client } from "pg";

const DISCORD_EPOCH = 1420070400000;

function snowflakeToDate(id: string | null): Date | null {
  if (!id || !/^\d+$/.test(id)) return null;
  try {
    const ms = Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
    if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH) return null;
    return new Date(ms);
  } catch {
    return null;
  }
}

const targetIsLive = process.env.IMPORT_TARGET === "live";
const TARGET = targetIsLive
  ? process.env.LIVE_PROD_DATABASE_URL
  : process.env.DATABASE_URL;

if (!TARGET) {
  console.error(
    targetIsLive
      ? "LIVE_PROD_DATABASE_URL is not set (needed for IMPORT_TARGET=live)"
      : "DATABASE_URL is not set",
  );
  process.exit(1);
}

type SheetRow = {
  id: number;
  owner_id: string | null;
  name: string;
  created_at: Date;
  discord_message_id: string | null;
};

type SubmitEvent = {
  actor_id: string | null;
  sheet_name: string;
  created_at: Date;
};

async function main() {
  const client = new Client({ connectionString: TARGET });
  await client.connect();
  try {
    const sheets = (
      await client.query(
        `select id, owner_id, name, created_at, discord_message_id
           from character_sheets
          where submitted_at is null
          order by id`,
      )
    ).rows as SheetRow[];

    const events = (
      await client.query(
        `select actor_id,
                regexp_replace(message, '^.* submitted sheet for ', '') as sheet_name,
                created_at
           from activity_events
          where kind = 'sheet_submitted'`,
      )
    ).rows as SubmitEvent[];

    // Count no-message-id candidate sheets per (owner_id|name). When more than
    // one exists, the activity-event log (which has no sheet id) cannot tell them
    // apart, so we must not auto-attribute a timestamp to either — skip + warn.
    const ambiguityKey = (ownerId: string | null, name: string) => `${ownerId ?? ""}\u0000${name}`;
    const noMsgIdCounts = new Map<string, number>();
    for (const s of sheets) {
      if (snowflakeToDate(s.discord_message_id)) continue;
      const k = ambiguityKey(s.owner_id, s.name);
      noMsgIdCounts.set(k, (noMsgIdCounts.get(k) ?? 0) + 1);
    }

    const updates: Array<{ id: number; submittedAt: Date; source: string }> = [];
    const skippedAmbiguous: number[] = [];
    for (const s of sheets) {
      const snow = snowflakeToDate(s.discord_message_id);
      if (snow) {
        updates.push({ id: s.id, submittedAt: snow, source: "snowflake" });
        continue;
      }
      if ((noMsgIdCounts.get(ambiguityKey(s.owner_id, s.name)) ?? 0) > 1) {
        skippedAmbiguous.push(s.id);
        continue;
      }
      // Latest 'sheet_submitted' event for this owner + exact name, at/after the
      // sheet's creation (1s tolerance for clock skew). For a re-submitted sheet
      // this picks the most recent submission, matching the forward stamp logic.
      const createdMs = new Date(s.created_at).getTime();
      let best: Date | null = null;
      for (const e of events) {
        if (e.actor_id !== s.owner_id) continue;
        if (e.sheet_name !== s.name) continue;
        const evMs = new Date(e.created_at).getTime();
        if (evMs < createdMs - 1000) continue;
        if (!best || evMs > best.getTime()) best = new Date(e.created_at);
      }
      if (best) updates.push({ id: s.id, submittedAt: best, source: "activity_event" });
    }

    for (const u of updates) {
      await client.query(
        `update character_sheets set submitted_at = $1 where id = $2 and submitted_at is null`,
        [u.submittedAt, u.id],
      );
    }

    const bySource = updates.reduce<Record<string, number>>((acc, u) => {
      acc[u.source] = (acc[u.source] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[${targetIsLive ? "LIVE" : "dev"}] Backfilled ${updates.length} sheet(s):`,
      bySource,
    );
    console.log(
      `Left NULL (no submission signal, e.g. drafts): ${sheets.length - updates.length - skippedAmbiguous.length}`,
    );
    if (skippedAmbiguous.length) {
      console.warn(
        `Skipped ${skippedAmbiguous.length} ambiguous row(s) (multiple no-message-id sheets share owner+name; resolve manually): ${skippedAmbiguous.join(", ")}`,
      );
    }
    for (const u of updates) {
      console.log(`  #${u.id} <- ${u.submittedAt.toISOString()} (${u.source})`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
