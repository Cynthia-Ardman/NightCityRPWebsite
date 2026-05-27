---
name: Object storage public images
description: How GET /storage/objects/* should treat ACL on this product
---

Rule: in `/storage/objects/*`, if the object has no `custom:aclPolicy`
metadata, serve it as anonymous-readable. Only honor explicit ACL when one
is present (visibility=public → anon; visibility=private → require auth +
ACL check).

**Why:** The character archive's imported portraits and stats screenshots are
uploaded via the presigned-URL flow, which does not set any ACL metadata.
If you require a policy to grant READ (the template default), every
imported image 403s for anonymous visitors and the directory pages break.

**How to apply:** Read the policy with `getObjectAclPolicy`. If `null`,
allow READ. If present and `visibility !== "public"`, fall back to
`canAccessObjectEntity` (which will deny anonymous reads).
