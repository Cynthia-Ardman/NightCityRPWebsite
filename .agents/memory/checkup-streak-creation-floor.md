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

**Billing field is load-bearing, displays are not:** the cron charges money ONLY off `characters.lastCheckupAt` (NOT `checkup_streak`, NOT `bot_cyberware_status`). But the dashboard `/upcoming-bills` trusts `bot_cyberware_status.weeks` FIRST when a row exists, falling back to `characters.lastCheckupAt` only when absent. So a bulk lastCheckupAt fix must ALSO refresh `bot_cyberware_status` (weeks = `within7d ? 0 : weeksSinceLastCheckup`) for owners that already have a row, or the dashboard nags a stale (high) projection while the cron correctly charges low. Don't create new bot_cyberware_status rows (portal-only users fall back to lastCheckupAt cleanly).

**"Celeste"/"CelesteNexus" name trap:** rendered Discord mentions (`@CelesteNexus/persephone`) resolve from the underlying user ID, not the display string. `CelesteNexus` = account `celestereaper` (1072…, owns "Cupid", id 195) — a DIFFERENT player from `Celeste Mav'Rose` = `bensubean` (1121…, char id 347). Don't conflate same-first-name chars across accounts when matching checkups.

Side effect (intended): the 7-day `checkupIsCurrent` meds-suppression now also keys off the effective date, so a <7-day-old chromed PC gets a grace week. Tradeoff (accepted): a newly approved sibling character can move the household effective date forward; gated by sheet approval, not an open exploit.
