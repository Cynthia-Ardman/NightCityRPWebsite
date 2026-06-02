/**
 * Imports confirmed cyberware-meds deductions from the Night City bot's
 * OPERATOR DM thread into bot_rent_payment_events (kind='cyberware_meds').
 *
 * Why the DMs: the bot DM'd its operator the FULL weekly collection-sweep log
 * for the entire server. Those logs are the only surviving complete record of
 * confirmed meds deductions across the whole year — the bot_balance_history
 * ledger only kept the recent (~2026-05 onward) ones, and the #rent-payments
 * channel only had a handful. The DM thread carries ~1,500 confirmed deductions
 * for ~135 players back to 2025-07.
 *
 * Each sweep message contains MANY deductions, paired as:
 *   Charging <@id> $156 for week 3 (high)
 *   ✅ Deducted $156 from <@id> for cyberware meds.        (week from charge line)
 *   ✅ Deducted $39 for cyberware meds from <@id> (week 1). (week inline)
 *
 * Idempotency + cross-source dedup:
 *   - message_id is UNIQUE in the table but a DM message holds many events, so
 *     we synthesize a per-event message_id ("dm-meds:<msgId>:<uid>:<week>:<amt>").
 *   - We also skip any event whose (userId, UTC date, amount) already exists for
 *     kind='cyberware_meds' (from the channel importer or a prior DM run), so the
 *     same logical deduction is never stored twice. This makes reruns safe.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx src/import-dm-meds.ts
 *   pnpm --filter @workspace/scripts exec tsx src/import-dm-meds.ts --dry-run
 *
 * Required env: DISCORD_BOT_TOKEN, DATABASE_URL
 * Optional env: MEDS_DM_USER_ID (operator whose DM log to read; defaults below)
 */
import { db, botRentPaymentEvents } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
// Operator who received the full server collection-sweep logs in DMs.
const DM_USER_ID = process.env.MEDS_DM_USER_ID ?? "286338318076084226";
const DRY = process.argv.includes("--dry-run");

if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN must be set.");
  process.exit(1);
}

type Msg = {
  id: string;
  author: { username: string; bot?: boolean; id: string };
  content: string;
  timestamp: string;
};

async function discord<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) {
      const retry = Number(r.headers.get("retry-after") ?? "1");
      await new Promise((res) => setTimeout(res, (retry + 0.2) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Discord ${path} -> ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }
  throw new Error(`Discord ${path} -> exhausted retries`);
}

type ParsedEvent = {
  messageId: string;
  userId: string;
  ts: Date;
  kind: string;
  label: string;
  amount: number;
  week: number | null;
};

const money = (s: string) => Number(s.replace(/,/g, ""));

// "Charging <@id> $156 for week 3 (high)" — supplies the week for the next
// deduction line that lacks an inline "(week N)".
const CHARGE_RE = /Charging\s*<@!?(\d+)>\s*\$([\d,]+)\s*for week\s*(\d+)/iu;
// "✅ Deducted $N from <@id> for cyberware meds[.]" or
// "✅ Deducted $N for cyberware meds from <@id> (week N)." — week optional.
const DEDUCT_RE =
  /✅\s*Deducted\s*\$([\d,]+)\s+(?:for cyberware meds from\s*<@!?(\d+)>|from\s*<@!?(\d+)>\s+for cyberware meds)\s*(?:\(week\s*(\d+)\))?/iu;

function parseMessage(m: Msg): ParsedEvent[] {
  if (!m.author.bot) return [];
  const ts = new Date(m.timestamp);
  const out: ParsedEvent[] = [];
  let lastCharge: { uid: string; week: number } | null = null;

  for (const line of (m.content ?? "").split("\n")) {
    const c = CHARGE_RE.exec(line);
    if (c) {
      lastCharge = { uid: c[1], week: Number(c[3]) };
      continue;
    }
    const x = DEDUCT_RE.exec(line);
    if (x) {
      const amount = money(x[1]);
      const userId = x[2] ?? x[3];
      let week: number | null = x[4] ? Number(x[4]) : null;
      if (week == null && lastCharge && lastCharge.uid === userId) week = lastCharge.week;
      out.push({
        messageId: `dm-meds:${m.id}:${userId}:${week ?? "x"}:${amount}`,
        userId,
        ts,
        kind: "cyberware_meds",
        label: week != null ? `Cyberware meds week ${week}` : "Cyberware meds",
        amount,
        week,
      });
      lastCharge = null;
    }
  }
  return out;
}

async function main() {
  // Open (or fetch) the operator DM channel.
  const dm = await discord<{ id: string }>(`/users/@me/channels`, {
    method: "POST",
    body: JSON.stringify({ recipient_id: DM_USER_ID }),
  });

  let before: string | undefined;
  let scanned = 0;
  let pages = 0;
  const events: ParsedEvent[] = [];

  while (pages < 60) {
    const q = `/channels/${dm.id}/messages?limit=100${before ? `&before=${before}` : ""}`;
    const batch = await discord<Msg[]>(q);
    if (batch.length === 0) break;
    scanned += batch.length;
    pages++;
    for (const m of batch) events.push(...parseMessage(m));
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }

  console.log(`scanned ${scanned} DM messages over ${pages} pages`);
  console.log(`parsed ${events.length} meds deductions`);
  if (events.length) {
    const dates = events.map((e) => e.ts.getTime());
    const users = new Set(events.map((e) => e.userId));
    console.log(
      "date range:",
      new Date(Math.min(...dates)).toISOString().slice(0, 10),
      "->",
      new Date(Math.max(...dates)).toISOString().slice(0, 10),
      `| ${users.size} distinct users`,
    );
  }

  // Logical dedup key shared with the channel importer's meds rows:
  // userId | UTC-date | amount | week. A player gets at most one meds charge per
  // week, so this uniquely identifies a logical deduction regardless of source.
  // Including week guards against ever dropping a genuinely distinct same-day,
  // same-amount charge (different weeks parse to different keys).
  const logicalKey = (userId: string, ts: Date, amount: number, week: number | null) =>
    `${userId}|${ts.toISOString().slice(0, 10)}|${amount}|${week ?? ""}`;

  const existingRows = await db
    .select({
      userId: botRentPaymentEvents.userId,
      ts: botRentPaymentEvents.ts,
      amount: botRentPaymentEvents.amount,
      week: botRentPaymentEvents.week,
    })
    .from(botRentPaymentEvents)
    .where(eq(botRentPaymentEvents.kind, "cyberware_meds"));
  const seen = new Set(existingRows.map((r) => logicalKey(r.userId, new Date(r.ts), r.amount, r.week)));

  const toInsert: ParsedEvent[] = [];
  let skippedDup = 0;
  for (const e of events) {
    const k = logicalKey(e.userId, e.ts, e.amount, e.week);
    if (seen.has(k)) {
      skippedDup++;
      continue;
    }
    seen.add(k);
    toInsert.push(e);
  }
  console.log(`after dedup: ${toInsert.length} new, ${skippedDup} skipped (already present)`);

  if (DRY) {
    console.log("dry-run — not writing. sample:", toInsert.slice(0, 5));
    process.exit(0);
  }

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const rows = await db
      .insert(botRentPaymentEvents)
      .values(slice)
      .onConflictDoNothing({ target: botRentPaymentEvents.messageId })
      .returning({ id: botRentPaymentEvents.id });
    inserted += rows.length;
  }

  const total = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(botRentPaymentEvents)
    .where(eq(botRentPaymentEvents.kind, "cyberware_meds"));
  console.log(`inserted ${inserted} new rows; cyberware_meds now totals ${total[0]?.n ?? 0}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
