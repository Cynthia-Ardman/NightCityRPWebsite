/**
 * Idempotent backfill for Task #215 — per-ticket cs-approver Discord threads.
 *
 * Every OPEN review ticket (status pending / changes_requested) should have a
 * Discord thread in the cs-approver channel whose messages are mirrored
 * read-only on the portal. New submissions get this automatically; this script
 * retro-fits the tickets that predate the feature.
 *
 *   - pending_character_edits / character_sheets: these already posted a
 *     summary message to cs-approver (discord_message_id is set). We turn that
 *     existing message into a thread (thread id == message id) and store
 *     discord_thread_id.
 *   - custom_requests: historically did NOT post to cs-approver, so there is no
 *     message to thread off of. We post a fresh summary message AND start a
 *     thread from it, storing both discord_message_id and discord_thread_id.
 *
 * Rerun-safety: rows that already have discord_thread_id are skipped. Edits/
 * sheets missing discord_message_id are skipped (nothing to thread from) and
 * logged. Re-running only touches still-unlinked rows.
 *
 * Writes go to BOTH the DB (DATABASE_URL) and Discord. Discord writes only make
 * sense against production (the real channel/messages), so this enforces
 * IMPORT_TARGET=prod for a non-dev DATABASE_URL, mirroring the other backfills.
 *
 *   IMPORT_TARGET=prod DATABASE_URL=<live prod url> pnpm exec tsx scripts/src/backfill-ticket-threads.ts
 *
 * Dry run (no writes, just counts):
 *   DRY_RUN=1 pnpm exec tsx scripts/src/backfill-ticket-threads.ts
 */
import pg from "pg";

const API = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

function assertTargetAllowed(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (target).");
  const host = new URL(url).host;
  const looksDev = /helium|replit\.dev|replit\.com|localhost|127\.0\.0\.1/i.test(host);
  if (!looksDev && process.env.IMPORT_TARGET !== "prod") {
    console.error(`Refusing to write to ${host}: not a dev-looking host. Set IMPORT_TARGET=prod to override.`);
    process.exit(2);
  }
  if (looksDev && process.env.IMPORT_TARGET === "prod") {
    console.error(`IMPORT_TARGET=prod set but DATABASE_URL host ${host} looks like dev. Refusing.`);
    process.exit(2);
  }
  return host;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startThreadFromMessage(channelId: string, messageId: string, name: string): Promise<string | null> {
  const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}/threads`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: 10080 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    // A thread already exists for this message (Discord 400 / code 160004). A
    // thread created FROM a message has id == messageId, so the existing thread
    // is addressable there — return it so a rerun repairs the missing linkage
    // instead of skipping the row forever.
    if (res.status === 400 && (/160004/.test(body) || /thread has already been created/i.test(body))) {
      return messageId;
    }
    console.warn(`  thread create failed (msg ${messageId}): ${res.status} ${body}`);
    return null;
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

interface Embed {
  title?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}

async function postToChannel(channelId: string, content: string, embeds: Embed[]): Promise<string | null> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content, embeds }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.warn(`  post failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

const OPEN = "status IN ('pending','changes_requested')";

async function main() {
  const targetHost = assertTargetAllowed();
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun && (!BOT_TOKEN || !CS_CHANNEL_ID)) {
    console.error("DISCORD_BOT_TOKEN and CS_APPROVAL_CHANNEL_ID are required for live backfill.");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`Target: ${targetHost}${dryRun ? "  (DRY RUN — no writes)" : ""}`);

  // ---- Edits + sheets: thread from the existing summary message ----------
  for (const table of ["pending_character_edits", "character_sheets"] as const) {
    const rows = (
      await client.query(
        `SELECT pe.id, pe.discord_message_id AS msg, c.name AS name
           FROM ${table} pe
           LEFT JOIN characters c ON c.id = pe.character_id
          WHERE ${OPEN} AND pe.discord_thread_id IS NULL`,
      )
    ).rows as { id: number; msg: string | null; name: string | null }[];
    const linkable = rows.filter((r) => r.msg);
    const orphans = rows.length - linkable.length;
    console.log(`${table}: ${linkable.length} to thread${orphans ? `  (${orphans} skipped — no discord_message_id)` : ""}`);
    if (dryRun) continue;
    for (const r of linkable) {
      const label = table === "character_sheets" ? "Sheet" : "Edit";
      const threadId = await startThreadFromMessage(CS_CHANNEL_ID, r.msg!, `${label}: ${r.name ?? r.id}`);
      // Only link when a thread genuinely exists (created now, or already
      // present). On a hard failure leave the row unlinked so a rerun recovers.
      if (!threadId) {
        console.warn(`  ${table} #${r.id}: thread create failed, leaving unlinked`);
        await sleep(400);
        continue;
      }
      await client.query(`UPDATE ${table} SET discord_thread_id = $1 WHERE id = $2`, [threadId, r.id]);
      console.log(`  ${table} #${r.id} -> thread ${threadId}`);
      await sleep(400);
    }
  }

  // ---- Requests: thread from existing message, else post + thread --------
  // Most legacy requests never posted to cs-approver (discord_message_id null),
  // so they need a fresh summary post first. A request that DOES already have a
  // message (e.g. a submit whose thread-create hard-failed) is threaded from
  // that message rather than re-posted, avoiding a duplicate announcement.
  const reqRows = (
    await client.query(
      `SELECT cr.id, cr.type, cr.title, cr.discord_message_id AS msg, c.name AS character_name,
              COALESCE(u.username, cr.requested_by_id) AS submitter
         FROM custom_requests cr
         LEFT JOIN characters c ON c.id = cr.character_id
         LEFT JOIN users u ON u.id = cr.requested_by_id
        WHERE ${OPEN} AND cr.discord_thread_id IS NULL`,
    )
  ).rows as {
    id: number;
    type: string;
    title: string;
    msg: string | null;
    character_name: string | null;
    submitter: string;
  }[];
  console.log(`custom_requests: ${reqRows.length} to thread (${reqRows.filter((r) => r.msg).length} from existing message)`);
  if (!dryRun) {
    for (const r of reqRows) {
      const title = (r.title ?? "").trim() || `Request #${r.id}`;
      let msgId = r.msg;
      if (!msgId) {
        msgId = await postToChannel(
          CS_CHANNEL_ID,
          `New ${r.type} request pending review: **${title}** by ${r.submitter}`,
          [
            {
              title,
              fields: [
                { name: "Type", value: r.type, inline: true },
                { name: "Character", value: r.character_name ?? "—", inline: true },
                { name: "Player", value: r.submitter, inline: true },
              ],
            },
          ],
        );
        if (!msgId) {
          console.warn(`  custom_requests #${r.id}: post failed, skipping`);
          continue;
        }
        // Persist the message id immediately so a later rerun threads from it
        // rather than posting a second announcement.
        await client.query(`UPDATE custom_requests SET discord_message_id = $1 WHERE id = $2`, [msgId, r.id]);
      }
      const threadId = await startThreadFromMessage(CS_CHANNEL_ID, msgId, `Request: ${title}`);
      if (!threadId) {
        console.warn(`  custom_requests #${r.id}: thread create failed, leaving unlinked`);
        await sleep(500);
        continue;
      }
      await client.query(`UPDATE custom_requests SET discord_thread_id = $1 WHERE id = $2`, [threadId, r.id]);
      console.log(`  custom_requests #${r.id} -> msg ${msgId} thread ${threadId}`);
      await sleep(500);
    }
  }

  await client.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
