---
name: Cyberware tab hook-order crash (React #310)
description: Why a data-changed character crashes the Cyberware tab with a Rules-of-Hooks violation, and the invariant to keep.
---

CyberwareTab (CharacterDetail.tsx) calls several query hooks, then has early
returns for the loading guard (`charLoading || itemsLoading`) and `!char`. Any
hook placed BELOW those returns runs only after data loads, so the hook count
differs between the first (loading) render and the post-load render → React
error #310 ("rendered more hooks than during the previous render").

**Why:** the crash is data-dependent and "works after Retry + navigate-back"
because by then the queries are cached → no loading render → hook count stays
consistent. Looks like bad cyberware data but it is purely render-order.

**How to apply:** every hook (useListCyberware, etc.) in CyberwareTab — and any
tab component with a loading/null early return — must sit ABOVE the early
returns with the other top-level hooks. Keep rules-of-hooks lint strict.
