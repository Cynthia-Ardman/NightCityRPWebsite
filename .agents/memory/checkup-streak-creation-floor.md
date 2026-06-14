---
name: Checkup streak creation floor
description: Why a null lastCheckupAt must NOT mean instant max meds streak — creation date is the implicit initial checkup.
---

# Cyberware checkup streak: creation date is the implicit initial checkup

`weeksSinceLastCheckup(null)` (lib/jobs.ts) returns `CYBERWARE_MAX_STREAK` (12) — "never checked up = worst case". Checkups are HOUSEHOLD-scoped: the streak uses `MAX(lastCheckupAt)` across the owner's characters. So a brand-new chromed PC whose household has no recorded checkup was billed/displayed at the full 12-week doubling streak the moment they existed.

**Rule:** a character's `createdAt` counts as an implicit initial checkup. Effective per-character date = `lastCheckupAt ?? createdAt`, then `MAX` across the household. Keep `weeksSinceLastCheckup()` itself PURE (null→max) — apply the fallback at the call sites where `createdAt` is known.

**Why:** a 10-day-old character reading "12 weeks since checkup" is wrong and over-bills. Owner-confirmed policy: creation = fresh start.

**How to apply — there are FIVE surfaces that must stay in sync:**
1. dashboard.ts `/dashboard/upcoming-bills` household reduce.
2. jobs.ts weekly cyberpsychosis-meds cron household reduce.
3. CharacterDetail.tsx `CheckupStreakCard` (player view).
4. RipperdocConsole.tsx WEEKS_SINCE_CHECKUP (operator view) — needs `createdAt` on the `/admin/characters/:id/medical` response (added to openapi.yaml).
5. ANY bulk write to `characters.lastCheckupAt` (e.g. `scripts/src/import-ripperdoc-checkups.ts`, which backfills from the #ripperdoc-checkups Discord channel) MUST guard `newDate > (lastCheckupAt ?? createdAt)` per character — only ever move the effective date FORWARD. Setting an OLDER channel date pushes the effective date below the createdAt floor and RAISES the bill. Verified live (2026-06-14): of 401 prod PCs, only ~73 had a channel checkup newer than their floor; everyone else (incl. recently-created chars) was correctly skipped, never harmed.

**Billing field is load-bearing, `bot_cyberware_status` is dead for billing:** the cron charges money ONLY off `characters.lastCheckupAt` (NOT `checkup_streak`, NOT `bot_cyberware_status`). The dashboard `/upcoming-bills` projection USED to trust `bot_cyberware_status.weeks` first (overriding the authoritative date) — that path was REMOVED. Both the cron and `/upcoming-bills` now derive `weeksUnpaid` + the 7-day `checkupIsCurrent` guard purely from the household `max(lastCheckupAt ?? createdAt)`, so the displayed projection always equals what gets debited. `bot_cyberware_status`/`bot_cyberware_weekly_runs` are no longer read by dashboard.ts at all; a bulk `lastCheckupAt` fix no longer needs to also refresh that mirror.

**Same-first-name account trap:** rendered Discord mentions resolve from the underlying user ID, not the display string. Two different accounts can share a first name across their display handles and own different characters. Always match checkups by user ID / owner_id, never by display name — don't conflate same-first-name characters across accounts.

Side effect (intended): the 7-day `checkupIsCurrent` meds-suppression now also keys off the effective date, so a <7-day-old chromed PC gets a grace week. Tradeoff (accepted): a newly approved sibling character can move the household effective date forward; gated by sheet approval, not an open exploit.
