import { logger } from "./logger";

const API = "https://discord.com/api/v10";

export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID ?? "";
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.TOKEN ?? "";

/**
 * Whether this process may perform outbound WRITES to live Discord — posting
 * channel messages, sending DMs, and creating/editing/deleting scheduled
 * events.
 *
 * Only the real production deployment (`REPLIT_DEPLOYMENT === "1"`) is allowed
 * to write to the live server. The community test site runs in the Replit dev
 * workspace (no REPLIT_DEPLOYMENT), so every outbound Discord write is
 * suppressed there — even though the same bot token is present, and even if
 * Live Mode flags were inherited from a production data sync. Reads (OAuth
 * token exchange, guild role lookups, user/thread fetches) are NOT gated and
 * keep working in every environment, so login and role-gating still function
 * on the test site.
 *
 * Set `ALLOW_EXTERNAL_WRITES=1` to deliberately opt a non-deployment
 * environment back in (e.g. when testing Discord delivery from the workspace).
 */
export function externalWritesAllowed(): boolean {
  return (
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.ALLOW_EXTERNAL_WRITES === "1"
  );
}

export const ROLE_NAMES = {
  ADMIN: ["admin", "administrator", "staff"],
  // "coordinator" is treated as equivalent to a fixer everywhere FIXER is checked.
  FIXER: ["fixer", "coordinator"],
  ARCHIVIST: ["archivist"],
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

/**
 * Fetch a guild member's RAW role ids via the bot token (not resolved to
 * names). Used for exact-id role checks (e.g. the self-service NPC role).
 * Returns:
 *   - string[] of role ids on success (empty array if the user has no roles),
 *   - []       if the user is not in the guild (404),
 *   - null     when the lookup could not be performed (missing token/guild,
 *              upstream error, network failure) so callers can distinguish
 *              "definitely has no role" from "couldn't determine".
 */
export async function fetchGuildMemberRoleIdsViaBot(discordUserId: string): Promise<string[] | null> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return null;
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) {
      logger.warn({ status: res.status, discordUserId }, "fetchGuildMemberRoleIdsViaBot failed");
      return null;
    }
    const member = (await res.json()) as { roles: string[] };
    return member.roles ?? [];
  } catch (err) {
    logger.error({ err, discordUserId }, "fetchGuildMemberRoleIdsViaBot error");
    return null;
  }
}

/**
 * Discord role id for the self-service "NPC" role granted from the portal.
 */
export const NPC_ROLE_ID = "1348661508011462769";

/**
 * Grant a guild role to a member using the bot token
 * (`PUT /guilds/{guild}/members/{user}/roles/{role}`). Gated behind
 * externalWritesAllowed() like every other outbound Discord write, so it only
 * fires on the real deployment (or when explicitly opted in). Discord returns
 * 204 on success and also 204 if the member already has the role, so this is
 * idempotent. Returns a discriminated result instead of throwing.
 */
export async function addGuildMemberRole(
  discordUserId: string,
  roleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { ok: false, error: "Discord bot token or guild id not configured" };
  }
  if (!externalWritesAllowed()) {
    logger.info(
      { discordUserId, roleId },
      "Discord write suppressed (non-deployment env); skipping role grant",
    );
    return {
      ok: false,
      error: "External Discord writes are disabled in this (test) environment",
    };
  }
  try {
    const res = await fetch(
      `${API}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "X-Audit-Log-Reason": "Self-service NPC role granted via portal",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text, discordUserId, roleId }, "addGuildMemberRole failed");
      return { ok: false, error: `Discord role grant failed (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, discordUserId, roleId }, "addGuildMemberRole error");
    return { ok: false, error: msg };
  }
}

/**
 * Remove a guild role from a member using the bot token
 * (`DELETE /guilds/{guild}/members/{user}/roles/{role}`). Sibling to
 * addGuildMemberRole: gated behind externalWritesAllowed() so it only fires on
 * the real deployment (or when explicitly opted in). Discord returns 204 on
 * success and also 204 if the member did not have the role, so this is
 * idempotent. Returns a discriminated result instead of throwing.
 */
export async function removeGuildMemberRole(
  discordUserId: string,
  roleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { ok: false, error: "Discord bot token or guild id not configured" };
  }
  if (!externalWritesAllowed()) {
    logger.info(
      { discordUserId, roleId },
      "Discord write suppressed (non-deployment env); skipping role removal",
    );
    return {
      ok: false,
      error: "External Discord writes are disabled in this (test) environment",
    };
  }
  try {
    const res = await fetch(
      `${API}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "X-Audit-Log-Reason": "Self-service NPC role removed via portal",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text, discordUserId, roleId }, "removeGuildMemberRole failed");
      return { ok: false, error: `Discord role removal failed (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, discordUserId, roleId }, "removeGuildMemberRole error");
    return { ok: false, error: msg };
  }
}

export type GuildMemberLite = {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
};

/**
 * List every guild member that currently holds `roleId`, using the bot token.
 *
 * Paginates the privileged guild-members endpoint
 * (`GET /guilds/{guild}/members?limit=1000&after=<cursor>`) — this requires the
 * "Server Members Intent" to be enabled for the bot. Read-only: it never
 * mutates Discord, so it is safe in every environment (no externalWritesAllowed
 * gate). Returns:
 *   - GuildMemberLite[] of holders on success (possibly empty),
 *   - null              when the scan could not be performed (missing config or
 *                       an upstream/network error) so callers can distinguish
 *                       "nobody has the role" from "couldn't determine".
 */
