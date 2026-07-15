---
name: Listing leasable gate spans 4 API paths
description: catalog_rent.leasable=false must be enforced at every lease/request surface, not just one
---

`catalog_rent.leasable` (false = catalog-visible but never rentable, e.g. Claw-owned properties) is a multi-surface gate. Any new path that creates a lease or reserves a building must check it.

**Why:** the on-map venue flow has four independent entry points into a lease — direct lease (POST /housing/lease), on-map venue request create (POST /requests), draft submit (POST /requests/:id/submit, under the FOR UPDATE lock), and the approval materializer (materializeRequest on_map branch). Gating only one leaves a bypass, same pattern as the cyberware review-enforcement surfaces.

**How to apply:** when adding lease/reservation paths, re-check `leasable` under the same lock used for the lease/reservation race guard; also keep `/catalog/rent/available-business` filtering it out and the portal badge (`leasable === false` → no LEASE/APPLY button).
