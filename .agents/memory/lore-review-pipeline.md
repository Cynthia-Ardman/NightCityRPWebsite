---
name: Lore review pipeline (vs guidebook)
description: Lore proposals ride the shared majority-vote review pipeline; guidebook stays admin-only and must be gated separately.
---

Player/fixer lore proposals (`lore_pending_edits`) ride the shared majority-vote
review pipeline (subjectType `"lore"`), the SAME one as Misc Requests / Character
Edits / New Characters. Both new-entry (`kind:"create"`) and `kind:"edit"`
proposals use it. `lore_import_drafts`/guidebook deliberately stay on the legacy
admin approve/reject flow.

**Why:** consistency with the rest of review; players/fixers shouldn't need a
lone admin to publish lore.

**How to apply:**
- Voting: eligible voters = CS_APPROVER pool (`isEligibleReviewer`); submitter
  excluded; admin uses `/override` (decision `approve`|`deny`), not vote.
- Effects are DEFERRED to close: vote/override only STAGE approved/rejected.
  `closeLore` calls `applyProposal` to publish ONE `loreEntries` row, idempotent
  via `appliedEntryId` + status guard under FOR UPDATE. Re-close is a no-op.
- `closed` is lore's TERMINAL state (set for BOTH applied-approved and
  closed-after-rejection). `approved`/`rejected` are mid-flight (awaiting close),
  so they render in the ACTIVE lore queue tab, not the Completed/Denied terminal
  tabs. Terminal tabs fetch `status:"closed"`; classify completed-vs-denied by
  `appliedEntryId` presence.
- finalize-on-read: list & detail re-evaluate carried-over votes and finalize
  (audit `lore_auto_finalize_approve`/`_reject`) when the eligible pool shrinks.
- Retired `/edits/:id/approve` and `/reject` now return 410.

**Portal gotchas (PendingRequests.tsx):**
- `canLore` (reviewer pool: fixer/cs-approver/admin) MUST be split from
  `canGuidebook` (admin-only). They were one flag; widening one without the other
  leaks guidebook to fixers or hides lore from them.
- Lore `voters` serialize with the SAME inline shape as requests/sheets/edits:
  `{ id: <userId string>, name, avatarUrl, vote }`. OpenAPI must inline this
  object (do NOT `$ref` ReviewVoteRecord — that types `id` as a vote-row int and
  adds `voterId`, drifting from the runtime). Portal maps `v.id` (NOT voterId);
  there is no lore exception.
- Lore now has seen-tracking like the other queues, so the LORE tab badge reads
  `unseen.lore`, not a raw pending count.
- Lore has NO Discord thread (`resolveThreadId` lore→null); don't mount
  DiscordThreadDrawer — ReviewQueueCard's built-in comment thread is enough.
