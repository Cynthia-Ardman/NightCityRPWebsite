---
name: Dashboard counts must mirror review-queue semantics
description: Why staff dashboard tallies have to match the actual reviewable queue, not a raw global count.
---

The staff dashboard surfaces "N pending X" cards that link to a review queue. If the
dashboard count is a RAW GLOBAL tally while the queue (and the sidebar unseen-counts)
exclude the viewer's OWN submissions, the dashboard can read "1 pending" with nothing for
the viewer to action — because a reviewer can't vote on their own submission
(canVote = !isOwner).

**Rule:** A dashboard "to-review" count must use the SAME gating as the queue it links to:
reviewer-gated, and excluding the viewer's own rows. Use `ownerId IS DISTINCT FROM viewerId`
(treats null owner as "not me", so unowned rows still surface).

**Why:** The review unseen-counts endpoint already excludes own submissions; a divergent
dashboard count is the outlier that produces the phantom-pending complaint.

**How to apply:** When adding/auditing any dashboard staff tally, check it against the
queue's filter (own-exclusion + role gate). Note the queue LIST itself (e.g. /sheets/pending)
may still include own rows for visibility — that's a separate, lower-severity inconsistency.
