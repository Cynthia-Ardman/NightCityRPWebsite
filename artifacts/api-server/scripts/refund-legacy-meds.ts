/**
 * One-off: refund the legacy NightCityBot's final cyberware-meds run (run #57,
 * 2026-06-15 07:03 UTC). The website is now the sole meds biller; the old bot's
 * last run double-charged 26 players (website also billed) and charged a further
 * 20 the website did not bill this cycle. We refund everything that run took.
 *
 * Money moves in UnbelievaBoat via patchBalance (PATCH = additive delta); the
 * live site's reconcile job records each credit in wallet history. DMs go via
 * sendDirectMessage. Both helpers are gated by externalWritesAllowed(), so run
 * with ALLOW_EXTERNAL_WRITES=1.
 *
 * Idempotent + resumable: per-user two-phase state in refund-state.json. The
 * refund is marked BEFORE the DM, so a re-run never double-credits — it only
 * retries an unsent DM. Safe to re-run until SUMMARY shows no failures.
 *
 * Dry run (no external calls): DRY_RUN=1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchBalance } from "../src/lib/unbelievaboat";
import { sendDirectMessage } from "../src/lib/discord";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.env.DRY_RUN === "1";

interface Row {
  user_id: string;
  refund: number;
  doubleCharged: boolean;
}
interface State {
  refunded: boolean;
  refundedAmount?: number;
  newBalance?: number;
  dmed: boolean;
  error?: string;
}

const DATA: Row[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "refund-data.json"), "utf8"),
);
const STATE_PATH = path.join(__dirname, "refund-state.json");

let state: Record<string, State> = {};
if (fs.existsSync(STATE_PATH)) {
  state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}
const save = () => {
  if (DRY) return;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
};

const REASON =
  "Refund: duplicate cyberware meds charge (legacy bot final run, 2026-06-15)";

function dmText(amount: number, doubleCharged: boolean): string {
  const amt = `$${amount.toLocaleString()}`;
  if (doubleCharged) {
    return (
      `Heads up from the Night City RP team — we've moved all cyberware-meds billing to the website, ` +
      `but on June 15 the old bot ran one final time and charged you on top of the website's charge, ` +
      `so you got billed twice that day. We've refunded the old bot's extra ${amt} to your wallet. ` +
      `Going forward only the website bills meds. Sorry for the mix-up!`
    );
  }
  return (
    `Heads up from the Night City RP team — we've moved all cyberware-meds billing to the website. ` +
    `On June 15 the old bot ran one final time and charged you ${amt} for meds even though our current ` +
    `system didn't bill you this cycle. We've refunded that ${amt} to your wallet. ` +
    `Going forward only the website bills meds. Sorry for the mix-up!`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `${DRY ? "[DRY RUN] " : ""}Refunding ${DATA.length} users, total $${DATA.reduce((a, r) => a + r.refund, 0).toLocaleString()}`,
  );

  for (const row of DATA) {
    const e: State = (state[row.user_id] ??= { refunded: false, dmed: false });

    // Phase 1: credit UnbelievaBoat (idempotent — only if not already refunded)
    if (!e.refunded) {
      if (DRY) {
        console.log(`[DRY] would refund ${row.user_id} +$${row.refund}`);
        e.refunded = true;
        e.refundedAmount = row.refund;
      } else {
        let bal = null;
        for (let attempt = 0; attempt < 3 && !bal; attempt++) {
          if (attempt) await sleep(1500 * attempt);
          bal = await patchBalance(row.user_id, { cash: row.refund, reason: REASON });
        }
        if (!bal) {
          e.error = "refund failed";
          save();
          console.log(`FAIL refund ${row.user_id} $${row.refund}`);
          await sleep(800);
          continue;
        }
        e.refunded = true;
        e.refundedAmount = row.refund;
        e.newBalance = bal.total;
        delete e.error;
        save();
        console.log(`refunded ${row.user_id} +$${row.refund} -> total ${bal.total}`);
      }
    }

    // Phase 2: DM (idempotent — only after a confirmed refund, only if not sent)
    if (e.refunded && !e.dmed) {
      const text = dmText(row.refund, row.doubleCharged);
      if (DRY) {
        console.log(`[DRY] would DM ${row.user_id} (double=${row.doubleCharged}): ${text.slice(0, 60)}...`);
        e.dmed = true;
      } else {
        let msgId: string | null = null;
        for (let attempt = 0; attempt < 3 && !msgId; attempt++) {
          if (attempt) await sleep(1500 * attempt);
          msgId = await sendDirectMessage(row.user_id, text);
        }
        if (!msgId) {
          e.error = "dm failed";
          save();
          console.log(`WARN dm failed ${row.user_id} (refund OK, will retry on re-run)`);
        } else {
          e.dmed = true;
          delete e.error;
          save();
          console.log(`dm sent ${row.user_id}`);
        }
      }
    }
    save();
    await sleep(800);
  }

  const entries = Object.entries(state);
  const summary = {
    totalUsers: DATA.length,
    fullyDone: entries.filter(([, s]) => s.refunded && s.dmed).length,
    refundedCount: entries.filter(([, s]) => s.refunded).length,
    refundedTotal: entries
      .filter(([, s]) => s.refunded)
      .reduce((a, [, s]) => a + (s.refundedAmount ?? 0), 0),
    refundFailures: entries.filter(([, s]) => !s.refunded).map(([id]) => id),
    dmFailures: entries.filter(([, s]) => s.refunded && !s.dmed).map(([id]) => id),
  };
  console.log("SUMMARY " + JSON.stringify(summary, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
