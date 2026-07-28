---
name: Availability grid locale formatting
description: Why the mission availability grid pins a fixed clock/date format and how the per-viewer 12h/24h toggle layers on top.
---

The mission sign-up availability picker (`components/AvailabilityGrid.tsx`,
used by `pages/Missions.tsx` + `pages/MissionDetail.tsx`) renders ONE shared
full-day (48 half-hour rows) × 14-day grid for everyone.

Players reported "some people have 12 hour availability, some have 24 hour" —
that was purely **locale-dependent display formatting**: `toLocaleTimeString`/
`toLocaleDateString` with `undefined` locale gave US users a 12-hour AM/PM clock
and "6/21" dates, EU/UK users a 24-hour clock and "21/06". The selectable grid
was identical; only the labels looked different.

**Decision (base):** never pass `undefined` locale to toLocale*String here. Pin
the format deterministically — date is ALWAYS `month:"short", day:"numeric"`
(en-US, "Jun 21") regardless of clock choice; times keep the viewer's local
TIMEZONE (intentional — cells map to absolute UTC instants so cross-tz
applicants overlap).

**Decision (clock toggle):** there IS now a per-viewer 12h/24h clock-format
toggle (`ClockFormatToggle`), shown in both edit and heatmap headers. State
lives in `AvailabilityGrid` and persists in `localStorage` key
`ncrp.availability.hour12` ("1"=12h). DEFAULT is 24-hour (en-GB, `hour12:false`)
— absence of the key means 24h, preserving the original behavior. 12h uses en-US
+ `hour12:true`. Threading: `rowLabel(row, hour12)` for the left column,
`formatInstant(iso, hour12)` for heatmap hover.

**Why:** consistency removed the original confusion; some players still prefer a
12-hour clock, so the format (not the timezone, not the grid) is now a personal,
remembered choice rather than an accident of locale.

**How to apply:** any new time/date label in this grid must take the `hour12`
flag and keep the date format fixed; only the clock format follows the toggle.

- Application pre-fill must use saved DATE-SPECIFIC instants verbatim when any fall in the visible window; collapsing to a weekly pattern and re-expanding repaints days the player deliberately cleared (refresh "undoes" edits). Weekly re-projection only for fully-stale (all-past) sets.
