import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CHANNEL_ID = "1389028820463521802";
const RAW = "/home/runner/workspace/.local/checkups-raw.jsonl";
const CURSOR = "/home/runner/workspace/.local/checkups-cursor.txt";
const PAGES_PER_RUN = 28;

if (!TOKEN) { console.error("no token"); process.exit(1); }

type Msg = { id: string; author: { username: string; bot?: boolean; id: string }; content: string; timestamp: string };

async function discord<T>(path: string): Promise<T> {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${TOKEN}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429) { const retry = Number(r.headers.get("retry-after") ?? "1"); await new Promise((s) => setTimeout(s, (retry + 0.2) * 1000)); continue; }
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }
  throw new Error("exhausted retries");
}

async function main() {
  let before: string | undefined = existsSync(CURSOR) ? readFileSync(CURSOR, "utf8").trim() || undefined : undefined;
  if (before === "DONE") { console.log("already DONE"); process.exit(0); }
  if (!existsSync(RAW)) writeFileSync(RAW, "");
  let pages = 0;
  while (pages < PAGES_PER_RUN) {
    const batch = await discord<Msg[]>(`/channels/${CHANNEL_ID}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (batch.length === 0) { writeFileSync(CURSOR, "DONE"); console.log("DONE - no more messages"); process.exit(0); }
    const lines = batch.map((m) => JSON.stringify({ id: m.id, u: m.author.username, bot: !!m.author.bot, c: m.content ?? "", t: m.timestamp }));
    appendFileSync(RAW, lines.join("\n") + "\n");
    pages++;
    before = batch[batch.length - 1].id;
    writeFileSync(CURSOR, before);
    if (batch.length < 100) { writeFileSync(CURSOR, "DONE"); console.log("DONE - last partial page"); process.exit(0); }
  }
  console.log(`fetched ${pages} pages this run; cursor saved (more remain)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
