---
name: Attendance weekly claim key
description: Why the weekly attendance claim is keyed on the Pacific Sunday date, not a UTC ISO week
---

The weekly attendance claim (`attendance_claims`, UNIQUE(userId, weekStart)) MUST
key `weekStart` on the **Pacific Sunday date** (`sessionWeekKey` in
`lib/sessionWindow.ts`), not a UTC ISO-week Monday.

**Why:** the claim window is Sun 2–9pm Pacific, which straddles UTC midnight
(Sun 21:00 → Mon 04:00 UTC). A UTC-derived week key splits a single Sunday
session across two different keys, so the unique index doesn't fire and a user
can claim twice in one session (the original double-claim bug).

**How to apply:** any per-session weekly gate (attendance, open-shop, etc.) that
must fire once per Sunday session has to derive its key from the Pacific session
day, never from `getUTCDay`/UTC date math. The session window is authoritative in
`lib/sessionWindow.ts`.

**Rollout trap:** when switching an existing key scheme from UTC-Monday to
Pacific-Sunday, pre-cutover rows still carry the old key for the in-flight week.
`legacySessionWeekKeys()` returns the two old UTC-Monday candidates (Sunday−6d
and Sunday+1d), but those overlap with *other* weeks' keys — so a matched legacy
row MUST be disambiguated by re-deriving `sessionWeekKey(row.claimedAt)`; never
trust a bare legacy-key match. `findThisWeekClaim` in `routes/attendance.ts` does
this.
