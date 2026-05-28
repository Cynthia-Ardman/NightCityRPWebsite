import { logger } from "./logger";

const API = "https://discord.com/api/v10";

export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID ?? "";
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.TOKEN ?? "";

export const ROLE_NAMES = {
  ADMIN: ["admin", "administrator", "staff"],
  FIXER: ["fixer"],
  CS_APPROVER: ["cs approver", "character approver", "cs-approver"],
  RIPPERDOC: ["ripperdoc"],
  STORE_OWNER: ["store owner", "shop owner"],
};

export function getRedirectUri(): string {
  // Only honor PUBLIC_BASE_URL in actual deployments (REPLIT_DEPLOYMENT=1).
  // In the dev workspace we always use the live workspace domain so Discord
  // OAuth round-trips back to the workflow app the user is testing in,
  // even though PUBLIC_BASE_URL is set as a shared secret for production.
  const isDeployment = process.env.REPLIT_DEPLOYMENT === "1";
  if (isDeployment) {
    const pinned = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
    if (pinned) return `${pinned}/api/auth/discord/callback`;
  }
  const domain =
    process.env.REPLIT_DEV_DOMAIN ||
    process.env.REPLIT_DOMAINS?.split(",")[0];
  if (!domain) return "http://localhost:5000/api/auth/discord/callback";
  return `https://${domain}/api/auth/discord/callback`;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export class DiscordConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordConfigError";
  }
}

export class DiscordUpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DiscordUpstreamError";
    this.status = status;
  }
}

export async function exchangeCode(code: string) {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    throw new DiscordConfigError(
      "Discord OAuth is not configured: DISCORD_CLIENT_ID and/or DISCORD_CLIENT_SECRET is missing.",
    );
  }
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
  });
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 && text.includes("invalid_client")) {
      throw new DiscordConfigError(
        "Discord rejected the OAuth client credentials (invalid_client). The DISCORD_CLIENT_SECRET likely does not match the DISCORD_CLIENT_ID for this Discord application. Note: the OAuth2 client secret is NOT the bot token — generate it under OAuth2 → Reset Secret in the Discord Developer Portal.",
      );
    }
    if (res.status === 400 && text.includes("invalid_grant")) {
      throw new DiscordConfigError(
        `Discord rejected the OAuth authorization code (invalid_grant). The redirect URI registered on the Discord application must exactly match ${getRedirectUri()}.`,
      );
    }
    throw new DiscordUpstreamError(res.status, `Token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };
}

export async function fetchUser(accessToken: string) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new DiscordUpstreamError(res.status, `Discord user fetch failed: ${res.status}`);
  return (await res.json()) as {
    id: string;
    username: string;
    global_name?: string;
    avatar?: string;
  };
}

export async function fetchGuildMemberRoles(accessToken: string, discordUserId: string): Promise<string[]> {
  if (!DISCORD_GUILD_ID) return [];
  try {
    const memberRes = await fetch(`${API}/users/@me/guilds/${DISCORD_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (memberRes.status === 404) return [];
    if (!memberRes.ok) {
      logger.warn({ status: memberRes.status }, "Failed to fetch guild member via user token");
      return [];
    }
    const member = (await memberRes.json()) as { roles: string[] };
    return await resolveRoleNames(member.roles);
  } catch (err) {
    logger.error({ err }, "fetchGuildMemberRoles failed");
    return [];
  }
}

let rolesCache: { fetchedAt: number; roles: Map<string, string> } | null = null;

async function getGuildRolesMap(): Promise<Map<string, string>> {
  if (rolesCache && Date.now() - rolesCache.fetchedAt < 5 * 60 * 1000) return rolesCache.roles;
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return new Map();
  const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/roles`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!res.ok) return new Map();
  const roles = (await res.json()) as Array<{ id: string; name: string }>;
  const map = new Map(roles.map((r) => [r.id, r.name.toLowerCase()]));
  rolesCache = { fetchedAt: Date.now(), roles: map };
  return map;
}

async function resolveRoleNames(roleIds: string[]): Promise<string[]> {
  const map = await getGuildRolesMap();
  return roleIds.map((id) => map.get(id) ?? id).filter(Boolean);
}

export function hasRole(roles: string[], group: keyof typeof ROLE_NAMES): boolean {
  const lower = roles.map((r) => r.toLowerCase());
  return ROLE_NAMES[group].some((target) => lower.includes(target));
}

export async function fetchGuildMemberRolesViaBot(discordUserId: string): Promise<string[]> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return [];
  const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!res.ok) return [];
  const member = (await res.json()) as { roles: string[] };
  return await resolveRoleNames(member.roles);
}

export function avatarUrl(discordId: string, hash: string | null | undefined): string | null {
  if (!hash) return null;
  return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.png`;
}

