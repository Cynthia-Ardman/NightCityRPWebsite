---
name: On-map building reservation
description: How venue (store/ripperdoc) requests reserve a catalog_rent building and the race-safety contract.
---

On-map venue requests reserve a `catalog_rent` business building so two players can't claim the same one.

- Reservation is `custom_requests.reserved_listing_id` + a PARTIAL unique index over `status IN ('pending','approved')` (live set). There is NO explicit "clear reservation" step: a reservation auto-releases the moment the row's status leaves the live set (rejected/cancelled/closed). The partial index is the final guard.
- Availability is the UNION of two exclusions: existing `housing` leases on the listing AND live reservations (`lib/listingReservations.ts: loadReservedListingIds / isListingReserved`). Every surface that offers or leases a building must apply BOTH: `/catalog/rent` occupancy, `/catalog/rent/available-business`, self-lease, housing-request submit + approve, and the on-map request submit.

**Why:** A pure pre-check (read lease+reservation, then insert) races a concurrent `/housing/lease`. The lease can land between the on-map submit's check and its insert — no double-lease (close re-checks under FOR UPDATE), but the request gets stranded "approved" against an occupied building until staff reject it.

**How to apply:** On-map submit locks the `catalog_rent` row `FOR UPDATE` inside a tx, re-checks lease + reservation under the lock, then inserts with `onConflictDoNothing` on the partial index. Materialization (close) repeats the FOR UPDATE lock + lease re-check before creating the business lease and pinning the venue location. appliedRef stays `store:`/`ripperdoc:` (the lease is a side-effect, reopen-safe).


## Former index detail (full)
venue requests reserve a catalog_rent building via reserved_listing_id + partial-unique index over live statuses; no explicit clear (auto-release on status exit); lock the row FOR UPDATE on submit AND close, exclude leased+reserved on every offer/lease surface.
