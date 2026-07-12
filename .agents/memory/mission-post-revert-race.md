---
name: Opposing transition race (post vs revert-to-draft)
description: Two opposing workflow transitions with external side effects must persist results conditionally on the claimed state and tear down on a lost race.
---

The rule: when two opposing transitions (e.g. mission post ↔ revert-to-draft) each do an atomic conditional claim and then an external side effect (Discord event create/delete), the atomic claim alone is NOT enough:

1. The forward path (post) must persist its side-effect result (discordEventId) with a conditional UPDATE `WHERE workflowState='posted'`; if 0 rows, it lost the race — delete the event it just created (live-gated) and return 409.
2. The reverse path (revert) must RE-READ the row after its claim before syncing — the pre-claim snapshot may have a stale/NULL discordEventId written by the in-flight forward path, causing teardown to be skipped.
3. The reverse path's persist is also conditional (`WHERE workflowState='draft'`) so it never clobbers an id written after the mission raced forward again.

**Why:** architect review caught that post-in-flight + concurrent revert could leave a draft mission owning a live Discord scheduled event (drafts must never own one).

**How to apply:** any new pair of opposing transitions with external effects (events, threads, payouts) — copy this pattern: claim → effect → conditional persist → compensate on lost persist. Test by mocking the external call to run the opposing transition inside it.
