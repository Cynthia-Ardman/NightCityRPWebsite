---
name: VRChat group-instances API limitation
description: What the VRChat group instances endpoint returns and how the live browser polls it
---

The live instance browser polls the NCRP VRChat **group** instances endpoint
(group id defaults to `grp_667e7e40-7ea9-4142-a81e-5939c18c990f`, overridable via
`VRCHAT_GROUP_ID`).

**Limitation:** that endpoint only returns instances created as **group**
instances. Non-group invite+/friends+/private instances a member spins up will
NOT appear, even if NCRP members are inside. Treat the browser as "open group
instances", not "everywhere NCRP players are". Don't try to "fix" missing
instances by widening the query — there is no group API that returns them.

**Why:** avoids a future agent burning time hunting for a non-existent
"all instances" endpoint when a player reports their private room isn't listed.

**How to apply:** polling lives in `vrchatInstances.pollGroupInstances` (upsert
preserving `firstSeenAt` as an uptime proxy, prune closed via `notInArray`),
served from cache by `GET /vrchat/instances`. The cron is deployment-gated
(`REPLIT_DEPLOYMENT`/`ALLOW_EXTERNAL_WRITES`) + `vrchatCredsConfigured()`, so dev
serves whatever prod last cached. Never log auth cookies/creds.
