---
name: users.roles stores lowercase Discord role names
description: How role membership is stored and how to query it in SQL
---
`users.roles` contains LOWERCASE Discord role names (plus synthetic id-derived markers like `trial-fixer`), NOT the uppercase group keys (`FIXER`, `ADMIN`, ...). Those keys exist only in `ROLE_NAMES` in api-server `lib/discord.ts`, each mapping to several accepted names (e.g. FIXER = ["fixer","coordinator"]).

**Why:** A SQL filter like `'FIXER' = ANY(roles)` silently matches nothing — shipped once as an empty "Fixer Activity" report.

**How to apply:** In JS use `hasRole(roles, "GROUP")`. In SQL use `arrayOverlaps(users.roles, [...ROLE_NAMES.GROUP])` (or `roles && array[...]`), never the group key literal.
