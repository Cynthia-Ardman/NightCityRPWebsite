---
name: ncrp-portal page width tiers
description: The standardized two-tier max-width convention for page-root containers in ncrp-portal.
---

# Page-root width convention (ncrp-portal)

Every routed page's outermost `mx-auto` container uses ONE of two width caps:
- **Standard pages → `max-w-7xl`** (~1280px) — the default for almost everything.
- **Data/table-heavy pages → `max-w-[1600px]`** — pages with wide tables: MyRequests,
  MyOffers, Ledger, CatalogRent, CatalogGuns, AdminDashboard, CatalogCyberware, MyLoreSubmissions.

**Why:** the portal previously used a grab-bag of caps (3xl–6xl) which made content
narrower than needed, causing squished/wrapping titles and frequent horizontal scrollbars
where a fixed-width table (`min-w-[...]` inside `overflow-x-auto`) exceeded the cap. User
asked for a consistent, roomier "Balanced" layout. There is NO global max-width in
AppLayout (sidebar is a fixed `w-64`); width is set per page.

**How to apply:** when adding/editing a page, set its root container to `max-w-7xl` unless
it shows a wide data table, then use `max-w-[1600px]`. Do NOT widen genuinely centered
hero/intro cards (e.g. Home unauth banner stays `max-w-2xl`) or inner sub-forms
(e.g. AdminLifestyle form `max-w-md`). Table `min-w-[...]` floors stay as-is — they
degrade gracefully via `overflow-x-auto` on small viewports. EditCharacterDialog uses
`w-[95vw] max-w-[1400px]` (wider than the old 5xl) so it isn't a thin sliver on big screens.
