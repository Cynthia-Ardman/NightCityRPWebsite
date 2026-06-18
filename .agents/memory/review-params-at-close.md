---
name: Review mechanical params entered at close, not vote
description: Misc-request approve/override stages decisionParams=null; the closer enters rent/cwp/stock numbers at CLOSE & APPLY, and every materialize branch must re-validate.
---

# Review mechanical params are entered at CLOSE, not at vote/override

In the Misc Requests review queue, voting approve/reject and admin override are
single-click with NO param popup, for every request type. The mechanical numbers
(property monthlyRent/kind, cyberware cwp, venue_stock unitCost/retail/qty) are
NOT collected at vote/override time — both paths stage with `decisionParams=null`.
The closer supplies them at the CLOSE & APPLY step.

**Why:** fixers discuss/agree on the numbers first; collecting them mid-vote
forced a premature popup and let a stale staged number get applied. Deferring to
close keeps voting frictionless and puts the authoritative numbers at the moment
the effect is actually committed.

**How to apply:**
- `closeRequest(req,id,note?,closeParams?)`: when closeParams has any defined
  field, run `normalizeApprovalParams` (validates + clamps to MAX_MONEY) and use
  them in precedence over staged `decisionParams` / legacy `details.approval`.
- `materializeRequest` is the real gate: EVERY param-requiring branch must
  hard-validate and 400 if numbers are missing/invalid — property, cyberware,
  AND venue_stock. A permissive default (e.g. `Number(x)||0`) in any one branch
  is a silent param-bypass that applies an effect with bogus numbers. (venue_stock
  was exactly this gap once — it used `unitCost||0 / retail||0 / qty||1`.)
- Legacy tickets staged before the move still carry `details.approval`; keep it
  as a fallback so old approved rows close correctly.
- Regression contract to keep: closing an approved property/cyberware/venue_stock
  with no params returns 400 and creates no lease/inventory/stock row.
