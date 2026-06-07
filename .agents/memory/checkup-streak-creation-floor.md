---
name: Checkup streak creation floor
description: Why a null lastCheckupAt must NOT mean instant max meds streak — creation date is the implicit initial checkup.
---

# Cyberware checkup streak: creation date is the implicit initial checkup

`weeksSinceLastCheckup(null)` (lib/jobs.ts) returns `CYBERWARE_MAX_STREAK` (12) — "never checked up = worst case". Checkups are HOUSEHOLD-scoped: the streak uses `MAX(lastCheckupAt)` across the owner's characters. So a brand-new chromed PC whose household has no recorded checkup was billed/displayed at the full 12-week doubling streak the moment they existed.

**Rule:** a character's `createdAt` counts as an implicit initial checkup. Effective per-character date = `lastCheckupAt ?? createdAt`, then `MAX` across the household. Keep `weeksSinceLastCheckup()` itself PURE (null→max) — apply the fallback at the call sites where `createdAt` is known.

**Why:** a 10-day-old character reading "12 weeks since checkup" is wrong and over-bills. Owner-confirmed policy: creation = fresh start.

**How to apply — there are FOUR surfaces that must stay in sync:**
1. dashboard.ts `/dashboard/upcoming-bills` household reduce.
2. jobs.ts weekly cyberpsychosis-meds cron household reduce.
3. CharacterDetail.tsx `CheckupStreakCard` (player view).
4. RipperdocConsole.tsx WEEKS_SINCE_CHECKUP (operator view) — needs `createdAt` on the `/admin/characters/:id/medical` response (added to openapi.yaml).

Side effect (intended): the 7-day `checkupIsCurrent` meds-suppression now also keys off the effective date, so a <7-day-old chromed PC gets a grace week. Tradeoff (accepted): a newly approved sibling character can move the household effective date forward; gated by sheet approval, not an open exploit.
