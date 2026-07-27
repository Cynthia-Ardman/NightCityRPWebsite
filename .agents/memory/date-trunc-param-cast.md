---
name: date_trunc on a bound parameter needs an explicit cast
description: PG error 42725 (ambiguous function) when passing a JS Date/string param into date_trunc in raw SQL.
---

# date_trunc('week', ${param}) is ambiguous without a cast

Passing a JS Date (or ISO string) as a bound parameter into `date_trunc('week', $1)`
in raw `sql` templates fails with PG 42725 "could not choose a best candidate
function" — the param arrives untyped and both `timestamp` and `timestamptz`
overloads match.

**Why:** node-postgres sends Date params as text with unknown type; Postgres
cannot pick an overload.

**How to apply:** always write `date_trunc('week', ${param}::timestamptz)` (or
`::date` when comparing dates) at every raw-SQL site that feeds a parameter into
date_trunc or similar overloaded functions. Column arguments are fine — only
bound parameters need the cast.

Related false-positive to remember: Postgres `LEAST()/GREATEST()` IGNORE NULL
arguments (non-standard) — `LEAST(NULL, x)` = x, NULL only when ALL args are NULL.
