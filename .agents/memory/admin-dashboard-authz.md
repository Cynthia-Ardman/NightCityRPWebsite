---
name: Admin dashboard authz scope
description: Who can reach the AdminDashboard UI vs the /admin/* character endpoints, and the deliberate split.
---

The AdminDashboard page (`artifacts/ncrp-portal/src/pages/AdminDashboard.tsx`) renders only for `user?.isAdmin` — fixers never see it.

But the sibling character-management endpoints (`GET /admin/characters`, `PUT/DELETE /admin/characters/:id/owner`) are gated `adminOrFixer`, i.e. more permissive than the UI.

**Decision:** the manual character-create endpoint (`POST /admin/characters`) is `adminOnly`, NOT `adminOrFixer`.

**Why:** the feature was requested "admin-only", and the only UI entry point (the dashboard card) is already admin-gated. Matching `adminOnly` keeps API access equal to UI access instead of silently allowing fixers via direct API calls.

**How to apply:** when adding a NEW admin-dashboard-only action, prefer `adminOnly` to mirror the page guard. Only fall back to `adminOrFixer` if the action is also reachable from a fixer-visible surface (like the legacy owner-assign endpoints were).