export type DiscordUserProfile = {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
};

/**
 * Fetch a Discord user's public profile by ID using the bot token.
 * Returns null on 404 / missing token / network errors so callers can
 * skip cleanly during bulk hydration.
 */
export async function fetchDiscordUser(discordId: string): Promise<DiscordUserProfile | null> {
  if (!DISCORD_BOT_TOKEN) return null;
  try {
    const res = await fetch(`${API}/users/${discordId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as {
      id: string;
      username: string;
      global_name: string | null;
      avatar: string | null;
    };
    return {
      id: u.id,
      username: u.username,
      globalName: u.global_name,
      avatarUrl: avatarUrl(u.id, u.avatar),
    };
  } catch (err) {
    logger.warn({ err, discordId }, "fetchDiscordUser failed");
    return null;
  }
}

/** A Discord message attachment we care about for portrait backfill. */
export interface ThreadAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;          // CDN url (signed, short-lived)
  proxyUrl: string;     // media.discordapp.net mirror (also signed)
  width: number | null;
  height: number | null;
}

interface DiscordMessage {
  id: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string | null;
    size: number;
    url: string;
    proxy_url: string;
    width?: number | null;
    height?: number | null;
  }>;
}

/**
 * Fetch the OP message of a thread.
 *
 * For forum-post threads (which is how #character-sheets is structured) the
 * thread id IS the OP message id, so `GET /channels/{thread}/messages/{thread}`
 * is the cheapest one-shot fetch. For non-forum threads we fall back to
 * paging through messages and picking the chronologically oldest one.
 */
export async function fetchThreadOpMessage(threadId: string): Promise<DiscordMessage | null> {
  if (!DISCORD_BOT_TOKEN) return null;
  const headers = { Authorization: `Bot ${DISCORD_BOT_TOKEN}` };
  // Try the forum-thread shortcut first.
  const direct = await fetch(`${API}/channels/${threadId}/messages/${threadId}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (direct.ok) {
    return (await direct.json()) as DiscordMessage;
  }
  if (direct.status !== 404) {
    logger.warn(
      { status: direct.status, threadId, body: await direct.text() },
      "fetchThreadOpMessage direct fetch failed",
    );
    // fall through to paginated lookup
  }
  // Fallback: paginate to the oldest message. `after=0` returns messages
  // with id > 0 (all of them) and Discord returns them oldest-first when
  // `after` is provided, so limit=1 gives us the OP.
  const oldest = await fetch(`${API}/channels/${threadId}/messages?after=0&limit=1`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!oldest.ok) {
    logger.warn(
      { status: oldest.status, threadId, body: await oldest.text() },
      "fetchThreadOpMessage paginated fetch failed",
    );
    return null;
  }
  const arr = (await oldest.json()) as DiscordMessage[];
  return arr[0] ?? null;
}

/** Filter a message's attachments down to image-like uploads. */
export function imageAttachmentsOf(msg: DiscordMessage | null | undefined): ThreadAttachment[] {
  if (!msg?.attachments) return [];
  return msg.attachments
    .filter((a) => {
      const ct = (a.content_type ?? "").toLowerCase();
      if (ct.startsWith("image/")) return true;
      // Content-type can be missing; fall back to extension.
      return /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename);
    })
    .map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type ?? null,
      size: a.size,
      url: a.url,
      proxyUrl: a.proxy_url,
      width: a.width ?? null,
      height: a.height ?? null,
    }));
}

export async function postToChannel(channelId: string, content: string, embeds?: unknown[]): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) {
    logger.warn("No bot token; cannot post to Discord channel");
    return null;
  }
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, embeds }),
  });
  if (!res.ok) {
    logger.warn({ status: res.status, body: await res.text() }, "Discord channel post failed");
    return null;
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}
