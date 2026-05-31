// One-off: replace raw Discord user mentions (<@123> / <@!123>) in already-
// published lore entries with readable display names. The responsible-fixer
// field gets a bare name; body/summary prose keeps an "@" prefix. Unresolvable
// ids are left untouched.
//
// Usage (from repo root):
//   LORE_IMPORT_TARGET=dev  pnpm --filter @workspace/scripts exec tsx /home/runner/workspace/artifacts/api-server/src/scripts/fix-lore-mentions.ts
//   LORE_IMPORT_TARGET=prod pnpm --filter @workspace/scripts exec tsx /home/runner/workspace/artifacts/api-server/src/scripts/fix-lore-mentions.ts

export {};

const target = (process.env.LORE_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("LORE_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target !== "dev") {
  console.error("Set LORE_IMPORT_TARGET=dev or prod");
  process.exit(1);
}

const MENTION_RE = /<@!?(\d+)>/g;

async function main() {
  const { pool } = await import("@workspace/db");
  const { fetchDiscordUser } = await import("../lib/discord");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(`Target: ${host} (${target.toUpperCase()})`);

  const { rows } = await pool.query<{
    id: number;
    responsible_fixer: string | null;
    summary: string | null;
    public_body: string | null;
    fixer_body: string | null;
  }>("SELECT id, responsible_fixer, summary, public_body, fixer_body FROM lore_entries");

  // Collect every distinct mentioned id, then resolve each once.
  const ids = new Set<string>();
  for (const r of rows) {
    for (const field of [r.responsible_fixer, r.summary, r.public_body, r.fixer_body]) {
      if (!field) continue;
      for (const m of field.matchAll(MENTION_RE)) ids.add(m[1]);
    }
  }
  console.log(`Distinct mentioned users: ${ids.size}`);

  const nameById = new Map<string, string | null>();
  for (const id of ids) {
    const u = await fetchDiscordUser(id);
    nameById.set(id, u ? u.globalName || u.username : null);
    console.log(`  ${id} -> ${nameById.get(id) ?? "(unresolved)"}`);
  }

  const replace = (text: string, prefix: "@" | "") =>
    text.replace(MENTION_RE, (full, id: string) => {
      const name = nameById.get(id);
      return name ? `${prefix}${name}` : full;
    });

  let updated = 0;
  let unresolved = 0;
  for (const r of rows) {
    const rf = r.responsible_fixer ? replace(r.responsible_fixer, "") : r.responsible_fixer;
    const summ = r.summary ? replace(r.summary, "@") : r.summary;
    const pub = r.public_body ? replace(r.public_body, "@") : r.public_body;
    const fix = r.fixer_body ? replace(r.fixer_body, "@") : r.fixer_body;
    if (
      rf === r.responsible_fixer &&
      summ === r.summary &&
      pub === r.public_body &&
      fix === r.fixer_body
    ) {
      continue;
    }
    await pool.query(
      "UPDATE lore_entries SET responsible_fixer=$1, summary=$2, public_body=$3, fixer_body=$4, updated_at=now() WHERE id=$5",
      [rf, summ, pub, fix, r.id],
    );
    updated++;
  }

  // Report any ids that could not be resolved (left as raw mentions).
  for (const [id, name] of nameById) if (name === null) unresolved++;

  console.log(`\nRows updated: ${updated}`);
  if (unresolved) console.log(`Unresolved ids left as raw mentions: ${unresolved}`);
  await pool.end();
}

main().catch((err) => {
  console.error("fix-lore-mentions failed:", err);
  process.exit(1);
});
