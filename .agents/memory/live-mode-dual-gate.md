---
name: Live-mode dual gate (master + per-system)
description: How the Test/Live switch gates external/local mutations across systems, and what tests must set.
---

NCRP has a MASTER Test/Live switch plus per-system overrides (missions, housing, cyberware, evictions). A system is effectively Live ONLY when `isSystemLive(system)` = `isMasterLive() && per-system flag`. All flags default OFF (Test) and are fail-safe: any stored value that is not literal boolean `true` reads as OFF. Keys live in `bot_config` via `LIVE_MODE_KEYS`.

**Why:** Test mode must perform zero external/local mutations — no UB `patchBalance`, no wallet ledger rows, no `paid_through` advance, no lease delete, no Discord post — so staff can dry-run without touching live economy/Discord.

**How to apply:**
- `runJob` gates jobs by system: `monthly_rent→housing`, `cyberware_humanity→cyberware`, `eviction_sweep→evictions`. `mission_autopay` is NOT gated in `runJob` — its external effects are gated inside `missionsService`/`missionsConfig.isMissionsLiveMode()` (which delegates to `isSystemLive("missions")`).
- Any test that calls `runJob` (or mission pay paths) expecting REAL effects must set BOTH `LIVE_MODE_KEYS.master` AND the relevant per-system key to `true` first, or the gate short-circuits and the assertions silently see a no-op. `jobs-autobill.test.ts` and `missions.test.ts` do this in `beforeEach`/`setLiveMode`.
- `monthly_rent` runs several bill types per character, so `patchBalance` can fire >1 time per tenant — assert "called" + a specific ledger row, not an exact call count.
