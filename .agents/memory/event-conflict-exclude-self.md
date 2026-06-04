---
name: Event/mission conflict-check excludes self on edit
description: A create/edit form that surfaces overlapping events must pass excludeEventId in edit mode or the row flags itself.
---

Any "overlapping event/mission" warning that calls the conflicts endpoint
(`useCheckEventConflicts` / `useCheckMissionConflicts`) MUST pass
`excludeEventId` (string) when editing an existing row.

**Why:** the conflicts query takes a time window; the row being edited still
lives in that window, so without excluding it the form persistently flags the
event as overlapping itself — a false positive that defeats the decision-support
purpose. The OpenAPI param exists specifically for this case.

**How to apply:** build the conflict params as
`{ startAt, endAt, ...(editing ? { excludeEventId: String(id) } : {}) }`, and
feed the SAME object to both the query key and the request. Also only compute
the ISO conversion when the parsed dates are valid (guard `Number.isNaN(getTime())`)
— `datetime-local` can hold partial/invalid strings mid-typing, and an
unconditional `.toISOString()` on an Invalid Date throws.
