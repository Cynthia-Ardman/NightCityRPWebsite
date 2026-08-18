---
name: Drizzle dynamic insert keys
description: Column.name is the SQL name, not the TS property — dynamic values() keys silently insert defaults.
---

In a dynamic Drizzle `.insert(table).values({ [col.name]: v })`, `col.name`
returns the SQL column name (`store_id`), not the TS property (`storeId`).
Drizzle ignores unknown keys, so the value is silently dropped and the column
gets its default — surfacing only as a NOT NULL violation (or worse, a wrong
default) at runtime.

**How to apply:** never key `values()` off `column.name`; use a helper that
returns the TS property name (e.g. `venueColName(kind): "storeId" | "ripperdocId"`).
This bug existed in both stock_add and player_sell stock inserts.
