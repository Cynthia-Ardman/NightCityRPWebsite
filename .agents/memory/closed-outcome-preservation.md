---
name: closed_outcome on archived review rows
description: Closing a review ticket must preserve the resolved outcome; how the closed_outcome column works across all three review tables.
---

All three review tables (custom_requests, character_sheets, pending_character_edits) overwrite `status` with "closed" at archive time, which used to lose whether the ticket was approved/rejected/cancelled — players saw only a generic CLOSED badge on /submissions.

**Rule:** every close path must set `closed_outcome` = the pre-close status; every reopen path must clear it to NULL. The UI (RequestStatusBadge `closedOutcome` prop) renders APPROVED/REJECTED/WITHDRAWN for closed rows and falls back to CLOSED when null (legacy unrecoverable rows).

**Why:** close is a separate archive step (staged-review-effects), so the decision status is transient; once overwritten, the outcome is only forensically recoverable via applied_ref/audit_log messages — and the sheets archive-branch audit historically logged the POST-close status "(closed)", making it useless (now fixed to log prevStatus).

**How to apply:** any NEW close/reopen path (or new review subject type) must write/clear `closed_outcome` too. Serializer note: requests shape() has a legacy fallback (closed + applied_ref => approved); sheets responses spread the whole row so new columns flow automatically; pending-edits list AND detail serializers each list fields explicitly. Backfill script: artifacts/api-server/scripts/backfill-closed-outcome.ts (idempotent, conservative — ambiguous rows stay NULL).
