/**
 * One-off: refund website cyberpsychosis-meds charges that hit players whose
 * (sole chromed) character was on the SELF-SERVICE LOA toggle. A bug in the
 * cyberware_humanity cron ignored character_status.loa, so these players were
 * billed for meds while paused. Confirmed against live prod: each owner's only
 * chromed PC is the LOA one, so every meds charge here is fully erroneous.
 *
 * Money moves in UnbelievaBoat via patchBalance (PATCH = additive delta, so a
 * positive cash credits); the live site's reconcile job records each credit in
 * wallet history. patchBalance is gated by externalWritesAllowed(), so run with
 * ALLOW_EXTERNAL_WRITES=1.
 *
 * Idempotent + resumable: per-user state in refund-website-meds-loa-state.json.
 * The credit is marked only after UB confirms it, so a re-run never
 * double-credits — it only retries a failed credit. Safe to re-run until
 * SUMMARY shows no failures.
 *
 * Dry run (no external calls): DRY_RUN=1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchBalance } from "../src/lib/unbelievaboat";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.env.DRY_RUN === "1";

interface Row {
  user_id: string;
  refund: number;
  label: string;
}
interface State {
  refunded: boolean;
  refundedAmount?: number;
  newBalance?: number;
  error?: string;
}

// Refund rows (owner discordId == users PK; amount = sum of erroneous meds rows)
// are real prod financial data, so they live in a gitignored input file rather
// than in source control. Shape: [{ "user_id": "...", "refund": 123, "label": "..." }].
const INPUT_PATH = path.join(__dirname, "refund-website-meds-loa-input.json");
if (!fs.existsSync(INPUT_PATH)) {
  console.error(
    `Missing input file: ${INPUT_PATH}\n` +
      `Create it with the refund rows, e.g.\n` +
      `[{ "user_id": "<discordId>", "refund": 100, "label": "Name" }]`,
  );
  process.exit(1);
}
let DATA: Row[];
try {
  DATA = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
} catch (err) {
  console.error(`Failed to parse ${INPUT_PATH} as JSON: ${(err as Error).message}`);
  process.exit(1);
}
const isValidRow = (r: Row) =>
  typeof r?.user_id === "string" &&
  r.user_id.length > 0 &&
  Number.isInteger(r?.refund) &&
  r.refund >= 0 &&
  typeof r?.label === "string";
if (!Array.isArray(DATA) || !DATA.every(isValidRow)) {
  console.error(
    `Invalid input file ${INPUT_PATH}: expected [{ user_id: string, refund: non-negative integer, label: string }].`,
  );
  process.exit(1);
}
const STATE_PATH = path.join(__dirname, "refund-website-meds-loa-state.json");

let state: Record<string, State> = {};
if (fs.existsSync(STATE_PATH)) {
  state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}
const save = () => {
  if (DRY) return;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
};

const REASON = "Refund: cyberpsychosis meds charged while on website LOA (system error)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `${DRY ? "[DRY RUN] " : ""}Refunding ${DATA.length} users, total $${DATA.reduce((a, r) => a + r.refund, 0).toLocaleString()}`,
  );

  for (const row of DATA) {
    const e: State = (state[row.user_id] ??= { refunded: false });
    if (e.refunded) {
      console.log(`skip ${row.label} (${row.user_id}) already refunded $${e.refundedAmount}`);
      continue;
    }
    if (DRY) {
      console.log(`[DRY] would refund ${row.label} (${row.user_id}) +$${row.refund}`);
      continue;
    }
    let bal = null;
    for (let attempt = 0; attempt < 3 && !bal; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      bal = await patchBalance(row.user_id, { cash: row.refund, reason: REASON });
    }
    if (!bal) {
      e.error = "refund failed";
      save();
      console.log(`FAIL refund ${row.label} (${row.user_id}) $${row.refund}`);
      await sleep(800);
      continue;
    }
    e.refunded = true;
    e.refundedAmount = row.refund;
    e.newBalance = bal.total;
    delete e.error;
    save();
    console.log(`refunded ${row.label} (${row.user_id}) +$${row.refund} -> total ${bal.total}`);
    await sleep(800);
  }

  const entries = Object.entries(state);
  const summary = {
    totalUsers: DATA.length,
    refundedCount: entries.filter(([, s]) => s.refunded).length,
    refundedTotal: entries.filter(([, s]) => s.refunded).reduce((a, [, s]) => a + (s.refundedAmount ?? 0), 0),
    failures: entries.filter(([, s]) => !s.refunded).map(([id]) => id),
  };
  console.log("SUMMARY " + JSON.stringify(summary, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
