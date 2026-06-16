---
name: VRChat instance allowed-roles
description: How the live-instance "allowed group roles" feature resolves and exposes role names, and the contract that keeps opaque IDs out.
---

VRChat's group-instance object carries `roleIds: string[]` — the group roles
allowed to join — but ONLY for instances created with the "Group Roles"
restriction (open public/plus instances leave it empty/absent). For NCRP nearly
every instance is role-restricted, so this is almost always present.

Role IDs are opaque (`grol_…`). Resolve them to display names via
`GET /groups/{groupId}/roles` (id→name map).

**Decisions / rules:**
- Resolve names at POLL time and STORE them (`vrchat_instances.role_names`,
  alongside raw `role_ids`). The read path (`getCachedInstances`) must NEVER hit
  the rate-limited VRChat API.
- Cache the role map in-memory (30-min TTL) and make the fetch best-effort: on
  failure return the last-good cache (or empty), never throw — a role-fetch
  failure must not break the whole instance poll.
- `roleNames` is a STRICTLY human-readable field. Unresolved IDs are DROPPED, not
  echoed back. **Why:** a `?? id` fallback leaks `grol_…` IDs into the UI and
  violates the schema contract. `roleIds` stays the canonical raw field for
  debug/future use. **How to apply:** keep `resolveRoleNames` filtering out
  misses; if you ever add another consumer, resolve through the same helper.
- In practice the in-memory cache returning last-good on failure means a totally
  empty map only happens on a cold-start fetch failure, so clobbering good names
  with empties is a non-issue — no need for per-row "preserve previous" logic.
