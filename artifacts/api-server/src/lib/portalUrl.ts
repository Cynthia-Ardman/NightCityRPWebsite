// Shared portal deep-link construction for outbound Discord messages.
//
// Every message that links back to the portal uses the same base-URL fallback
// chain: prefer PUBLIC_BASE_URL (the pinned production domain), fall back to
// the first Replit domain, and degrade to a relative path when neither is set
// so the post is still readable. Centralized so the chain can't drift between
// the review pipelines, missions, offers, and breach puzzles.

// Bare host (scheme stripped) of the portal, or "" when unconfigured.
export function portalBaseHost(): string {
  return (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(
    /^https?:\/\//,
    "",
  );
}

// Absolute https URL for a portal path, or the relative path itself when no
// base host is configured.
export function portalLink(path: string): string {
  const base = portalBaseHost();
  return base ? `https://${base}${path}` : path;
}
