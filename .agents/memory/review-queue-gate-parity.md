---
name: Review queue gate parity
description: All three review queues must gate reads on the same reviewer predicate
---

The three staff review queues (Misc Requests, New Characters/sheets, Character
Edits) must gate their LIST/DETAIL reads on `isReviewer` (FIXER / CS_APPROVER /
ADMIN), the standard staff-access predicate. Voting stays on
`isEligibleReviewer` (FIXER / CS_APPROVER, admins excluded — they override).

**Why:** the `/requests` list once gated on a bespoke FIXER/ADMIN-only check
(`isFixerOrAdmin`), excluding CS_APPROVERs — yet CS_APPROVER IS an eligible
requests voter and IS counted in the majority threshold denominator. That
locked them out of the queue entirely (couldn't see tickets they could vote on)
and, once finalize-on-read landed, prevented them from triggering it. sheets and
pending-edits were already correctly on `isReviewer`.

**How to apply:** when adding/auditing a review-queue read endpoint, gate on
`isReviewer`, not a hand-rolled role tuple. If a role is in the eligible-voter
pool for a subject type, it MUST be able to read that subject's queue.

Note: role strings are matched via `hasRole` against `ROLE_NAMES` (lib/discord)
case-insensitively; CS_APPROVER's canonical names are `"cs approver"`,
`"character approver"`, `"cs-approver"` — NOT `"cs_approver"`. Tests seeding a
CS_APPROVER must use one of the canonical strings.


## Former index detail (full)
all 3 review queues gate reads on isReviewer (FIXER/CS_APPROVER/ADMIN) or eligible CS_APPROVER voters get locked out + finalize-on-read strands; decisions evaluated only at vote-cast, so a shrinking eligible pool drops majorityOf below cast approvals — re-evaluate+finalize (locked, idempotent) on reviewer reads ([stale-pool](stale-pool-finalize-on-read.md)).
