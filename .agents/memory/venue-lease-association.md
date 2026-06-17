---
name: Venue ↔ lease association
description: Staff link a store/ripperdoc to a business housing lease via PATCH housingId
---
Stores and ripperdocs each have a nullable `housingId` FK → housing.id (set null on delete).

Staff-only association: PATCH /stores/:id and /ripperdocs/:id accept `housingId`, but the
field is appended to the allowed set ONLY for staff. A non-staff owner PATCHing housingId is
NOT a 403 — the field is silently stripped (their PATCH of other fields still 200s), so guard
tests must assert the column stayed null, not expect 403.

resolveLeaseAssociation() validates the target housing row is kind='business' (else 400
"Not a valid business lease") and pins venue.location to the lease address unless the same
PATCH also sets location. null housingId clears the association and leaves location intact.

GET /business-leases (staff-only, 403 for players) lists all kind='business' leases for the
selector. Both GET and PATCH responses include a computed `lease` field (loadVenueLease join
of housing+characters+catalogRent) — PATCH must return it on BOTH the no-op empty-patch branch
AND the updated branch for response/GET parity.

On-map venue approval (requests.ts materialize) also sets housingId so map-approved venues are
pre-associated.
