---
name: Nullable ownerId guards
description: Required guards now that characters.ownerId is nullable
---

Rule: any code path that joins users on `characters.ownerId`, or that
triggers an UnbelievaBoat wallet write keyed off the character's owner,
must explicitly handle `ownerId === null` (unclaimed character). For wallet
transfers specifically, refuse the transfer with 4xx **before** the sender
is debited.

**Why:** `characters.ownerId` is now nullable (legacy/retired sheets are
imported without a current Discord owner). Drizzle's `eq(users.id, null)`
is invalid (TS rejects), and even when filtered out at the query level the
business logic still needs to skip / refuse cleanly. The transfer path
previously debited the sender via UB and then no-op'd the credit when
recipient owner was null — burning eddies and writing an orphan
`transfer_in` ledger row.

**How to apply:**
- Cron jobs (rent, cyberware): `if (!c.ownerId) continue;` before joining
  users / patching UB.
- Wallet adjust / transfer / any UB write keyed by character owner:
  return 4xx before any UB debit when owner is missing.
- Public/admin character projections must explicitly include
  `claimed` and an optional `ownerName` join so the UI can show
  "UNCLAIMED" vs "@user".
