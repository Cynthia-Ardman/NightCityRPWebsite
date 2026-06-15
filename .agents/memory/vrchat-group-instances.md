---
name: VRChat group-instances API limitation
description: What the VRChat group instances endpoint returns and how the live browser polls it
---

The live instance browser polls the NCRP VRChat **group** instances endpoint
(group id defaults to `grp_667e7e40-7ea9-4142-a81e-5939c18c990f`, overridable via
`VRCHAT_GROUP_ID`).

**Limitation:** that endpoint only returns instances created as **group**
instances. Non-group invite+/friends+/private instances a member spins up will
NOT appear, even if NCRP members are inside. Treat the browser as "open group
instances", not "everywhere NCRP players are". Don't try to "fix" missing
instances by widening the query — there is no group API that returns them.

**Why:** avoids a future agent burning time hunting for a non-existent
"all instances" endpoint when a player reports their private room isn't listed.

**How to apply:** polling lives in `vrchatInstances.pollGroupInstances` (upsert
preserving `firstSeenAt` as an uptime proxy, prune closed via `notInArray`),
served from cache by `GET /vrchat/instances`. The cron is deployment-gated
(`REPLIT_DEPLOYMENT`/`ALLOW_EXTERNAL_WRITES`) + `vrchatCredsConfigured()`, so dev
serves whatever prod last cached. Never log auth cookies/creds.

## VRChat forces emailOtp from datacenter IPs (auth blocker)
Even with valid username/password AND a correct authenticator (TOTP) secret,
VRChat's login `requiresTwoFactorAuth` flips to **`emailOtp`** for logins from
unrecognized/datacenter IPs (the Replit container). TOTP cannot satisfy an
emailOtp challenge — VRChat ignores the authenticator and demands the 6-digit
code it emails. So the background poller CANNOT log in unattended from here; the
feature stays dormant until a session is established another way.

Diagnosis that wasted time once — rule these OUT before blaming the secret:
- TOTP algorithm: verify against RFC 6238 vectors (ascii seed
  `12345678901234567890` → base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`, T=59 →
  `287082`, T=1111111109 → `081804`). Ours passes.
- Clock skew: compare `Date.now()` to a real server's `Date` header (HEAD
  vrchat.com). Container was ~0s off, so not skew.
- Secret shape: `normalizeTotpSecret` extracts `secret=` from an `otpauth://` URL;
  base32Decode ignores non-alphabet chars. A pasted 6-digit/recovery code still
  decodes to garbage → `{"verified":false}` on `/auth/twofactorauth/totp/verify`.

`requiresTwoFactorAuth` values: `totp`/`otp` (authenticator + recovery) vs
`emailOtp` (email). `vrchatClient.login` throws a clear emailOtp-specific error.

**Viable fix (not built — user chose to leave dormant):** a one-time staff
"Connect VRChat" flow hitting `/auth/twofactorauth/emailotp/verify` with a
human-pasted code, persisting the returned `auth`+`twoFactorAuth` cookies (good
for weeks) so the poller reuses them. Only needs re-doing when the cookie expires.
