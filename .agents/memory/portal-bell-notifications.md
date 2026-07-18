---
name: Portal bell notifications
description: How to add new in-portal notification types and the traps hit while building the bell feed.
---

**Rule:** Any new player-facing event (charge, payout, decision, offer, fine, challenge) should also write a bell notification: `void createNotification({...})` (artifacts/api-server/src/lib/notifications.ts) at the SAME code site as the Discord DM.

**Why:** The bell is additive to DMs; the decision/charge is real regardless of external-write gating, so bell writes must NOT be gated on missions Test/Live, `REPLIT_DEPLOYMENT`, or the user having a resolvable discordId (DM helpers early-return when discordId is missing — put the bell write BEFORE that lookup).

**How to apply:**
- Always `void createNotification(...)` — fire-and-forget, never awaited in money paths; the helper swallows all errors (including FK violations).
- `href` is a portal-relative path; feed rows navigate with wouter.
- API: GET /notifications (cursor `before=<id>`), /notifications/unread-count, POST /notifications/mark-read (ids or all, caller-scoped). Bell UI: NotificationBell.tsx, mounted in both desktop TopBar and mobile header of AppLayout.tsx; mark-all-read fires on dropdown open.
- Trap: Orval emits some request bodies BOTH as a zod const (generated/api) and a TS type (generated/types) with the same name; the star re-exports in lib/api-zod/src/index.ts then fail tsc with "already exported a member". Fix by explicit re-export pairs (value from api, aliased type from types) — see existing examples in that file.
