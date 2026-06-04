---
name: Events recurrence & listing
description: How recurring Discord events flow to the calendar/dashboard and the listEvents cap pitfall.
---

# Recurring events on the portal calendar

- Discord scheduled events carry a `recurrence_rule`; we normalise it into `events.recurrenceRule` (jsonb) and expand it **client-side** into per-occurrence chips. Expansion lib: `artifacts/ncrp-portal/src/lib/eventRecurrence.ts` (`expandOccurrences`), reused by `DirectoryCalendar` and the dashboard cards.
- Recurrence rule encoding: `frequency` 0=yearly,1=monthly,2=weekly,3=daily; `byWeekday` uses Discord **0=Mon..6=Sun**. Honour `interval`, `count`, and `until`.

## byWeekday is in the UTC frame — never place on an absolute weekday

**Rule:** Discord's `byWeekday` always equals the **UTC** weekday of `startAt`, not the intended local weekday. A Wed-6pm-Pacific event is stored `startAt = Thu 01:00 UTC` with `byWeekday=[3]` (Thursday). So expanding by mapping byWeekday → an absolute (local) weekday lands every occurrence on the WRONG day (Thursday), even though the detail page — which renders the raw instant in local time — correctly shows Wednesday.

**Fix / how to expand weekly:** anchor on the base **instant** and only ADD whole days. Step `baseStart + 7*interval*week`, and for multi-weekday rules add day-offsets computed *relative to the base's own UTC weekday* (`(toJsWeekday(wd) - baseStart.getUTCDay() + 7) % 7`; the base entry yields offset 0). Rendering those instants in local time preserves the base event's exact wall-clock day & time, matching the detail page.

**Why:** the detail page and the calendar must agree; the only timezone-safe anchor they share is the stored instant itself.

## listEvents cap pitfall

**Rule:** `listEvents()` caps at 500 rows ordered by `desc(startAt)`. A recurring series can have an OLD anchor `startAt`, so the desc-limited query can drop it before the client ever expands it. listEvents must therefore **always merge in every active row where `recurrenceRule IS NOT NULL`** (dedup by id), regardless of the cap.

**Why:** client-side expansion can only show a series the API actually returned; an excluded recurring row silently disappears from the whole calendar/dashboard.

**How to apply:** any change to listEvents ordering/limit must preserve the "recurring rows always included" guarantee. If expansion ever moves server-side, this merge becomes moot.
