---
name: Drizzle sql`= ANY(${arr})` spreads, doesn't pass an array
description: Drizzle's sql template expands JS arrays into N positional params, which breaks Postgres ANY(). Use inArray() instead.
---

When you write `sql\`${col} = ANY(${jsArray})\`` in Drizzle, the template
expands `jsArray` into `$1, $2, ..., $N` separate positional parameters
rather than binding the array to a single `int[]` / `text[]` parameter.
Postgres then reads `= ANY($1, $2, $3)` as `ANY` called with multiple
scalar args, which is a syntax error — the whole endpoint 500s the
moment the user has more than one matching row.

**Why:** A round of dashboard 500s in prod (`/dashboard/summary`,
`/dashboard/upcoming-bills`, `/me/system-log`) traced back to this
exact pattern. The empty "no upcoming bills" the user reported was
actually the endpoint failing, not a real empty.

**How to apply:**
- For IN-list filters on a Drizzle column, always use `inArray(col, jsArray)`
  from `drizzle-orm`. That's what binds to a single array param.
- Reach for `sql\`...\`` only for things `inArray` can't express; if
  you must, bind the array via `sql\`ANY(${sql.placeholder('ids')}::int[])\``
  or pass it through a parameterized cast — never let a bare
  `${jsArray}` sit inside an `ANY(...)`.
- Whenever you touch an endpoint that filters by `myChars.map(c => c.id)`
  or similar, grep the file for `= ANY(\${` before shipping — these bugs
  are silent until a user has 2+ characters/rows.
