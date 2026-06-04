---
name: Player wallet DM notifications
description: How/where player-facing Discord DMs fire for mission payouts and automatic wallet charges, and the rules new charge types must follow.
---

# Player wallet DM notifications

Players get a Discord DM when they (a) receive a mission player-payout, or (b) are
hit by any AUTOMATIC charge (rent, business rent, baseline living cost, Trauma Team,
Xanadu Gold, weekly cyberpsychosis meds). Helpers live in
`api-server/src/lib/notifications.ts`: `notifyMissionPayout` and `notifyAutoCharge`,
both fail-safe wrappers over `sendDirectMessage`.

**Rules for adding a new automatic charge / payout type:**
- Fire the DM ONLY after the real-money side effect succeeds — i.e. AFTER
  `patchBalance(...)` returns non-null (UnbelievaBoat debit/credit actually moved
  money). Never before the UB call, never on simulated/failed/no-discord paths.
- Dispatch fire-and-forget with `void notify...(...)` (do NOT await). The wallet/cron
  flow must never block on Discord latency. The helpers swallow their own errors, so
  there is no floating-rejection risk.
- Pass `newBalance: ub.cash` (the post-charge cash balance) when available.

**Why:** awaiting DMs inline stalled payout/charge loops on Discord I/O, and Discord
`fetch` calls had no timeout so a hung request could freeze a whole cron run.

**Gating is already correct by construction — do not add extra env gates:**
- Autobill crons (`monthly_rent`, `cyberware_humanity`) only execute their body when
  `isSystemLive(...)` is true.
- `payMissionPlayers` DMs only in the live+success branch (test mode returns
  "simulated" earlier).
- `sendDirectMessage`/`postToChannel` themselves no-op unless `externalWritesAllowed()`
  (deployment env), and both now use `AbortSignal.timeout(10_000)` on their fetches.

Mission ACTOR/NPC payouts are intentionally NOT DM'd (they already post to the
npc-spending channel); only player payouts get DMs.
