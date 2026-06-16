---
name: Known pre-existing red api-server tests
description: api-server test files that fail independent of recent work; don't misattribute them to a new PR/regression
---

As of June 2026, two api-server test files fail even in isolation (run them
alone with `vitest run <file>` to confirm), independent of recent merges:

- `src/test/characterCosmeticEdit.test.ts` — 4 "admin character edits auto-apply"
  tests expect 200 + `autoApplied:true`, but get 202/409. STALE: the admin
  instant-apply char-edit path was intentionally removed (all non-cosmetic edits
  now route through review). See memory "Direct-apply supersede". Tests assert
  removed behavior; not a runtime regression.

- `src/routes/missions.test.ts` — 7 tests under describes "Discord scheduled-event
  sync" (5) and "Mission workflow transitions" (2) fail: `approve` returns
  workflowState "posted" instead of "approved", and the submit→approve→post
  helper then 409s on /post (already posted). The mission submit/approve/post
  route + service functions (approveMission/postMission/submitMissionProposal/
  getMissionDetail) have NOT changed in recent PRs, so these are pre-existing.

**Why:** verifying "did this PR break anything" requires separating pre-existing
red tests from genuine regressions. The decisive check is (a) reproduce in
isolation and (b) `git diff <pre-merge-parent> <merge>` on the exercised code +
test — if neither the test nor the code-under-test changed, the merge can't have
caused the failure.

**How to apply:** when a full-suite run shows these files red, confirm they're
unchanged by the work in question before treating them as a regression. Note the
full api-server suite also collapses output under the default reporter and takes
~8 min via the `test` workflow; per-file isolation is faster and cleaner.
