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

# Cyberware meds history → ledger (recent) + DM-log import (full year)
**Why:** confirmed meds deductions for the whole year live ONLY in the bot's
OPERATOR DM thread, not in any channel or DB table. The bot DM'd whichever staffer
ran the sweeps the full weekly collection log for the entire server (~1.5k
confirmed `✅ Deducted $N ... for cyberware meds` lines, back ~a year). The
`bot_balance_history` ledger only kept the recent (~last month) and the
#rent-payments channel only a handful. The `💸 Estimated Due` channel estimates
are NOT deductions — ignore them; the DM "Deducted" lines are the real record.
**Key enabler:** our `DISCORD_BOT_TOKEN` IS the bot account itself, so it can read
its OWN DM history (open DM via `POST /users/@me/channels` with the operator's id,
then GET messages). `/users/@me` returns the bot's id — don't confuse it with a
player id.
- Importer `scripts/src/import-dm-meds.ts` reads the operator DM (operator id via
  `MEDS_DM_USER_ID`, default baked into the script). Each DM msg holds MANY
  deductions → synthetic per-event message_id + logical dedup on
  `userId|UTC-date|amount|week` (one meds charge per user per week) so
  channel/DM/rerun never double-insert. week from inline `(week N)` or the
  preceding `Charging <@id> $N for week N` line.
- `/me/cyberware-history` uses the SAME boundary merge as rent: ledger rows +
  `bot_rent_payment_events kind='cyberware_meds'` rows STRICTLY BEFORE this user's
  earliest ledger meds ts (ledger owns the recent weeks, DM/channel the older).

**How to apply:** both rent AND meds history use the same ledger+channel boundary
merge; debits are returned NEGATIVE so the shared `ActivityHistoryDialog`
(showAmount) renders them red/outflow. ALL FINANCES (`/me/financial-history`) is
the raw ledger dump (all reasons, ~2026-05 onward).
