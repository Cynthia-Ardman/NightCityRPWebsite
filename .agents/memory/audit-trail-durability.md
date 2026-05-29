---
name: recordAudit is fire-and-forget; guaranteed audit needs an inline tx
description: When an endpoint MUST leave an audit/changelog trail, don't use recordAudit() — write the rows inline within a DB transaction.
---

`recordAudit()` in `artifacts/api-server/src/lib/audit.ts` is deliberately
fire-and-forget: it wraps its `auditLog` insert in try/catch and only
`console.error`s on failure. That's correct for the common case (an audit
hiccup must never break the request it decorates), but it means **a mutation
can succeed with no audit row**.

**Why:** The Character Archive spec required *every* staff edit to be
traceable (audit_log + character_updates). Using recordAudit + separate
inserts left two holes: a swallowed audit failure, and no transaction across
the character UPDATE + audit insert + changelog insert (partial-write states).

**How to apply:**
- For any endpoint where the audit/changelog trail is a hard requirement,
  wrap the row mutation + `auditLog` insert + changelog insert in
  `db.transaction(async (tx) => { ... })` and do the inserts with `tx` so any
  failure rolls the whole thing back. Replicate recordAudit's IP/UA derivation
  inline (x-forwarded-for first element, fallback req.ip; user-agent sliced 500).
- Keep genuinely non-critical side effects (e.g. `activityEvents` social feed)
  OUTSIDE the transaction in a try/catch, so a feed hiccup never rolls back a
  valid, fully-audited edit.
- Plain `recordAudit()` remains fine for best-effort logging on endpoints where
  a missing audit row is tolerable.
