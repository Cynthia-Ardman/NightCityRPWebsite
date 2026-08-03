---
name: Discord X-Audit-Log-Reason must be URI-encoded
description: Raw non-Latin-1 chars (em-dash) in the audit-log reason header crash fetch with a ByteString TypeError
---

Every Discord REST call that sets `X-Audit-Log-Reason` must pass the reason through `encodeURIComponent` (helper `auditReason()` in api-server discord.ts).

**Why:** fetch/undici validates header values as ByteString (Latin-1). A reason containing an em-dash (U+2014) threw `TypeError: Cannot convert argument to a ByteString because the character at index N has a value of 8212` in prod (2026-08-03), failing role grants. Discord explicitly expects the header URL-encoded and decodes it.

**How to apply:** any NEW Discord write helper that adds this header (or any header built from free-form text) must encode it — never pass user/UI-composed strings raw into headers.
