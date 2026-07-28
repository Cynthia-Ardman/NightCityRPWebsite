// One-off correction for sale_offer 138 (LunarVeil clinic, ripperdoc 12).
//
// The 2026-07-27 "neofiber" service was charged at €$10,000 but should have
// been €$7,000 (the install was meant to be 1x NeoFiber, not 2x). Staff-agreed
// full correction, as if the price had been €$7,000 all along:
//   1. Buyer Anton Robinovitch (char 665, user waffies)  +€$3,000 refund (UB + ledger)
//   2. Employee Richard Kovac (char 59, user puffymystery) -€$2,100 commission clawback
//      (70% of 3,000 overcharge; UB + ledger)
//   3. Clinic wallet (ripperdocs.balance, LunarVeil)      -€$900 (net of the two above)
//      with a venue ledger row, mirroring the completeSaleOffer venue-credit shape.
//
// Idempotent: legs 1 & 2 via applyWalletDelta idempotency keys; leg 3 is
// skipped if its ledger row (same idempotency key) already exists.
//
// Usage (from repo root), targeting the LIVE prod DB with real UB writes:
//   DATABASE_URL="$LIVE_PROD_DATABASE_URL" ALLOW_EXTERNAL_WRITES=1 \
//     pnpm --filter @workspace/api-server exec tsx src/scripts/fix-offer-138-overcharge.ts

export {};

import { pool, db, ripperdocs, walletTransactions, auditLog } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { applyWalletDelta } from "../lib/economy";

const OFFER_ID = 138;
const CLINIC_ID = 12;
const CLINIC_LEG_KEY = `offer:${OFFER_ID}:overcharge-fix:venue`;

async function main() {
  const allowed = process.env.REPLIT_DEPLOYMENT === "1" || process.env.ALLOW_EXTERNAL_WRITES === "1";
  if (!allowed) {
    console.error("Refusing to run: UB writes would be suppressed. Set ALLOW_EXTERNAL_WRITES=1.");
    process.exit(1);
  }
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!host.includes("neon.tech")) {
    console.error(`Refusing to run: DATABASE_URL host '${host}' is not the live Neon prod DB.`);
    process.exit(1);
  }

  // Leg 1: refund the buyer +3,000.
  const refund = await applyWalletDelta({
    userId: "310504104407465984",
    discordId: "310504104407465984",
    amount: 3000,
    source: "ripperdoc",
    kind: "shop_refund",
    reason: "Refund: neofiber service overcharge @ LunarVeil (charged 10,000, correct price 7,000)",
    memo: "Refund: neofiber overcharge @ LunarVeil (offer #138)",
    characterId: 665,
    counterpartyName: "LunarVeil",
    relatedEntityType: "sale_offer",
    relatedEntityId: OFFER_ID,
    ripperdocId: CLINIC_ID,
    idempotencyKey: `offer:${OFFER_ID}:overcharge-refund`,
  });
  console.log("Buyer refund:", refund.status, "balance", refund.previousBalance, "->", refund.balance);
  if (!refund.ok && refund.status !== "duplicate") {
    console.error("Buyer refund failed — aborting before any other leg.", refund.error);
    process.exit(1);
  }

  // Leg 2: claw back the commission overpayment -2,100.
  const clawback = await applyWalletDelta({
    userId: "463088295837171742",
    discordId: "463088295837171742",
    amount: -2100,
    source: "commission",
    kind: "commission",
    reason: "Commission correction: neofiber @ LunarVeil overcharge (70% of 3,000)",
    memo: "Commission clawback 70% of 3,000 overcharge (offer #138)",
    characterId: 59,
    counterpartyName: "LunarVeil",
    relatedEntityType: "sale_offer",
    relatedEntityId: OFFER_ID,
    ripperdocId: CLINIC_ID,
    idempotencyKey: `offer:${OFFER_ID}:commission-clawback`,
  });
  console.log("Commission clawback:", clawback.status, "balance", clawback.previousBalance, "->", clawback.balance);
  if (!clawback.ok && clawback.status !== "duplicate") {
    console.error("Commission clawback FAILED. Buyer refund already applied — resolve manually or re-run.", clawback.error);
    process.exit(1);
  }

  // Leg 3: debit the clinic wallet -900 + venue ledger row, atomically.
  await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, CLINIC_LEG_KEY));
    if (dup) {
      console.log("Clinic leg already applied (ledger", dup.id, ") — skipping.");
      return;
    }
    const [venue] = await tx
      .update(ripperdocs)
      .set({ balance: sql`${ripperdocs.balance} - 900` })
      .where(eq(ripperdocs.id, CLINIC_ID))
      .returning();
    await tx.insert(walletTransactions).values({
      ripperdocId: CLINIC_ID,
      characterId: venue.ownerCharacterId ?? null,
      counterpartyCharacterId: 665,
      counterpartyName: "Anton Robinovitch",
      amount: -900,
      kind: "shop_refund",
      source: "ripperdoc",
      memo: "Overcharge correction: neofiber service (offer #138) — venue share of 3,000 refund",
      relatedEntityType: "sale_offer",
      relatedEntityId: OFFER_ID,
      previousBalance: venue.balance + 900,
      newBalance: venue.balance,
      syncStatus: "synced",
      idempotencyKey: CLINIC_LEG_KEY,
    } as never);
    await tx.insert(auditLog).values({
      category: "shop",
      action: "offer_overcharge_correction",
      actorId: "system",
      actorName: "system (staff-requested correction)",
      targetType: "sale_offer",
      targetId: String(OFFER_ID),
      message:
        "Corrected neofiber service overcharge @ LunarVeil: buyer +3,000 refund, commission -2,100 clawback, clinic -900 (price corrected 10,000 -> 7,000).",
    });
    console.log("Clinic wallet:", venue.balance + 900, "->", venue.balance);
  });

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
