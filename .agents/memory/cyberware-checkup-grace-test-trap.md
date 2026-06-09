---
name: Cyberware checkup grace-window test trap
description: Why meds-charge/DM tests must backdate createdAt, or they pass vacuously.
---

A character's `createdAt` counts as an implicit first ripperdoc checkup, so a
brand-new chromed PC sits inside a ~7-day grace window and the `cyberware_humanity`
billing job **skips it entirely** (no debit attempted).

**Why this is a trap:** any test that asserts meds-charge behavior — a successful
charge, a DM, OR the debit-failure/no-DM branch — will pass *vacuously* if the
character is fresh, because nothing is ever charged. The test goes green for the
wrong reason and stops catching regressions.

**How to apply:** in such tests, age the character past the window first
(`update characters set createdAt = now() - 30d`) AND, for the failure-branch
test, additionally assert the debit was actually attempted
(`expect(mockPatch).toHaveBeenCalled()`) before asserting "no ledger row / no DM".
Helper `backdateCreation()` lives in `jobs-autobill.test.ts` and
`jobs-notifications.test.ts`. This bit three tests across those two files plus one
more the architect caught.
