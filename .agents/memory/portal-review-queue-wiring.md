---
name: Adding a new portal review queue
description: The integration points to wire when adding a fixer-propose/admin-approve queue (Lore, Guidebook) to the NCRP portal frontend.
---

# Adding a new admin review queue (mirror Lore/Guidebook)

When a new resource gets a "fixer proposes → admin approves" flow, the portal
frontend needs FOUR easy-to-miss wiring points beyond the page itself. Missing
any one leaves a silent gap (no badge, missing tab, or absent terminal history).

**Why:** these are spread across three files and there's no compile error if you
forget one — the queue just silently doesn't surface to admins.

**How to apply** (search existing Lore wiring as the template):
1. `pages/requests/PendingRequests.tsx` — add a `<Tab>` (trigger + content),
   gated on `canLore` (= `isAdmin`), plus a pending count via the list hook.
2. Same file, `useTerminalItems()` — fetch approved+rejected, push into
   completed/denied, AND extend the `TerminalKind` union (TS WILL error here, the
   one place that catches you).
3. `components/layout/AppLayout.tsx` — fold the pending count into `staffPending`
   (admin-only), so the sidebar "Pending Requests" badge includes it.
4. `App.tsx` — routes with `:id` placed AFTER specific sibling routes
   (`/mine`, `/new`, `/import`, `/:id/edit`), guarded by StaffArchiveGuard /
   AdminGuard.

**Editor seeding gotcha:** forms reused across `/:id/edit` routes (wouter keeps
the component mounted on param change) must seed via `useEffect` keyed on the
resource id, NOT a render-time `if (!seeded) setState(...)` — the latter goes
stale when navigating between two edit pages without a remount.

**Conflict model note:** Guidebook uses a pendingImport-on-page conflict model
(re-import flags the live page; review applies/dismisses), NOT Lore's separate
import-draft queue. Different import-review UI shapes for the same broad feature.
