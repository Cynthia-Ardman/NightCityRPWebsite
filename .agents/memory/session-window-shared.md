---
name: Session window shared lib
description: The Sunday 2-9pm Pacific live-session gate shared by attendance claim and open-shop.
---
`artifacts/api-server/src/lib/sessionWindow.ts` exports `isSessionWindowOpen`, `nextSessionWindowStart`, `SESSION_WINDOW_HINT` ("Sundays 2:00pm–9:00pm Pacific"). TZ America/Los_Angeles via Intl (DST-safe), day Sun, hours 14–21 (21 exclusive).

Used by BOTH the weekly attendance claim (attendance.ts) and `POST /characters/:id/open-shop` (characters.ts). Both endpoints 403 outside the window; `GET /characters/:id/shop` and the attendance status route expose `windowOpen/windowHint/nextWindowOpensAt`.

**Why:** server is authoritative — frontend only disables the button. Any new "live session only" action should import this lib, not re-implement the window. `nextSessionWindowStart` steps hour-by-hour so it can return 14:xx not exactly 14:00 (cosmetic; inherited from original attendance logic).


## Former index detail (full)
Sun 2-9pm Pacific gate (attendance + open-shop) in lib/sessionWindow.ts, server authoritative; key weekly claim on Pacific Sunday date (sessionWeekKey), NOT UTC ISO week, or the UTC-midnight straddle allows a double-claim ([week key](attendance-week-key.md)).
