import { writeFileSync } from "node:fs";
const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CHANNEL_ID = "1389028820463521802";
const OUT = "/home/runner/workspace/.local/checkups-explore.txt";

if (!TOKEN) { console.error("no token"); process.exit(1); }

type Msg = { id: string; author: { username: string; bot?: boolean }; content: string; timestamp: string; embeds?: { title?: string; description?: string }[] };

async function discord<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function main() {
  const lines: string[] = [];
  let before: string | undefined;
  for (let p = 0; p < 3; p++) {
    const batch = await discord<Msg[]>(`/channels/${CHANNEL_ID}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!batch.length) break;
    for (const m of batch) {
      const c = (m.content ?? "").replace(/\n/g, " \\n ");
      const emb = m.embeds?.map((e) => `{${e.title ?? ""}|${e.description ?? ""}}`).join(" ") ?? "";
      lines.push(`[${m.timestamp.slice(0, 16)}] @${m.author.username}${m.author.bot ? "(bot)" : ""}: ${c}${emb ? " EMB:" + emb : ""}`);
    }
    before = batch[batch.length - 1].id;
  }
  writeFileSync(OUT, lines.join("\n"));
  console.log(`wrote ${lines.length} lines`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
