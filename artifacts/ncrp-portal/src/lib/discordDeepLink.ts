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

  // When the app handler exists, the browser shows an "Open Discord?" prompt.
  // That prompt blurs/hides this page, so a blur or visibility change means the
  // OS/browser has taken over — DON'T yank the user back to the web while the
  // prompt is still on screen (the old same-tab fallback did exactly that,
  // navigating away before the user could click "Allow").
  let handledByApp = false;
  const markHandled = () => {
    handledByApp = true;
  };
  const onVisibility = () => {
    if (document.hidden) markHandled();
  };
  window.addEventListener("blur", markHandled, { once: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", markHandled, { once: true });

  const cleanup = () => {
    window.removeEventListener("blur", markHandled);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", markHandled);
  };

  // Trigger the app via a hidden iframe rather than navigating this tab. An
  // iframe pointed at an unknown scheme fails silently and never moves the
  // current page, so the portal stays put and the prompt has time to breathe.
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  document.body.appendChild(iframe);
  try {
    iframe.src = appUrl;
  } catch {
    // Some browsers throw on disallowed-scheme iframe navigation; ignore and
    // let the fallback handle it.
  }

  window.setTimeout(() => {
    iframe.remove();
    cleanup();
    if (handledByApp) return; // the app (or its prompt) took over — leave it be.
    // No handler took the scheme (app not installed): open the web version in a
    // NEW tab so the page the user was reading is never disturbed. If the
    // browser blocks the programmatic popup, fall back to same-tab as a last
    // resort so the link still goes somewhere.
    const win = window.open(webUrl, "_blank", "noopener,noreferrer");
    if (!win) window.location.assign(webUrl);
  }, 2000);
}
