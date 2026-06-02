/**
 * Imports per-payment rent/bill events from the legacy bot's #rent-payments
 * Discord channel into bot_rent_payment_events.
 *
 * The Night City bot posted one confirmation line per charge during each
 * monthly rent sweep. We parse only the authoritative "paid/deducted"
 * confirmations and ignore command noise, estimates, and progress markers:
 *
 *   ✅ <@id> — Baseline living cost paid: $500        -> baseline
 *   ✅ <@id> — Housing Rent paid: $2000               -> housing_rent
 *   ✅ <@id> — Business Rent paid: $5000              -> business_rent
 *   ✅ <@id> — Xanadu Gold membership paid: $500      -> membership
 *   ✅ <@id> — Trauma Team ... paid: $N               -> trauma_team
 *   ✅ Deducted $39 for cyberware meds from <@id> (week 1).  -> cyberware_meds
 *
 * Ignored: "!..." user commands, "💸 Estimated Due" estimates, "🔍 Working on",
 * "✅ Completed for", backups, unknown-command errors, give-money/pay embeds.
 *
 * Keyed by Discord message id, so re-running is idempotent
 * (ON CONFLICT (message_id) DO NOTHING).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx src/import-rent-payments.ts
 *   pnpm --filter @workspace/scripts exec tsx src/import-rent-payments.ts --dry-run
 *
 * Required env: DISCORD_BOT_TOKEN, DATABASE_URL
 */
import { db, botRentPaymentEvents } from "@workspace/db";
import { sql } from "drizzle-orm";

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CHANNEL_ID = process.env.RENT_CHANNEL_ID ?? "1379942591721902152";
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

async function discord<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
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

// Map a "<X> paid:" label to a coarse kind for filtering/grouping.
function kindForPaidLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.startsWith("baseline")) return "baseline";
  if (l.includes("housing")) return "housing_rent";
  if (l.includes("business")) return "business_rent";
  if (l.includes("membership") || l.includes("xanadu")) return "membership";
  if (l.includes("trauma")) return "trauma_team";
  return "other";
}

// "✅ <@id> — <Label> paid: $N"  (em dash — or hyphen -, optional ! in mention)
const PAID_RE = /^✅\s*<@!?(\d+)>\s*[—-]\s*(.+?)\s+paid:\s*\$([\d,]+)/u;
// "✅ Deducted $N for cyberware meds from <@id> (week N)."
const CYBER_RE = /^✅\s*Deducted\s*\$([\d,]+)\s+for cyberware meds from\s*<@!?(\d+)>\s*\(week\s*(\d+)\)/iu;

function parseMessage(m: Msg): ParsedEvent | null {
  if (!m.author.bot) return null;
  const content = m.content ?? "";
  const ts = new Date(m.timestamp);

  const paid = PAID_RE.exec(content);
  if (paid) {
    const [, userId, rawLabel, amt] = paid;
    const label = rawLabel.trim();
    return {
      messageId: m.id,
      userId,
      ts,
      kind: kindForPaidLabel(label),
      label,
      amount: money(amt),
      week: null,
    };
  }

  const cyber = CYBER_RE.exec(content);
  if (cyber) {
    const [, amt, userId, week] = cyber;
    return {
      messageId: m.id,
      userId,
      ts,
      kind: "cyberware_meds",
      label: `Cyberware meds week ${week}`,
      amount: money(amt),
      week: Number(week),
    };
  }

  return null;
}

async function main() {
  let before: string | undefined;
  let scanned = 0;
  let pages = 0;
  const events: ParsedEvent[] = [];

  while (pages < 60) {
    const q = `/channels/${CHANNEL_ID}/messages?limit=100${before ? `&before=${before}` : ""}`;
    const batch = await discord<Msg[]>(q);
    if (batch.length === 0) break;
    scanned += batch.length;
    pages++;
    for (const m of batch) {
      const ev = parseMessage(m);
      if (ev) events.push(ev);
    }
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }

  const byKind = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`scanned ${scanned} messages over ${pages} pages`);
  console.log(`parsed ${events.length} payment events:`, byKind);
  if (events.length) {
    const dates = events.map((e) => e.ts.getTime());
    console.log("date range:", new Date(Math.min(...dates)).toISOString().slice(0, 10), "->", new Date(Math.max(...dates)).toISOString().slice(0, 10));
  }

  if (DRY) {
    console.log("dry-run — not writing. sample:", events.slice(0, 5));
    process.exit(0);
  }

  let inserted = 0;
  // Insert in chunks; ON CONFLICT (message_id) DO NOTHING keeps it idempotent.
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const rows = await db
      .insert(botRentPaymentEvents)
      .values(slice)
      .onConflictDoNothing({ target: botRentPaymentEvents.messageId })
      .returning({ id: botRentPaymentEvents.id });
    inserted += rows.length;
  }

  const total = await db.select({ n: sql<number>`count(*)::int` }).from(botRentPaymentEvents);
  console.log(`inserted ${inserted} new rows; table now has ${total[0]?.n ?? 0} total.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
