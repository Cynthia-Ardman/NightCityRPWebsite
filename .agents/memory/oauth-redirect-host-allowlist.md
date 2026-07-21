---
name: OAuth redirect host allowlist
description: Discord OAuth must round-trip on the SAME host the user browses; allowlisted host echo, not pinned PUBLIC_BASE_URL
---

The OAuth state nonce lives in a host-scoped session cookie. Pinning redirect_uri to PUBLIC_BASE_URL breaks login for users browsing on any OTHER production host (www variant, replit.app domain): the callback lands on a host without the cookie → state mismatch → /login/error?reason=state ("kicked off at Discord authorize").

**Rule:** in deployments, `getRedirectUri(req.hostname)` echoes the request host only when allowlisted (PUBLIC_BASE_URL host + www variant + REPLIT_DOMAINS); otherwise falls back to pinned. `buildAuthUrl` and `exchangeCode` must use the SAME host (Discord requires exact redirect_uri match between authorize and token calls).

**Why:** Host header is client-controlled — echoing arbitrary hosts is an open redirect; but forcing one canonical host breaks every alternate domain, incl. users whose ISP DNS can't resolve the custom domain (they use the replit.app URL).

**How to apply:** any new production domain must be added BOTH to the allowlist inputs and as a redirect URI on the Discord application (OAuth2 → Redirects), or that host fails with invalid_grant.
