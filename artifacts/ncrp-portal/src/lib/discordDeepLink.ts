// Discord web links (channels + user profiles) imported into the guidebook
// should open the native Discord desktop/mobile app when it's installed, and
// only fall back to a browser tab when it isn't.
//
// The app understands the `discord://` URL scheme. `discord://-/channels/...`
// and `discord://-/users/...` mirror the `discord.com/...` web paths (the `-`
// is Discord's placeholder route segment). We try to navigate to that scheme
// and, if nothing handles it within a short window, open the original web URL.

const DISCORD_WEB_HOSTS = new Set(["discord.com", "discordapp.com", "www.discord.com"]);

/**
 * Convert a Discord web URL (channel or user link) to its `discord://` app
 * deep-link, or return null if the URL isn't an app-routable Discord link.
 */
export function toDiscordAppUrl(webUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(webUrl);
  } catch {
    return null;
  }
  if (!DISCORD_WEB_HOSTS.has(u.hostname)) return null;
  // Only channel and user routes map cleanly to the app.
  if (!/^\/(channels|users)\//.test(u.pathname)) return null;
  return `discord://-${u.pathname}`;
}

/**
 * Click handler for a Discord web link: attempt to open the native app, with a
 * browser-tab fallback if the app doesn't take over. Safe to attach to any
 * anchor — it no-ops (letting the normal browser navigation happen) for links
 * that aren't app-routable Discord URLs.
 */
export function handleDiscordLinkClick(
  e: React.MouseEvent<HTMLAnchorElement>,
  webUrl: string,
): void {
  // Respect modifier-click / middle-click (new tab) and non-primary buttons.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  const appUrl = toDiscordAppUrl(webUrl);
  if (!appUrl) return; // not a Discord app link — let the browser open it normally

  e.preventDefault();

  let appLikelyOpened = false;
  const onHide = () => {
    // If the page is hidden, the app grabbed focus — cancel the web fallback.
    if (document.hidden) appLikelyOpened = true;
  };
  document.addEventListener("visibilitychange", onHide, { once: true });

  const fallback = window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    if (!appLikelyOpened) {
      // Same-tab navigation — unlike window.open it is never popup-blocked, so
      // the browser fallback always lands even though we're outside the click
      // gesture here.
      window.location.assign(webUrl);
    }
  }, 1200);

  // Also clear the fallback if the page is hidden before the timer fires.
  window.setTimeout(() => {
    if (appLikelyOpened) window.clearTimeout(fallback);
  }, 1300);

  // Trigger the app. Unknown-scheme navigation is ignored by browsers when no
  // handler is registered, so the page stays put and the fallback runs.
  window.location.href = appUrl;
}
