---
name: VRChat agent command queue
description: How the portal↔local-Python-agent command queue for the CyberPsycho feature is authed and claimed safely.
---

# VRChat CyberPsycho agent queue

Hybrid model: portal is a shared admin/fixer control panel; each staffer runs a local Python agent
that does VRChat blocking against their OWN account, polling the portal for commands. Tables:
`vrchat_agents` (per-user: tokenHash, label, lastSeenAt, status jsonb, revokedAt) and
`vrchat_agent_commands` (kind, params, status pending/claimed/done/error, result, error, claimedAt, completedAt).

## Agent auth (lib/vrchatAgent.ts)
- Bearer token: high-entropy randomBytes hex, only the **sha256 hash** stored at rest. `requireAgent`
  middleware validates the hash against a non-revoked `vrchat_agents` row and scopes to `req.agentUserId`.
- Download endpoint is **POST not GET** so a link-prefetch can't rotate a working token. Revoke nulls the
  hash + sets revokedAt.
- The agent-facing `POST /vrchat/agent/poll` is mounted inside the GATED router. This is safe because
  `requireVerified`/`requireSiteAccess` no-op when `req.user` is absent (they only act on a logged-in user),
  so agent (session-less, bearer-only) requests fall through to `requireAgent`.

## Claim correctness (the load-bearing rule)
**Claim must be a single atomic guarded `UPDATE ... RETURNING`, never select-then-update.**

**Why:** a select-then-update (select claimable rows, then `UPDATE ... WHERE id IN (...)`) has a race: two
concurrent polls hand out the same command, and the blind id-only UPDATE can regress a newer status back to
'claimed'. Use:
`UPDATE vrchat_agent_commands SET status='claimed', claimedAt=now() WHERE userId=? AND (status='pending' OR (status='claimed' AND claimedAt < staleBefore)) RETURNING *`.
Under READ COMMITTED Postgres re-evaluates the predicate against the freshly-committed row, so a row another
poll just claimed won't be re-won. Sort the returned rows by id in JS for delivery order.

**How to apply:** also guard result writes with `status='claimed'` (plus id+userId) so a late/duplicate runner
report can't overwrite a terminal done/error row. Process results BEFORE claiming in the same poll handler, or
a just-finished row could be immediately self-reclaimed. Stale-claim recovery window is COMMAND_CLAIM_STALE_MS
(120s); agent online window AGENT_ONLINE_WINDOW_MS (30s).

## Agent script shipping
Agent .py + launchers + README ship as TS string constants because the api-server build bundles ONLY .ts
source (non-TS files never reach dist) — never add the agent as a loose .py/.txt file expecting it at runtime.
Per-staffer secrets (base URL + token) are baked into placeholder strings at download time, not stored in the
file at rest. The download is a zip built by a tiny in-house writer (no zip dependency) since the bundle is a
few small text files; the staff endpoint stays out of the orval/OpenAPI spec on purpose (binary body) and the
portal fetches it with raw `fetch({method:"POST", credentials:"include"})` → blob save.
