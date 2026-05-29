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

// ---------------------------------------------------------------------------
// Guild scheduled events (used by the Missions system). We create EXTERNAL
// events (entity_type 3) so they don't require a voice/stage channel; they
// carry a location string and an explicit end time. All functions return a
// discriminated result so callers can persist a sync error for staff without
// throwing. Requires the bot to have the "Manage Events" permission.
// ---------------------------------------------------------------------------
export type ScheduledEventResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export interface ScheduledEventInput {
  name: string;
  description?: string | null;
  location: string;
  startAt: Date;
  endAt: Date;
  /** Optional http(s) image URL; fetched and inlined as a data URI. */
  imageUrl?: string | null;
}

const DISCORD_EVENT_PRIVACY_GUILD_ONLY = 2;
const DISCORD_ENTITY_TYPE_EXTERNAL = 3;

// Hosts we are willing to server-side fetch images from. Anything else is
// rejected to avoid an SSRF sink (mission image URLs are user-supplied via the
// create/edit mission endpoints, so an attacker could otherwise point the
// backend at internal/metadata endpoints). We only inline images that live on
// our own public base (object storage), the Replit dev domain, or Discord's CDN.
function isAllowedImageHost(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  for (const raw of [process.env.PUBLIC_BASE_URL, process.env.REPLIT_DEV_DOMAIN]) {
    if (!raw) continue;
    try {
      allowed.add(new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase());
    } catch {
      /* ignore malformed env */
    }
  }
  if (allowed.has(host)) return true;
  // Discord's own CDN is a trusted source for cover images.
  return host === "cdn.discordapp.com" || host === "media.discordapp.net";
}

async function imageUrlToDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (!isAllowedImageHost(url)) {
    logger.warn({ url }, "imageUrlToDataUri rejected disallowed host (SSRF guard)");
    return null;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/png";
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Discord rejects very large cover images; skip anything over ~8MB.
    if (buf.length > 8 * 1024 * 1024) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch (err) {
    logger.warn({ err, url }, "imageUrlToDataUri failed");
    return null;
  }
}

async function buildEventBody(input: ScheduledEventInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    name: input.name.slice(0, 100),
    privacy_level: DISCORD_EVENT_PRIVACY_GUILD_ONLY,
    scheduled_start_time: input.startAt.toISOString(),
    scheduled_end_time: input.endAt.toISOString(),
    entity_type: DISCORD_ENTITY_TYPE_EXTERNAL,
    entity_metadata: { location: (input.location || "Night City").slice(0, 100) },
    description: (input.description ?? "").slice(0, 1000) || undefined,
  };
  const image = await imageUrlToDataUri(input.imageUrl);
  if (image) body.image = image;
  return body;
}

export async function createGuildScheduledEvent(input: ScheduledEventInput): Promise<ScheduledEventResult> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { ok: false, error: "Discord bot token or guild id not configured" };
  }
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/scheduled-events`, {
      method: "POST",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(await buildEventBody(input)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, "createGuildScheduledEvent failed");
      return { ok: false, error: `Discord event create failed (${res.status}): ${text.slice(0, 300)}` };
    }
    const data = (await res.json()) as { id: string };
    return { ok: true, id: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "createGuildScheduledEvent error");
    return { ok: false, error: msg };
  }
}

export async function modifyGuildScheduledEvent(
  eventId: string,
  input: ScheduledEventInput,
): Promise<ScheduledEventResult> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { ok: false, error: "Discord bot token or guild id not configured" };
  }
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/scheduled-events/${eventId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(await buildEventBody(input)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text, eventId }, "modifyGuildScheduledEvent failed");
      return { ok: false, error: `Discord event update failed (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: true, id: eventId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, eventId }, "modifyGuildScheduledEvent error");
    return { ok: false, error: msg };
  }
}

/**
 * Cancel a scheduled event. Discord has no "cancelled" state for events that
 * haven't started, so we delete it (the spec accepts cancel-or-update). Treats
 * a 404 as success (already gone).
 */
export async function deleteGuildScheduledEvent(eventId: string): Promise<ScheduledEventResult> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { ok: false, error: "Discord bot token or guild id not configured" };
  }
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/scheduled-events/${eventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text, eventId }, "deleteGuildScheduledEvent failed");
      return { ok: false, error: `Discord event delete failed (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: true, id: eventId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, eventId }, "deleteGuildScheduledEvent error");
    return { ok: false, error: msg };
  }
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
