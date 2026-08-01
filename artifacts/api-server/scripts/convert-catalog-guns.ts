// One-off maintenance: convert "custom" gun inventory rows that are actually
// catalog guns (typed slightly differently at sheet creation) into standard
// catalog guns — exact catalog name + catalog-authoritative notes.
//
// Usage:
//   npx tsx scripts/convert-catalog-guns.ts                # dry-run, dev DB
//   npx tsx scripts/convert-catalog-guns.ts --apply        # apply, dev DB
//   npx tsx scripts/convert-catalog-guns.ts --target=live          # dry-run, LIVE prod
//   npx tsx scripts/convert-catalog-guns.ts --target=live --apply  # apply, LIVE prod
//
// Safety:
// - Dry-run by default; --apply required for any write.
// - --target=live selects LIVE_PROD_DATABASE_URL (the real site DB) and
//   fail-closes unless the host is a Neon host. Default target is dev
//   (DATABASE_URL) and fail-closes unless the host looks Replit-managed.
// - Conversions are conditional UPDATEs guarded on the row still holding the
//   old name (idempotent + safe under concurrent edits) inside one
//   transaction, each with an audit_log row (append-only table, INSERT ok).
// - Legacy `[legacy-item:...]`/`[legacy:...]` anchors in notes are preserved.
//
// Match tiers per gun-ish inventory row (category gun/weapon):
//   exact    — name already equals a catalog name byte-for-byte → untouched.
//   convert  — loose key (lowercase, strip non-alphanumerics) equals a catalog
//              key, OR squashed edit-distance ≤ 1 with no attribute
//              contradiction parsed from the row's notes.
//   review   — near match (distance ≤ 2 or containment) but ambiguous or
//              attribute-contradicted → human decision list, never written.
//   custom   — no plausible catalog candidate → untouched.
import pg from "pg";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIVE = args.includes("--target=live");

const url = LIVE ? process.env.LIVE_PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  console.error(`Missing ${LIVE ? "LIVE_PROD_DATABASE_URL" : "DATABASE_URL"}`);
  process.exit(1);
}
const host = new URL(url).hostname;
if (LIVE && !host.includes("neon.tech")) {
  console.error(`Refusing --target=live: host does not look like Neon: ${host}`);
  process.exit(1);
}
if (!LIVE && !/^helium|\.replit\.com$|^localhost$|^127\./.test(host)) {
  console.error(`Refusing dev run: DATABASE_URL host does not look Replit-managed: ${host}`);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  connectionTimeoutMillis: 15_000,
  query_timeout: 60_000,
});
pool.on("error", (e) => console.error("pool idle error", e.message));

// Mirrors src/lib/strings.ts looseNameKey — keep in sync.
function looseNameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

type CatalogGun = {
  name: string;
  category: string | null;
  weaponType: string | null;
  fireMode: string | null;
  powerLevel: string | null;
  manufacturer: string | null;
  cyberwareReq: string | null;
};

// Same field order as buildGunNotes in src/routes/sheets.ts / requests.ts.
function catalogNotes(g: CatalogGun): string | null {
  const parts = [
    g.manufacturer ? `Manufacturer: ${g.manufacturer}` : null,
    g.category ? `Category: ${g.category}` : null,
    g.weaponType ? `Type: ${g.weaponType}` : null,
    g.fireMode ? `Fire: ${g.fireMode}` : null,
    g.powerLevel ? `Power: ${g.powerLevel}` : null,
  ].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : null;
}

// Extract durable [tag:...] anchors that must survive a notes rewrite.
function extractAnchors(notes: string | null): string[] {
  if (!notes) return [];
  return notes.match(/\[[a-z0-9-]+:[^\]]*\]/gi) ?? [];
}

// Parse whatever attribute hints exist in the current notes so we can veto a
// fuzzy match that contradicts the catalog (e.g. notes say pistol, candidate
// is a shotgun). Returns lowercase token set.
function noteTokens(notes: string | null): Set<string> {
  if (!notes) return new Set();
  const stripped = notes.replace(/\[[a-z0-9-]+:[^\]]*\]/gi, " ").toLowerCase();
  return new Set(stripped.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
}

const TYPE_WORDS = ["pistol", "revolver", "shotgun", "rifle", "smg", "sniper", "lmg"];

