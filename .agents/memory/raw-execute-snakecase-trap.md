---
name: Raw tx.execute snake_case cast trap
description: Why casting a raw SELECT * result to a Drizzle $inferSelect type silently breaks camelCase columns
---

`tx.execute(sql\`SELECT * FROM <table> WHERE ...\`)` returns rows keyed by the
**actual DB column names** (snake_case, e.g. `character_id`, `requested_by_id`).
Casting that row `as typeof table.$inferSelect` fools TypeScript into thinking the
fields are camelCase, but at runtime `row.characterId` / `row.requestedById` are
`undefined`. Downstream lookups like `eq(characters.id, row.characterId)` then
match nothing and the handler fails in a confusing, type-clean way.

**Why:** the approve handler in `requests.ts` used this pattern only to take a
`FOR UPDATE` lock, then read `reqRow.characterId`/`reqRow.requestedById` — every
approve (property/gun/cyberware/store/ripperdoc) 400'd with "Character is missing"
because those fields were undefined. Reject was unaffected because it only reads
`.status` (no underscore).

**How to apply:** to lock-and-read a typed row, prefer
`tx.select().from(table).where(eq(table.id, id)).for("update")` — it locks AND
returns a camelCase-mapped row. Only use raw `sql\`SELECT * ... FOR UPDATE\`` when
you don't read snake_case columns off the result (e.g. a pure existence/lock
check), and never cast a raw result to `$inferSelect`.
