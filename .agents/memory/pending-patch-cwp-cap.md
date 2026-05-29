---
name: Pending-sheet PATCH must re-enforce the CWP cap
description: Why in-review sheet edits need their own cyberware-cap check even though submission already validated.
---

When a character sheet can be edited in place while `status === "pending"` (owner
or staff, no re-submit), the PATCH path skips the full `validateSheetForSubmission`
so reviewers can make incremental tweaks. That means the 6-CWP creation cap is NOT
re-checked by submission — so PATCH itself must run `collectCyberware` +
`loadCyberwareCostMap` + `validateCyberware` on the incoming data and 400 on
failure, but ONLY for pending status.

**Why:** Without it, a user/staff can submit a valid sheet, then PATCH custom
cyberware above 6 CWP (or negative) and have it approved without revalidation — a
silent business-rule bypass. Custom (non-catalog) CWP uses the client value, so it
is the attack surface; catalog costs are overridden from the catalog and are safe.

**How to apply:** Keep the pending-PATCH cyberware check in lockstep with
submission validation. Do NOT force full required-field revalidation on PATCH
(it breaks autosave/incremental edits and drafts) — only the cap + non-negative
rule, gated on `status === "pending"`. Drafts/changes_requested stay unvalidated.
