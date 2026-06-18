---
name: Custom-request drafts (status='draft')
description: How player drafts of custom requests behave across create/submit/edit/delete and the venue-resume trap.
---

# Custom-request drafts

`custom_requests.status` is plain TEXT, so `draft` needs no migration. Draft rows
hold NO venue reservation (the partial unique reservation index excludes
non-pending/approved), and are excluded from the staff queue + review tallies
because those default to `status='pending'`.

Flow: POST /requests `asDraft:true` → status='draft' (skip announce, skip venue
required-field gates). POST /requests/:id/submit (owner+admin) re-validates venue
content **from the stored row**, re-reserves the on-map building under FOR UPDATE,
then flips draft→pending + announces (409 if not a draft). PATCH /requests/:id
allows editing drafts. DELETE /requests/:id is draft-only (409 non-draft, 403
non-owner).

## Venue-draft resume trap
**Rule:** the MyRequests draft editor MUST expose `purpose` + `location` for
venue types (store/ripperdoc), not just title/description.

**Why:** submit re-validates venue required fields (purpose, description, and
location-or-listing) from the stored row. A venue draft can be saved with only
character+name, so if the editor can only change title/description the draft is
permanently stuck — submit 400s and there's no UI to add the missing fields.

**How to apply:** PATCH already merges `purpose`/`location` into `details` for
`isVenueType` rows. The frontend (`MyRequests.tsx` edit dialog) must surface
those inputs for venue drafts and send them in the PATCH `data`.

## Authz note
submit + delete allow the requester OR admin, matching the existing PATCH /
resubmit convention (admins act on behalf). Intentional, not owner-strict.
