---
name: Cyberware band source of truth
description: Where a character's CWP/cyberware band actually comes from, and why the characters.cyberwareLevel column must not be trusted for display.
---

A character's cyberware "band" (none/medium/high/extreme) is DERIVED at read time
from their installed chrome, NOT stored on the character row.

- Real source: `inventory_items` rows with `category='cyberware'`, each carrying a
  `CWP n` token in `notes`. `sumCwpByCharacter(ids)` (artifacts/api-server/src/lib/cyberware.ts)
  parses + sums them; `deriveCyberwareBand(count)` (artifacts/api-server/src/lib/jobs.ts)
  buckets: 0-6 none · 7-9 medium · 10-12 high · 13+ extreme. This is the same source
  the dashboard meds bill and the cyberware billing cron use.
- `characters.cyberwareLevel` was NEVER populated from real chrome — in dev AND prod
  it is uniformly `'none'`. Treat it as an optional explicit staff OVERRIDE only
  (medium/high/extreme). `none` is indistinguishable from "unset", so never honour
  `none` as authoritative — fall through to the derived count.
- `characters.isOrganic` wins outright → band `organic` (only a handful of rows).
- `characters.lifeStatus` is also uniformly `'active'` in prod — there is no real
  per-character status data yet (set only via the archive editor going forward).

**Why:** The staff Character Archive showed every character as "CWP: NONE" because
it derived the band from `cyberwareLevel` instead of real inventory chrome.

**How to apply:** Any surface showing a per-character cyberware band must resolve it
from `sumCwpByCharacter` + `deriveCyberwareBand` (organic flag first, then optional
column override, then derived count) — not by reading `cyberwareLevel` directly.
The derived band can't be expressed as a single SQL predicate, so band FILTERING
is done in-memory after the row fetch (roster is small, capped at 2000).
