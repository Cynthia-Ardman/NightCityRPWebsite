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
  // In production, PUBLIC_BASE_URL pins the OAuth callback to the custom
  // domain (e.g. https://nightcityroleplay.com) regardless of which Replit
  // hostname REPLIT_DOMAINS happens to list first.
  const pinned = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (pinned) return `${pinned}/api/auth/discord/callback`;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
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
