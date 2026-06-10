---
name: Portal vitest fragile mocks
description: Why some ncrp-portal component tests fail with "No <hook> export is defined" independent of your change.
---
Several ncrp-portal component tests (EditCharacterDialog.test.tsx, CharacterDetail.test.tsx, and CyberwareEditor via those pages) mock `@workspace/api-client-react` with a manual `vi.mock` factory that enumerates only a subset of hooks. When the component under test calls a hook the factory does not list (e.g. `useGetCharacterInventory`, `useListCyberware`), vitest throws `[vitest] No "<hook>" export is defined on the "@workspace/api-client-react"`. CharacterDetail also has a nested-`<a>` hydration warning from a wouter `<Link>` wrapping an anchor.

**Why:** these are test-infra brittleness, not product bugs; the real exports exist in the generated client. They fail in the full `test` workflow regardless of unrelated feature work.

**How to apply:** if the `test` workflow shows these failures after an unrelated change, confirm via `git diff --name-only origin/main..HEAD` that you did not touch the failing test files/components, and that the generated client diff is additive (no export removals — enum "deletions" that re-add the same enum plus a new value are additive) — then treat them as pre-existing and skip validation with that reason. Only fix by switching the offending tests to `importOriginal()`-spread mocks if asked.

**Broader pre-existing set seen during validation (~21 portal failures):** beyond EditCharacterDialog.test (~12, "No useGetMe/useListGuns") and CharacterDetail.test (~3, incl. a Radix react-presence/compose-refs "Maximum update depth exceeded" ref loop that mock additions can't fix), these also fail independently and are NOT regressions when their files are absent from your diff: Missions.test ("tab-history" testid not found), breach/BreachPractice.test (fetchSpy called 1x), sheets/SheetDetailDecide.test (overrideMutate id:7). The "Maximum update depth" is a Radix/jsdom test-env artifact, not your logic.