export async function listGuildMembersWithRole(
  roleId: string,
): Promise<{ holders: GuildMemberLite[]; truncated: boolean } | null> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return null;
  const holders: GuildMemberLite[] = [];
  let after = "0";
  // Hard cap of 50 pages (50k members) as a safety valve against an
  // unexpected pagination loop. `truncated` is set if we stop because of the
  // cap (a full page on the final iteration), so callers can warn that the
  // result may be an undercount instead of trusting it silently.
  const MAX_PAGES = 50;
  let truncated = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `${API}/guilds/${DISCORD_GUILD_ID}/members?limit=1000&after=${after}`,
        {
          headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        logger.warn(
          { status: res.status, body: await res.text() },
          "listGuildMembersWithRole failed",
        );
        return null;
      }
      const members = (await res.json()) as Array<{
        user?: { id: string; username: string; global_name: string | null; avatar: string | null };
        roles?: string[];
      }>;
      if (members.length === 0) break;
      for (const m of members) {
        if (!m.user) continue;
        if (m.roles?.includes(roleId)) {
          holders.push({
            id: m.user.id,
            username: m.user.username,
            globalName: m.user.global_name ?? null,
            avatarUrl: avatarUrl(m.user.id, m.user.avatar),
          });
        }
      }
      if (members.length < 1000) break;
      const last = members[members.length - 1].user;
      if (!last) break;
      after = last.id;
      // A full page on the final allowed iteration means more members likely
      // remain unscanned.
      if (page === MAX_PAGES - 1) truncated = true;
    }
    if (truncated) {
      logger.warn(
        { roleId, scanned: holders.length },
        "listGuildMembersWithRole hit page cap; result may be truncated",
      );
    }
    return { holders, truncated };
  } catch (err) {
    logger.error({ err, roleId }, "listGuildMembersWithRole error");
    return null;
  }
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
  if (!externalWritesAllowed()) {
    logger.info({ name: input.name }, "Discord write suppressed (non-deployment env); skipping event create");
    return { ok: false, error: "External Discord writes are disabled in this (test) environment" };
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
  if (!externalWritesAllowed()) {
    logger.info({ eventId }, "Discord write suppressed (non-deployment env); skipping event modify");
    return { ok: false, error: "External Discord writes are disabled in this (test) environment" };
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
  if (!externalWritesAllowed()) {
    logger.info({ eventId }, "Discord write suppressed (non-deployment env); skipping event delete");
    return { ok: false, error: "External Discord writes are disabled in this (test) environment" };
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

export interface GuildScheduledEvent {
  id: string;
  name: string;
  description: string | null;
  /** entity_metadata.location for EXTERNAL events; null otherwise. */
  location: string | null;
  scheduledStartTime: string;
  scheduledEndTime: string | null;
  /** Discord user id of the event creator (null for older/bot-made events). */
  creatorId: string | null;
  /** Cover image hash (combine with id for the CDN url); null if none. */
  image: string | null;
  /** 1=scheduled, 2=active, 3=completed, 4=canceled. */
  status: number;
  /** 1=stage, 2=voice, 3=external. */
  entityType: number;
}

export type ListScheduledEventsResult =
  | { ok: true; events: GuildScheduledEvent[] }
  | { ok: false; error: string };

/**
 * List the guild's scheduled events (read-only). Used for the create/reschedule
 * conflict check. Fail-safe: callers treat a non-ok result as "couldn't check"
 * (a staff-facing notice), never as a hard block.
 */
export async function listGuildScheduledEvents(): Promise<ListScheduledEventsResult> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { ok: false, error: "Discord bot token or guild id not configured" };
  }
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/scheduled-events`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, "listGuildScheduledEvents failed");
      return { ok: false, error: `Discord events lookup failed (${res.status})` };
    }
    const data = (await res.json()) as Array<{
      id: string;
      name: string;
      description?: string | null;
      scheduled_start_time: string;
      scheduled_end_time: string | null;
      entity_metadata?: { location?: string | null } | null;
      creator_id?: string | null;
      image?: string | null;
      status?: number;
      entity_type?: number;
    }>;
    return {
      ok: true,
      events: data.map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description ?? null,
        location: e.entity_metadata?.location ?? null,
        scheduledStartTime: e.scheduled_start_time,
        scheduledEndTime: e.scheduled_end_time,
        creatorId: e.creator_id ?? null,
        image: e.image ?? null,
        status: e.status ?? 1,
        entityType: e.entity_type ?? DISCORD_ENTITY_TYPE_EXTERNAL,
      })),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "listGuildScheduledEvents error");
    return { ok: false, error: msg };
  }
}

export async function postToChannel(channelId: string, content: string, embeds?: unknown[]): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) {
    logger.warn("No bot token; cannot post to Discord channel");
    return null;
  }
  if (!externalWritesAllowed()) {
    logger.info({ channelId }, "Discord write suppressed (non-deployment env); skipping channel post");
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

/**
 * Send a direct message to a user by their Discord ID. Opens (or reuses) the
 * bot↔user DM channel, then posts to it. Returns the message id on success or
 * null on any failure (no token, user has DMs disabled, etc.) — callers treat a
 * null as a non-fatal delivery miss and must not let it block their action.
 */
export async function sendDirectMessage(userId: string, content: string): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) {
    logger.warn("No bot token; cannot send Discord DM");
    return null;
  }
  if (!externalWritesAllowed()) {
    logger.info({ userId }, "Discord write suppressed (non-deployment env); skipping DM");
    return null;
  }
  const dmRes = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!dmRes.ok) {
    logger.warn({ status: dmRes.status, body: await dmRes.text(), userId }, "Discord DM channel open failed");
    return null;
  }
  const dm = (await dmRes.json()) as { id: string };
  return postToChannel(dm.id, content);
}
