---
name: Cyberware-meds refund forensics (legacy charges were correct)
description: Result + method of the June 2026 "who was overcharged for meds, who to refund" investigation on LIVE prod.
---

# Conclusion: no erroneous meds overcharges; no refunds warranted

A forensic refund analysis on LIVE prod found **zero** erroneous cyberware-meds overcharges.

**Why (evidence):**
- The website's `cyberware_humanity` cron has charged NOBODY in prod: 0 `wallet_transactions` kind='meds', and no deployment-log entries for cyberpsychosis/cyberware_humanity. The checkup-date import fix was *preventive* — the new cron simply hadn't run yet.
- All real meds charges are LEGACY bot charges imported as `wallet_transactions` kind='historical' with memo `[legacy-bal:NNN] Cyberware meds week W`. (~150 rows, ~€131k, 4 weekly runs May 4/11/18/25 2026, 59 players.) The `[legacy-bal:NNN]` maps to `bot_balance_history.id` for the real `ts` (live `created_at` is unreliable — some = import time).
- Charge amounts match the documented formula exactly (week→amount: medium cap 2000 → €500/1000/2000 at wk6/7/8+, high €5000, extreme €10000).
- Cross-referencing every charge against the real checkup history (Discord #ripperdoc-checkups, rebuilt from `!cu <@id>` commands + "did a checkup on `<char>`" lines resolved via roster name tokens) found **no** checkup immediately preceding any high charge. High charges all correspond to genuine multi-week gaps.
- **Smoking gun that the legacy bot reset correctly:** Smoke was charged wk9 (€5000) May 11, checked up May 17, and the next charge (May 25) dropped to **wk1 (€39)**.

**How to apply / re-run:** the legacy weekly meds streak counter resets on checkup and scales with the real gap; do NOT assume high charges are bugs. If asked again, reconstruct checkup timelines from the raw channel scrape (`.local/checkups-raw.jsonl`) — `!cu <@id>` gives owner+ts directly; "did a checkup on NAME" needs `.local/roster.json` name-token resolution. A few players (e.g. triggertony €5500) have no resolvable checkup record at all but their charges still align with their last known checkup; flag for manual spot-check only.
