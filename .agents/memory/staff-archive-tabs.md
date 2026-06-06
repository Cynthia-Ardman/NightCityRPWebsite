---
name: Staff archive character tabs
description: The admin/fixer character archive page reuses the owner tab panel; consequences for owner-only read gates.
---

The staff-only character archive detail page (route guarded by `StaffArchiveGuard` = fixer/admin) renders the SAME full owner tab panel (`CharacterTabsPanel`, exported from `CharacterDetail.tsx`) that the owner sees, with `staffView` enabled.

**Rule:** any NEW owner-only character READ endpoint that a tab consumes must be widened from `loadOwnedChar` to `loadOwnedOrStaffChar` (staff = ADMIN||FIXER), or that tab silently 404s for staff on the archive page.

**Why:** `CharacterTabsPanel` is self-contained — each tab fetches its own data by characterId. The panel itself calls `useGetCharacter`, and tabs call inventory/housing/breach/updates/wallet endpoints. The owner page works because the viewer IS the owner; the archive page only works because those reads accept staff.

**Missions caveat:** there is NO per-character staff missions endpoint. `MissionsTab` `staffView` falls back to the manager-gated `/missions/owned` (all missions, admins see everything) and filters client-side by `characterId`. Owner view still uses `/missions/mine`. Both hooks are always called (React rules) with `enabled` toggles + explicit queryKeys.

**Wallet caveat:** `/characters/:id/wallet/transactions` account-level OR branch must key off the loaded char's `ownerId` (nullable → `sql\`false\``), NOT `req.user.id`, or a staff viewer would see their own ledger mixed in.
