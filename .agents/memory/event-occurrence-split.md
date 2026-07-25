---
name: Recurring event occurrence split
description: How "edit just this occurrence" works — excludedOccurrences + standalone child event, and the surfaces that must honor exclusions
---
Editing one occurrence of a recurring event SPLITS it: a standalone child event row is created (patched copy, no recurrence/Discord/VRChat linkage) and the occurrence instant is appended to parent `events.excludedOccurrences` (jsonb string[]).

**Why:** Discord has no per-occurrence exception API, so the parent Discord event still shows the original occurrence — accepted limitation. The child gets its own row so signups/payments can diverge.

**How to apply:**
- Every occurrence-expansion consumer must filter excluded instants (client `expandOccurrences(exclude)` wrapper; new call sites must use it, not `expandOccurrencesRaw`).
- Parent-side reads/writes at an excluded instant must not act as if it exists: NPC signup 409s, detail deep link falls back to base view. Any NEW per-occurrence surface (tickets, attendance) must add the same exclusion guard.
- Occurrence-scope edits reject ticketTypes entirely (even `[]`) — tiers stay series-level.
- Split repoints existing eventNpcSignups (incl. legacy NULL-occurrence rows when occ == parent startAt) and missionActorPayments to the child.