function contradictsCatalog(notes: string | null, g: CatalogGun): boolean {
  const tokens = noteTokens(notes);
  if (tokens.size === 0) return false;
  // Weapon type contradiction: notes name a type word that isn't the catalog's.
  const catalogType = (g.weaponType ?? "").toLowerCase();
  for (const w of TYPE_WORDS) {
    const inNotes = [...tokens].some((t) => t.includes(w));
    if (inNotes && !catalogType.includes(w)) return true;
  }
  // Firing-class contradiction (Power/Tech/Smart lives in catalog `category`).
  const catalogClass = (g.category ?? "").toLowerCase();
  for (const cls of ["power", "tech", "smart"]) {
    if (tokens.has(cls) && catalogClass && !catalogClass.includes(cls)) return true;
  }
  return false;
}

async function main() {
  console.log(`target=${LIVE ? "LIVE" : "dev"} host=${host} mode=${APPLY ? "APPLY" : "dry-run"}`);

  const cat = await pool.query(
    `SELECT name, category, weapon_type, fire_mode, power_level, manufacturer, cyberware_req
     FROM catalog_guns`,
  );
  const catalog: CatalogGun[] = cat.rows.map((r) => ({
    name: r.name,
    category: r.category,
    weaponType: r.weapon_type,
    fireMode: r.fire_mode,
    powerLevel: r.power_level,
    manufacturer: r.manufacturer,
    cyberwareReq: r.cyberware_req,
  }));
  const byKey = new Map<string, CatalogGun>();
  for (const g of catalog) {
    const k = looseNameKey(g.name);
    if (k && !byKey.has(k)) byKey.set(k, g);
  }
  const exactNames = new Set(catalog.map((g) => g.name));
  // Players often prepend the manufacturer ("Tsunami Nekomata" for catalog
  // "Nekomata", manufacturer Tsunami) — key those variants too.
  const byMfrKey = new Map<string, CatalogGun>();
  for (const g of catalog) {
    if (!g.manufacturer) continue;
    const k = looseNameKey(`${g.manufacturer} ${g.name}`);
    if (k && !byKey.has(k) && !byMfrKey.has(k)) byMfrKey.set(k, g);
  }

  const inv = await pool.query(
    `SELECT id, name, notes, category, character_id, owner_id, cyberware_req
     FROM inventory_items
     WHERE lower(trim(category)) IN ('gun', 'weapon', 'power', 'tech', 'smart')
     ORDER BY id`,
  );

  // Tier: catalog name + a trailing parenthetical/bracket annotation, e.g.
  // "M2038 Tactician (6 pellets)" or "Nue [M]". The base name must resolve via
  // the loose or manufacturer+name key; the annotation is preserved by moving
  // it into the notes. Annotations that signal real customization stay human.
  const CUSTOMIZATION_WORDS = /modif|custom|sawn|sawed|shorten|engrav|convert/i;
  function annotationMatch(name: string): { g: CatalogGun; annotation: string } | null {
    const m = name.match(/^(.*?)\s*[\(\[]([^\)\]]+)[\)\]]\s*$/);
    if (!m) return null;
    const [, base, annotation] = m;
    if (CUSTOMIZATION_WORDS.test(annotation)) return null;
    const k = looseNameKey(base);
    const g = byKey.get(k) ?? byMfrKey.get(k);
    return g ? { g, annotation: annotation.trim() } : null;
  }

  type Plan = { id: number; oldName: string; oldNotes: string | null; g: CatalogGun; newNotes: string | null; why: string };
  const plans: Plan[] = [];
  const review: string[] = [];
  const custom: string[] = [];
  let already = 0;

  for (const row of inv.rows) {
    const name: string = row.name;
    if (exactNames.has(name)) {
      already++;
      continue;
    }
    const key = looseNameKey(name);
    let match: CatalogGun | undefined;
    let why = "";
    if (byKey.has(key) && !contradictsCatalog(row.notes, byKey.get(key)!)) {
      match = byKey.get(key);
      why = "loose-key exact";
    } else if (byKey.has(key)) {
      // Same normalized name but the row's own notes contradict the catalog
      // attrs — flag for a human instead of silently overwriting.
      const g = byKey.get(key)!;
      review.push(
        `#${row.id} "${name}" (notes: ${JSON.stringify(row.notes)}) → candidate "${g.name}" [loose-key exact, ATTRS CONTRADICT] catalog attrs: ${catalogNotes(g) ?? "(none)"} — needs human decision`,
      );
      continue;
    } else if (byMfrKey.has(key) && !contradictsCatalog(row.notes, byMfrKey.get(key)!)) {
      match = byMfrKey.get(key);
      why = "manufacturer+name exact";
    } else if (annotationMatch(name) && !contradictsCatalog(row.notes, annotationMatch(name)!.g)) {
      const am = annotationMatch(name)!;
      match = am.g;
      why = `annotation suffix ("${am.annotation}" kept in notes)`;
      const anchors = extractAnchors(row.notes);
      const body = [catalogNotes(am.g), am.annotation].filter(Boolean).join(" · ");
      plans.push({ id: row.id, oldName: name, oldNotes: row.notes, g: am.g, newNotes: [...anchors, body].filter(Boolean).join(" ") || null, why });
      continue;
    } else {
      // Fuzzy candidates: bounded edit distance / containment on squashed keys.
      const scored = catalog
        .map((g) => ({ g, k: looseNameKey(g.name), d: editDistance(key, looseNameKey(g.name)) }))
        .map((c) => ({ ...c, contains: key.length >= 6 && (c.k.includes(key) || key.includes(c.k)) }))
        .filter((c) => c.d <= 2 || c.contains)
        .sort((a, b) => a.d - b.d);
      if (scored.length === 0) {
        custom.push(`#${row.id} "${name}" — no catalog candidate (left as custom)`);
        continue;
      }
      const best = scored[0];
      const contradiction = contradictsCatalog(row.notes, best.g);
      const ambiguous = scored.length > 1 && scored[1].d === best.d && scored[1].g.name !== best.g.name;
      if (best.d <= 1 && !contradiction && !ambiguous) {
        match = best.g;
        why = `edit-distance ${best.d}`;
      } else {
        review.push(
          `#${row.id} "${name}" (notes: ${JSON.stringify(row.notes)}) → candidate "${best.g.name}" ` +
            `[dist=${best.d}${best.contains ? ", containment" : ""}${contradiction ? ", ATTRS CONTRADICT" : ""}${ambiguous ? ", AMBIGUOUS (tie)" : ""}] ` +
            `catalog attrs: ${catalogNotes(best.g) ?? "(none)"} — needs human decision`,
        );
        continue;
      }
    }
    const anchors = extractAnchors(row.notes);
    const body = catalogNotes(match!);
    const newNotes = [...anchors, body].filter(Boolean).join(" ") || null;
    plans.push({ id: row.id, oldName: name, oldNotes: row.notes, g: match!, newNotes, why });
  }

  console.log(`\nrows scanned=${inv.rows.length} exact-match=${already} convert=${plans.length} review=${review.length} custom=${custom.length}\n`);
  for (const p of plans)
    console.log(`CONVERT #${p.id} "${p.oldName}" → "${p.g.name}" (${p.why})\n  notes: ${JSON.stringify(p.oldNotes)} → ${JSON.stringify(p.newNotes)}`);
  if (review.length) console.log(`\nNEEDS HUMAN DECISION:\n${review.map((r) => "  " + r).join("\n")}`);
  if (custom.length) console.log(`\nGENUINE CUSTOM (untouched):\n${custom.map((r) => "  " + r).join("\n")}`);

  if (!APPLY) {
    console.log("\nDry-run only — re-run with --apply to convert.");
    return;
  }
  if (plans.length === 0) {
    console.log("\nNothing to convert.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let updated = 0;
    for (const p of plans) {
      const res = await client.query(
        `UPDATE inventory_items
         SET name = $1, notes = $2, cyberware_req = $3
         WHERE id = $4 AND name = $5`,
        [p.g.name, p.newNotes, p.g.cyberwareReq, p.id, p.oldName],
      );
      if (res.rowCount !== 1) {
        console.log(`skip #${p.id}: row changed since audit (name no longer "${p.oldName}")`);
        continue;
      }
      await client.query(
        `INSERT INTO audit_log (category, action, actor_id, actor_name, target_type, target_id, message, before_json, after_json)
         VALUES ('inventory', 'catalog_gun_convert', NULL, 'convert-catalog-guns script', 'inventory_item', $1, $2, $3, $4)`,
        [
          String(p.id),
          `Converted custom gun "${p.oldName}" to catalog gun "${p.g.name}" (${p.why})`,
          JSON.stringify({ name: p.oldName, notes: p.oldNotes }),
          JSON.stringify({ name: p.g.name, notes: p.newNotes, cyberwareReq: p.g.cyberwareReq }),
        ],
      );
      updated++;
    }
    await client.query("COMMIT");
    console.log(`\nApplied: ${updated}/${plans.length} rows converted (audit_log rows written).`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
