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

# Cyberware meds history → bot_balance_history ledger (NOT the channel)
**Why:** the channel only has ~16 cyberware confirmations, but the
`bot_balance_history` ledger has ~190 real `Cyberware meds week N` deductions WITH
amounts. The ledger is far better coverage, so it is authoritative for meds.
- Endpoint reads `bot_balance_history WHERE reason ILIKE 'Cyberware meds%'`.

**How to apply:** rent debits are returned NEGATIVE so the shared
`ActivityHistoryDialog` (showAmount) renders them red/outflow. Don't confuse the
two sources — rent = new channel-parsed table, meds = existing ledger.
