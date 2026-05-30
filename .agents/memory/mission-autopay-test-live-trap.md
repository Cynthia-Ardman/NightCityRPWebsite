---
name: Mission autopay Test→Live trap
description: Why simulated missions can become permanently unpayable, and the live-retry recovery in runMissionAutoPay
---

# Mission autopay Test→Live trap

`payMissionPlayers` stamps `missions.autoPayProcessedAt` on EVERY run (incl. Test mode, where assignments are marked `simulated`). `runMissionAutoPay`'s primary candidate query filters on `autoPayProcessedAt IS NULL`. Since the manual "Pay Players" button was removed, a mission swept while the system was in Test mode would be stamped processed and then NEVER paid for real after flipping to Live — and the admin "run job" path also goes through `runMissionAutoPay`, so it couldn't recover it either.

**Recovery rule:** `runMissionAutoPay` has a second "live-retry" pass (only when `ctx.live`) that re-selects already-processed, non-cancelled missions that still have assignments in `simulated|failed|unpaid`, and re-runs `payMissionPlayers` (which re-claims those rows atomically). Already-`paid` rows are skipped, so no double-pay.

**Why:** removing the manual button closed the only escape hatch for simulated/stuck missions; the live-retry is the replacement.

**How to apply:**
- The live-retry MUST stay gated on `ctx.live` or Test mode churns the same missions every 15-min tick.
- It MUST exclude permanently-unpayable rows (`paymentStatus='failed' AND paymentError='No Discord id for player'`) or those missions loop forever (re-claim → re-fail → audit row every tick). Transient UB-payout failures stay eligible and settle once UB recovers.
- Player payout now depends ENTIRELY on the autopay cron + the `mission_autopay_enabled` kill switch (default OFF) + the Test/Live toggle. If the kill switch is OFF or the system is in Test mode in prod, players are silently never paid and there is no UI fallback. Confirm the prod flag state.
