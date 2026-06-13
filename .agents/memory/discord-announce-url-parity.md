---
name: Discord announce/backfill URL parity
description: Backfilled Discord posts must build deep-link URLs the same way as the live announce path.
---

Outbound Discord posts that deep-link back to the portal must build the base URL the
SAME way in the live announce path and in any backfill script, or the two drift.

**Rule:** base = `(PUBLIC_BASE_URL ?? REPLIT_DOMAINS?.split(",")[0] ?? "")` with the
`https?://` prefix stripped, then `https://${base}${path}`; fall back to the relative
path only when base is empty.

**Why:** the misc-request backfill once used only `PUBLIC_BASE_URL`. When that env is
absent but `REPLIT_DOMAINS` is set, the backfill emitted a RELATIVE `/requests?focus=<id>`
— non-clickable in Discord — while live announce produced an absolute URL. Format
mismatch between live and backfilled posts.

**How to apply:** when adding/altering a deep-link field in either `routes/requests.ts
announceRequest` or `scripts/src/backfill-ticket-threads.ts`, change both in lockstep and
keep the env fallback identical. The portal reads `?focus=<id>` to land on the Misc tab and
expand/scroll to `review-request-<id>`.
