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

**How to apply / re-run:** the legacy weekly meds streak counter resets on checkup and scales with the real gap; do NOT assume high charges are bugs. A few players (e.g. triggertony €5500) have no resolvable checkup record at all but their charges still align with their last known checkup; flag for manual spot-check only.

## Checkup extraction completeness (CRITICAL — original resolver was incomplete)
`#ripperdoc-checkups` (`.local/checkups-raw.jsonl`) emits a checkup under MULTIPLE patterns; capturing only `!cu <@id>` + `did a checkup on NAME` MISSES the largest direct-ID category. Capture ALL of:
- `!cu <@id>` — owner id direct (~500)
- `Ripperdoc checkup on <@id>. No money deducted.` — owner id direct (~550) ← the one the first pass missed
- `Streak is now N week(s) for <@id>` — owner id direct + streak value (~78)
- `<ripperdoc> did a checkup on <char>` / `Removed checkup role from <char>` — need `.local/roster.json` name-token resolution
- (charge log, not a checkup, but ground-truth: `Deducted $N for cyberware meds from <@id> (week N)` ~1200; ends ~2026-03-16 so the May wallet charges aren't in the chat charge log.)

The incomplete resolver left `.local/checkup-byowner.json` missing 32 owners + 9 stale; the corrected merge has 172 owners. Re-importing to live prod corrected 12 PCs' `last_checkup_at` (all bills strictly LOWER — the import's safety assertion guarantees it never raises a bill).

**Verified with complete data:** 0 of 150 May wallet meds charges are overcharges (charged week ≤ checkup-implied week +1 for every charge). Conclusion unchanged: no refunds; the gap only affected *projected future* bills, now fixed.


## Former index detail (full)
June-2026 probe: legacy meds charges were CORRECT (reset on checkup, scale w/ gap), new cron never charged, no refunds. #ripperdoc-checkups has 4+ patterns (incl. `Ripperdoc checkup on <@id>. No money deducted.` + `Streak is now`, direct ids) — capture all or owners go unmapped.
