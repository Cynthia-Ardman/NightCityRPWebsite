---
name: Discord deep-link open-in-app with browser fallback
description: How guidebook/portal Discord links open the native app and reliably fall back to the browser.
---

Portal Discord links (channels/users) try the native app first, then fall back
to the browser. Lives in `artifacts/ncrp-portal/src/lib/discordDeepLink.ts`
(`toDiscordAppUrl` + `handleDiscordLinkClick`), wired into the `<a>` override in
`Markdown.tsx`.

Mechanism: on a plain left-click, `preventDefault`, set `window.location.href =
discord://-/channels|users/<path>` (the `-` is Discord's placeholder route
segment), and arm a ~1.2s timer. A one-shot `visibilitychange` listener marks
`appLikelyOpened` if the page goes hidden (the app grabbed focus), which cancels
the fallback.

**Why the fallback uses `window.location.assign(webUrl)`, NOT `window.open`:**
the fallback fires inside a `setTimeout`, i.e. OUTSIDE the user-gesture context,
so `window.open(..., "_blank")` is routinely popup-blocked → user gets nothing
when the app isn't installed. Same-tab `location.assign` is never popup-blocked,
so the browser fallback always lands.

**How to apply:** keep modifier/middle-click and `defaultPrevented` early-returns
so new-tab opens still work. Only `discord.com|discordapp.com` `/channels/` and
`/users/` paths are app-routable — everything else must no-op and navigate
normally. Don't reintroduce `window.open` for the fallback.
