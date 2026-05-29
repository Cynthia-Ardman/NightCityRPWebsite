---
name: Archive tag storage split
description: Why character tags live in two columns (appliedTags vs manualTags) and how they must be read/written.
---

The archive shows ONE merged tag list, but storage is intentionally split across
two columns on `characters`:
- `appliedTags` — owned by the Discord importer; OVERWRITTEN on every re-sync.
- `manualTags`  — owned by staff via the archive UI; the importer never touches it.

**Why:** A single tag column would let an importer re-sync silently wipe any tag a
staff member added by hand (the character no longer "has" it on Discord). Splitting
storage protects manual tags while still presenting/​filtering as one list.

**How to apply:**
- Display + filter = the case-insensitive UNION of both columns (a `mergeTags`
  helper; tag filters must overlap EITHER column, which equals overlapping the union).
- Distinct-tag endpoints must `unnest(applied_tags || manual_tags)`.
- On an edit the client sends the FULL desired merged set; the server splits it back:
  tags already present in `appliedTags` stay there, everything else becomes a manual
  tag. Removing a Discord-origin tag only suppresses it until the next import
  re-derives `appliedTags`.
