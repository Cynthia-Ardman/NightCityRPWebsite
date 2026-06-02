---
name: Rent & cyberware-meds history data sources
description: Which legacy source is authoritative for player-facing rent vs cyberware-meds history, and why they differ.
---

Legacy bot tracked rent AND cyberware meds PER DISCORD USER (not per character).
Player-facing history must key on `users.discord_id`, not characterId.

# Rent history → MERGE of two complementary legacy sources
**Why:** neither source alone is complete. The #rent-payments channel goes back a
full year but its itemized `paid: $N` lines have NO Trauma Team and patchy
baseline/membership coverage. The `bot_balance_history` ledger is fully itemized
(incl. Trauma Team) but only covers ~2026-05 onward.

`/me/rent-history` merges them: ledger rent rows for the window it covers + channel
rows STRICTLY BEFORE this user's earliest ledger rent ts (boundary = min ledger ts;
"strictly before" so the overlap month isn't double-counted). Ledger deltas are
already negative; channel amounts are negated. Sort desc, limit 500.

## Channel source (bot_rent_payment_events)
- Channel id 1379942591721902152, ~3322 msgs, ~1 year back.
- Authoritative paid confirmations only:
  - `✅ <@U> — <Label> paid: $N` (Baseline living cost / Housing Rent / Business
    Rent / Xanadu Gold membership / Trauma Team). Trauma Team never actually
    appears as a paid line — it only exists in the ledger.
  - cyberware meds: TWO interchangeable phrasings — `Deducted $N for cyberware
    meds from <@U> (week N)` AND `Deducted $N from <@U> for cyberware meds
    (week N)`. Match both.
- IGNORE noise: `!`-commands, `💸 Estimated Due` (estimates — say "not included in
  total"/"collected separately"), `🔍 Working on`, `✅ Completed for`/`Rent
  collection completed`/`🤖 Auto rent collection` sweep markers.
- Importer `scripts/src/import-rent-payments.ts` upserts into
  `bot_rent_payment_events` keyed on unique `message_id` (ON CONFLICT DO NOTHING),
  idempotent. ~774 rows.

## Ledger source for rent (bot_balance_history)
- Rent reasons (match via `~*`): `flat monthly fee` (= baseline, "$500 each"),
  `housing rent`, `business rent`, `xanadu gold membership`,
  `trauma team subscription`. `ledgerRentLabel()` normalizes these to friendly
  labels ("flat monthly fee" → "Baseline living cost", etc.).

# Cyberware meds history → SAME merge (ledger primary + older channel)
**Why:** the ledger (`bot_balance_history` reason ILIKE 'Cyberware meds%') is the
authoritative recent source (~191 rows, 2026-05 onward) WITH real weekly amounts.
The channel adds only ~17 older confirmed deductions (mostly week-1 June 2025).
Most of the gap year has NO recoverable confirmed meds charges — the bot posted
only `💸 Estimated Due` estimates ("collected separately by staff — not included
in total"), which are NOT real deductions. So meds history is shallow by nature.
- `/me/cyberware-history` uses the SAME boundary merge as rent: ledger rows +
  channel `kind='cyberware_meds'` rows STRICTLY BEFORE this user's earliest ledger
  meds ts. Don't expect a full year of meds — the data doesn't exist.

**How to apply:** both rent AND meds history use the same ledger+channel boundary
merge; debits are returned NEGATIVE so the shared `ActivityHistoryDialog`
(showAmount) renders them red/outflow. ALL FINANCES (`/me/financial-history`) is
the raw ledger dump (all reasons, ~2026-05 onward).
