---
name: Events recurrence & listing
description: How recurring Discord events flow to the calendar/dashboard and the listEvents cap pitfall.
---

# Recurring events on the portal calendar

- Discord scheduled events carry a `recurrence_rule`; we normalise it into `events.recurrenceRule` (jsonb) and expand it **client-side** into per-occurrence chips. Expansion lib: `artifacts/ncrp-portal/src/lib/eventRecurrence.ts` (`expandOccurrences`), reused by `DirectoryCalendar` and the dashboard cards.
- Recurrence rule encoding: `frequency` 0=yearly,1=monthly,2=weekly,3=daily; `byWeekday` uses Discord **0=Mon..6=Sun**, NOT JS `getDay()` (0=Sun). Convert with `(wd+1)%7`. Honour `interval`, `count`, and `until`.

## listEvents cap pitfall

**Rule:** `listEvents()` caps at 500 rows ordered by `desc(startAt)`. A recurring series can have an OLD anchor `startAt`, so the desc-limited query can drop it before the client ever expands it. listEvents must therefore **always merge in every active row where `recurrenceRule IS NOT NULL`** (dedup by id), regardless of the cap.

**Why:** client-side expansion can only show a series the API actually returned; an excluded recurring row silently disappears from the whole calendar/dashboard.

**How to apply:** any change to listEvents ordering/limit must preserve the "recurring rows always included" guarantee. If expansion ever moves server-side, this merge becomes moot.
