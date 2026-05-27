---
name: react-query auth gate refetch loop
description: Why a root-level useQuery on /auth/me can cause a perpetual mount/unmount refetch loop, and the QueryClient defaults that prevent it.
---

When a root component gates the entire app tree on `useQuery(authMe).isLoading` and the response is an error (e.g. 401 for an unauthenticated visitor), the gate flips loading→false and the rest of the app mounts. Child components that also call `useQuery(authMe)` subscribe as new observers. For an *errored* query, react-query's `retryOnMount` (default **true**) triggers a fresh fetch on each new observer subscription. That refetch flips `isLoading` back to true, the gate unmounts the tree, observers leave, fetch returns 401, and the cycle repeats at roughly 1Hz.

**Why:** `retryOnMount` is a separate flag from `retry` and `refetchOnMount`. `retry:false` only suppresses retries within a single fetch. `refetchOnMount:false` suppresses re-fetching for stale data. Neither prevents an errored query from re-running when a new observer subscribes — only `retryOnMount:false` does.

**How to apply:** When the QueryClient backs an auth/identity query used both at a root gate and in many child components, set on `defaultOptions.queries`:
- `retry: false`
- `retryOnMount: false`
- `refetchOnMount: false`
- `refetchOnWindowFocus: false`
- `staleTime` > 0 (e.g. 30s)

Also prefer NOT to gate the whole app tree on a single `isLoading`; render a shell that can show "logged out" UI immediately on error instead of unmounting everything.

Diagnostic signature: in console, `error` and `pending` log lines appear at the **same millisecond**, fetch stack traces all originate from react-query's `run`/`fetchFn`, and the network tab shows a perfectly periodic 1Hz request to the auth endpoint with no user action.
