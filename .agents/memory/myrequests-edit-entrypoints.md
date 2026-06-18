---
name: MyRequests edit-button venue field parity
description: The 3 edit entry points in MyRequests must all wire venue purpose/location, or editing silently drops those fields.
---

`MyRequests.tsx` has THREE separate edit entry points that each call
`setEditing({...})`, gated by request status:
- **draft** → "EDIT" (mode `save`)
- **pending** (FIXER_VOTED_TYPES) → "EDIT" (mode `save`)
- **changes_requested** → "EDIT & RESUBMIT" (mode `resubmit`)

Venue-type requests (`customType === "store" || "ripperdoc"`) carry extra
fields — **purpose** and **location** — stored in the request `details` payload.
The edit dialog only renders the Purpose/Location inputs when
`editing.isVenue` is true, and the save handler only sends `purpose`/`location`
when `editing.isVenue`.

**Rule:** every edit entry point that opens the dialog for a venue-type request
MUST set `isVenue` + seed `purpose`/`location` from the row, or the dialog hides
those inputs and the save wipes/omits them. It is easy to add the wiring to one
button (draft) and forget the others (pending, resubmit) — that was the bug:
ripperdoc/store requests showed only Title + Description when edited from the
pending or changes_requested queues.

**Server:** the request update endpoint already merges venue purpose/location
into `details` for `isVenueType` rows regardless of status — this gap is
purely frontend.
