---
name: Discord CDN attachment URLs expire — always re-host
description: cdn.discordapp.com / media.discordapp.net URLs are signed and stop working after ~24h. Never persist them; download and re-host on object storage.
---

Discord rolled signed URLs onto every attachment a while back. The
`url` and `proxy_url` returned by `GET /channels/.../messages` look
permanent but include `?ex=&is=&hm=` query params and start 401ing
roughly 24h after issue.

**Why:** Storing a raw cdn.discordapp.com URL in the DB looks fine
in QA, then every image silently breaks overnight. The portrait-
backfill tool hit this immediately — first iteration just saved the
attachment URL and every recovered portrait 404'd the next day.

**How to apply:**
- Any time we want to persist a Discord-hosted image (portraits,
  scraped sheet artwork, bot-uploaded receipts, etc.), download the
  bytes server-side **inside the same request** that the user/admin
  triggered, then push them through `ObjectStorageService.uploadBuffer(buf, contentType)`
  and store the returned `/api/storage/objects/<id>` path.
- The signed URL is good long enough for our own server to fetch it
  in the same request — don't queue the download for later.
- This applies even for thumbnails on `proxy_url` (media.discordapp.net) —
  same expiry behavior.
