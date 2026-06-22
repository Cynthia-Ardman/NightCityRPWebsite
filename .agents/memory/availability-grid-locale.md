---
name: Availability grid locale formatting
description: Why the mission availability grid forces a fixed clock/date format instead of the viewer's locale.
---

The mission sign-up availability picker (`components/AvailabilityGrid.tsx`,
used by `pages/Missions.tsx` + `pages/MissionDetail.tsx`) renders ONE shared
full-day (48 half-hour rows) × 14-day grid for everyone. There is no per-user
12h vs 24h variant.

Players reported "some people have 12 hour availability, some have 24 hour" —
that was purely **locale-dependent display formatting**: `toLocaleTimeString`/
`toLocaleDateString` with `undefined` locale gave US users a 12-hour AM/PM clock
and "6/21" dates, EU/UK users a 24-hour clock and "21/06". The selectable grid
was identical; only the labels looked different (plus scroll position).

**Decision:** format the labels with a FIXED locale (24-hour times via en-GB,
"Jun 21" dates via en-US `month:"short"`) so every player sees the same grid.

**Why:** consistency removes the confusion and 24h/short-month is unambiguous
across regions; the cyberpunk/military theme already leans 24-hour.

**How to apply:** keep times in the viewer's local TIMEZONE (intentional — cells
map to absolute UTC instants so cross-tz applicants overlap), but never pass
`undefined` locale to toLocale*String here; pin the locale + `hour12:false`.
