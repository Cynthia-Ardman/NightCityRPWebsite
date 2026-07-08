---
name: CyberPsycho per-user access grant
description: How the CyberPsycho control panel is gated — role OR per-user flag, and which VRChat endpoints the grant deliberately does NOT reach.
---

CyberPsycho (VRChat security agent panel at /fixer/cyberpsycho) is gated on ADMIN/FIXER role **or** the per-user `users.cyberpsycho_access` flag (admin-toggled from the Admin Dashboard user list, audited).

**Why:** the community wanted to hand the tool to specific trusted non-staff members; a website flag survives role_sync (Discord role sweeps would wipe a synthetic role).

**How to apply:**
- Operator endpoints (`/vrchat/status|commands|agent/download|agent/revoke|instances/refresh`) use `requireCyberpsychoOperator` (role OR flag). They are self-scoped to `req.user.id`, so the grant exposes no other staff surface.
- The shared VRChat bot-session endpoints (`/vrchat/session*`) stay role-only (`roleStaffOnly`) — a per-user grant must NEVER extend to the shared account login.
- Frontend gates on `/auth/me` `canCyberpsycho` (route guard + nav link); don't re-derive from roles alone or grant-holders lose the UI.
- Any NEW vrchat operator endpoint must pick the correct gate deliberately: per-operator self-scoped → grant-eligible; shared credentials/config → role-only.
