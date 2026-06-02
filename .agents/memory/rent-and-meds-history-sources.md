---
name: Rent & cyberware-meds history data sources
description: Which legacy source is authoritative for player-facing rent vs cyberware-meds history, and why they differ.
---

Legacy bot tracked rent AND cyberware meds PER DISCORD USER (not per character).
Player-facing history must key on `users.discord_id`, not characterId.

# Rent history → parse Discord #rent-payments channel
- Channel id 1379942591721902152, ~3322 msgs, ~1 year back.
- Authoritative paid confirmations only:
  - `✅ <@U> — <Label> paid: $N` (Baseline living cost / Housing Rent / Business
    Rent / Xanadu Gold membership / Trauma Team)
  - `✅ Deducted $N for cyberware meds from <@U> (week N).`
- IGNORE noise: `!`-commands, `💸 Estimated Due` (estimates), `🔍 Working on`,
  `✅ Completed for` summaries.
- Importer `scripts/src/import-rent-payments.ts` upserts into
  `bot_rent_payment_events` keyed on unique `message_id` (ON CONFLICT DO NOTHING),
  so rerun is idempotent. ~773 rows, 207 users, 206 matched to portal accounts.

# Cyberware meds history → bot_balance_history ledger (NOT the channel)
**Why:** the channel only has ~16 cyberware confirmations, but the
`bot_balance_history` ledger has ~190 real `Cyberware meds week N` deductions WITH
amounts. The ledger is far better coverage, so it is authoritative for meds.
- Endpoint reads `bot_balance_history WHERE reason ILIKE 'Cyberware meds%'`.

**How to apply:** rent debits are returned NEGATIVE so the shared
`ActivityHistoryDialog` (showAmount) renders them red/outflow. Don't confuse the
two sources — rent = new channel-parsed table, meds = existing ledger.
