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

**Fix (BUILT): staff "Connect VRChat" flow.** Staff-only (ADMIN/FIXER) endpoints
`GET /vrchat/session`, `POST /vrchat/session/connect`, `POST /vrchat/session/verify`
(see `vrchatClient.beginManualLogin`/`completeEmailOtpLogin`/`finalizeSession` +
the `VrchatConnectCard` in the System Admin → VRChat tab). `connect` POSTs Basic-auth creds to `/auth/user`
— that request itself makes VRChat email the 6-digit code AND returns the `auth`
cookie, which we stash in `vrchat_sessions.pending_auth_cookie`. `verify` posts
the pasted code to `/auth/twofactorauth/emailotp/verify` with the pending cookie,
then promotes `auth`+`twoFactorAuth` cookies (good for weeks) so the poller reuses
them. Re-do only when the cookie expires.

Gotchas:
- `getSessionInfo().connected` is cookie-PRESENCE based, not validity — a stale
  `authCookie` reads "connected" even when dead. So the verify-code input must be
  gated on `pending`, NEVER `pending && !connected`, or the reconnect-after-expiry
  path (old cookie still present) hides the input and you can't finish.
- Basic-auth encoding MUST be `base64(encodeURIComponent(user):encodeURIComponent(pass))`
  — identical to the existing `login()`. A `401 "Invalid Username/Email or Password"`
  from `/auth/user` is a CREDENTIAL problem (wrong VRCHAT_USERNAME/PASSWORD), not
  an encoding bug; don't chase the code.


## Former index detail (full)
group API only returns GROUP instances (private/invite+ never listed); instance roleIds→names via cached group-roles map at poll time, read path never hits VRChat, drop unresolved `grol_` ids ([roles](vrchat-instance-roles.md)); cron deployment-gated, dev serves prod cache; emailOtp from datacenter IPs blocks unattended TOTP login; never log creds.

## No unattended re-login (429 network lockout, fixed 2026-07-18)
`apiGet`/`apiSend` must NEVER fall back to `login()` on a missing cookie or 401 —
password login from the datacenter IP always dead-ends in emailOtp, and the
2-minute poller retrying it trips VRChat's per-NETWORK failed-login limiter
(429 "too many failed login attempts from network"), which then blocks even the
manual staff reconnect for hours. Current behavior: missing cookie → throw
SESSION_EXPIRED_MSG; 401 → `markSessionExpired()` (clears authCookie, KEEPS
twoFactorAuth cookie, persists reconnect lastError) → card flips to
Not connected; the instance-poll cron skips quietly while disconnected.
After a lockout, wait ~1h+ before retrying Connect.

## Calendar endpoint asymmetry (405 trap)
Create `POST /calendar/{grp}/event` and update `PUT /calendar/{grp}/{cal}/event`
keep the `/event` suffix, but delete is `DELETE /calendar/{grp}/{cal}` — WITH
the suffix it returns 405 Method Not Allowed. Also: any calendar write for an
event whose START has passed 400s ("Calendar Entry must start in the future"),
so reconcile skips rows with past startAt (not endAt).
