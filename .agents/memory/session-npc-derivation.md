---
name: Session events always need NPCs
description: needsNpcs for events is derived (manual flag OR eventType==="session"); the view serializer and the signup gate must stay in sync.
---

Main Sessions (`events.event_type === "session"`) always need NPCs. `needsNpcs`
is therefore DERIVED, not just the stored column: `eventNeedsNpcs(e) = e.needsNpcs || e.eventType === "session"`
lives in `api-server/src/lib/eventsService.ts` and is the single source of truth.

**Why:** A non-session event can still opt in via the stored `needs_npcs` flag, so the
derivation is `OR`, never a replacement. The flag and the derived value diverge
if any consumer reads the raw column directly.

**How to apply:** Any path that exposes or enforces NPC availability must call
`eventNeedsNpcs(e)`, NOT `e.needsNpcs`. Currently used in `toView` (the serialized
`needsNpcs` field that the portal reads) and in the `signUpAsEventNpc` gate. If you
add a new server gate or a new view field, route it through `eventNeedsNpcs` or the
UI (calendar chips, dashboard NPC card/banner) and the backend will silently
disagree about which sessions accept NPC signups.
