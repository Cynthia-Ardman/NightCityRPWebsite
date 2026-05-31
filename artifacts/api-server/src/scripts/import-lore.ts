// One-off operational script: run the Lore importer (Discord forum + linked
// public Google Docs -> loreImportDrafts) and optionally publish every pending
// draft into live loreEntries, replicating the admin approve flow
// (merge-into-existing or create-new, locked + status-guarded for idempotency).
//
// Usage (from repo root):
//   LORE_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/import-lore.ts
//   LORE_IMPORT_TARGET=dev  LORE_PUBLISH=1 pnpm --filter @workspace/api-server exec tsx src/scripts/import-lore.ts
//   LORE_IMPORT_TARGET=prod LORE_PUBLISH=1 pnpm --filter @workspace/api-server exec tsx src/scripts/import-lore.ts
//
// Defaults to DRAFTS-ONLY (no publish) unless LORE_PUBLISH=1. Targeting prod
// requires LIVE_PROD_DATABASE_URL to be set and is refused otherwise.

const target = (process.env.LORE_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("LORE_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  // Point the shared db pool at the live prod DB BEFORE importing @workspace/db.
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target !== "dev") {
  console.error("Set LORE_IMPORT_TARGET=dev or prod");
  process.exit(1);
}

const publish = process.env.LORE_PUBLISH === "1";

type SourceRef = { label: string; url: string };

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "entry"
  );
}

function sourcesOf(raw: unknown): SourceRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is SourceRef => !!s && typeof s === "object" && typeof (s as SourceRef).url === "string",
  );
}

function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const out = [...a];
  for (const s of b) if (!out.some((e) => e.url === s.url)) out.push(s);
  return out;
}

async function main() {
  const dbMod = await import("@workspace/db");
  const { db, loreEntries, loreImportDrafts, pool } = dbMod;
  const { eq, sql } = await import("drizzle-orm");
  const { runLoreImport } = await import("../lib/loreImport");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(
    `Target: ${host} (${target.toUpperCase()}) — ${publish ? "IMPORT + PUBLISH" : "IMPORT (drafts only)"}`,
  );

  const before = await db.select({ n: sql<number>`count(*)::int` }).from(loreEntries);
  console.log(`Existing live entries before: ${before[0]?.n ?? 0}`);

  const result = await runLoreImport();
  console.log(
    `Import: scanned=${result.scanned} created=${result.created} duplicates=${result.duplicates}`,
  );
  if (result.errors.length) {
    console.log(`Import errors (${result.errors.length}):`);
    for (const e of result.errors) console.log(`  ! ${e}`);
  }

  const pending = await db
    .select()
    .from(loreImportDrafts)
    .where(eq(loreImportDrafts.status, "pending"));
  console.log(`\nPending drafts: ${pending.length}`);
  const byCat: Record<string, number> = {};
  for (const d of pending) byCat[d.proposedCategory] = (byCat[d.proposedCategory] ?? 0) + 1;
  console.log(`By category: ${JSON.stringify(byCat)}`);
  const withFixer = pending.filter((d) => d.fixerBody && d.fixerBody.trim()).length;
  console.log(`With fixer-only section: ${withFixer}`);
  for (const d of pending) {
    const tags: string[] = [];
    if (d.fixerBody && d.fixerBody.trim()) tags.push("fixer-only");
    if (d.suggestedMergeEntryId) tags.push(`merge->#${d.suggestedMergeEntryId}`);
    if (d.proposedFixer) tags.push(`lead:${d.proposedFixer}`);
    console.log(`  - [${d.proposedCategory}] ${d.proposedName}${tags.length ? " (" + tags.join(", ") + ")" : ""}`);
  }

  if (!publish) {
    console.log("\nDrafts only — set LORE_PUBLISH=1 to publish into live entries.");
    await pool.end();
    return;
  }

  let created = 0;
  let merged = 0;
  let skipped = 0;
  for (const draft of pending) {
    const outcome = await db.transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(loreImportDrafts)
        .where(eq(loreImportDrafts.id, draft.id))
        .for("update");
      if (!d || d.status !== "pending") return "skipped" as const;

      let entryId: number;
      let kind: "created" | "merged";
      if (d.suggestedMergeEntryId) {
        const [existing] = await tx
          .select()
          .from(loreEntries)
          .where(eq(loreEntries.id, d.suggestedMergeEntryId))
          .for("update");
        if (existing) {
          const mergedAliases = Array.from(
            new Set(
              [...(existing.aliases ?? []), ...(d.aliases ?? []), existing.name].filter(
                (a) => a !== d.proposedName,
              ),
            ),
          );
          const mergedSources = mergeSources(sourcesOf(existing.sources), sourcesOf(d.sources));
          const [updated] = await tx
            .update(loreEntries)
            .set({
              category: d.proposedCategory,
              name: d.proposedName,
              responsibleFixer: d.proposedFixer ?? existing.responsibleFixer,
              summary: d.summary ?? existing.summary,
              publicBody: d.publicBody,
              fixerBody: d.fixerBody ?? existing.fixerBody,
              aliases: mergedAliases,
              sources: mergedSources as never,
              updatedById: null,
              updatedAt: new Date(),
            })
            .where(eq(loreEntries.id, existing.id))
            .returning({ id: loreEntries.id });
          entryId = updated.id;
          kind = "merged";
        } else {
          entryId = await createEntry(tx, loreEntries, d);
          kind = "created";
        }
      } else {
        entryId = await createEntry(tx, loreEntries, d);
        kind = "created";
      }

      await tx
        .update(loreImportDrafts)
        .set({ status: "approved", decidedById: null, decidedAt: new Date(), appliedEntryId: entryId })
        .where(eq(loreImportDrafts.id, d.id));
      return kind;
    });
    if (outcome === "created") created++;
    else if (outcome === "merged") merged++;
    else skipped++;
  }

  const after = await db.select({ n: sql<number>`count(*)::int` }).from(loreEntries);
  console.log(`\nPublished: ${created} created, ${merged} merged, ${skipped} skipped`);
  console.log(`Live entries now: ${after[0]?.n ?? 0}`);
  await pool.end();

  // Local helper that needs the typed table/tx in scope.
  async function createEntry(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    table: typeof loreEntries,
    d: typeof loreImportDrafts.$inferSelect,
  ): Promise<number> {
    const base = slugify(d.proposedName);
    let slug = base;
    for (let n = 2; n < 1000; n++) {
      const [hit] = await tx.select({ id: table.id }).from(table).where(eq(table.slug, slug)).limit(1);
      if (!hit) break;
      slug = `${base}-${n}`;
    }
    const [row] = await tx
      .insert(table)
      .values({
        category: d.proposedCategory,
        name: d.proposedName,
        slug,
        aliases: d.aliases ?? [],
        summary: d.summary ?? null,
        responsibleFixer: d.proposedFixer ?? null,
        publicBody: d.publicBody ?? "",
        fixerBody: d.fixerBody ?? null,
        sources: sourcesOf(d.sources) as never,
        createdById: null,
        updatedById: null,
      })
      .returning({ id: table.id });
    return row.id;
  }
}

main().catch((err) => {
  console.error("import-lore failed:", err);
  process.exit(1);
});
