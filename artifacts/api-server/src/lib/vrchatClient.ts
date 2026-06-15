import crypto from "node:crypto";
import { db, vrchatSessions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Server-side client for the dedicated 24/7 NCRP VRChat "instance browser"
// account. This logs in to the unofficial VRChat API with username/password
// (+ TOTP 2FA), persists the resulting auth/twoFactorAuth cookies in the DB so
// we only run the rate-limited login flow rarely, and replays them on each
// authenticated call. Credentials and cookie values are NEVER logged.
//
// IMPORTANT: VRChat's API is unofficial and rate-limited. The dedicated account
// must be a member of the NCRP group. Treat 401s as "session expired" and
// re-login at most once per call.
// ---------------------------------------------------------------------------

const API_BASE = "https://api.vrchat.cloud/api/1";
const SESSION_ID = 1;
const FETCH_TIMEOUT_MS = 15_000;

// Default to the known NCRP group; overridable via env.
export const NCRP_GROUP_ID =
  process.env.VRCHAT_GROUP_ID ?? "grp_667e7e40-7ea9-4142-a81e-5939c18c990f";

// VRChat requires a descriptive User-Agent with contact info, or it blocks the
// request. Mirror the public-origin fallback used elsewhere for outbound links.
function userAgent(): string {
  const contact =
    process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "night-city-rp";
  return `NightCityRP-Portal/1.0 (${contact})`;
}

export function vrchatCredsConfigured(): boolean {
  return !!(process.env.VRCHAT_USERNAME && process.env.VRCHAT_PASSWORD);
}

// --- TOTP (RFC 6238) via Node crypto, so we need no extra dependency. --------
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/g, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpCode(secret: string, atMs: number = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

// --- Cookie helpers ----------------------------------------------------------
// Extract a named cookie VALUE from a list of Set-Cookie header lines.
function readSetCookie(setCookies: string[], name: string): string | null {
  for (const line of setCookies) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(line);
    if (m) return m[1];
  }
  return null;
}

interface SessionCookies {
  auth: string | null;
  twoFactor: string | null;
}

async function loadSession(): Promise<SessionCookies> {
  const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
  return { auth: row?.authCookie ?? null, twoFactor: row?.twoFactorCookie ?? null };
}

async function persistSession(patch: Partial<typeof vrchatSessions.$inferInsert>): Promise<void> {
  await db
    .insert(vrchatSessions)
    .values({ id: SESSION_ID, ...patch })
    .onConflictDoUpdate({ target: vrchatSessions.id, set: patch });
}

export async function recordSessionError(message: string): Promise<void> {
  await persistSession({ lastError: message.slice(0, 500) });
}

function cookieHeader(c: SessionCookies): string {
  const parts: string[] = [];
  if (c.auth) parts.push(`auth=${c.auth}`);
  if (c.twoFactor) parts.push(`twoFactorAuth=${c.twoFactor}`);
  return parts.join("; ");
}

function baseHeaders(): Record<string, string> {
  return { "User-Agent": userAgent(), Accept: "application/json" };
}

// --- Login flow --------------------------------------------------------------
// Full login: Basic auth → /auth/user, satisfy a TOTP 2FA challenge if VRChat
// asks, then re-read /auth/user to capture identity. Persists fresh cookies.
async function login(): Promise<SessionCookies> {
  const username = process.env.VRCHAT_USERNAME;
  const password = process.env.VRCHAT_PASSWORD;
  if (!username || !password) {
    throw new Error("VRChat credentials not configured (VRCHAT_USERNAME / VRCHAT_PASSWORD).");
  }
  const basic = Buffer.from(
    `${encodeURIComponent(username)}:${encodeURIComponent(password)}`,
  ).toString("base64");

  // Keep any prior twoFactorAuth cookie — a remembered 2FA device lets VRChat
  // skip the TOTP challenge entirely on re-login.
  const prior = await loadSession();
  const authRes = await fetch(`${API_BASE}/auth/user`, {
    headers: {
      ...baseHeaders(),
      Authorization: `Basic ${basic}`,
      ...(prior.twoFactor ? { Cookie: `twoFactorAuth=${prior.twoFactor}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const setCookies = authRes.headers.getSetCookie?.() ?? [];
  const authCookie = readSetCookie(setCookies, "auth") ?? prior.auth;
  if (!authRes.ok) {
    const body = await authRes.text().catch(() => "");
    throw new Error(`VRChat login failed (${authRes.status}): ${body.slice(0, 200)}`);
  }
  const data = (await authRes.json().catch(() => ({}))) as {
    requiresTwoFactorAuth?: string[];
    id?: string;
    displayName?: string;
  };

  let twoFactorCookie = prior.twoFactor;
  const required = data.requiresTwoFactorAuth ?? [];
  if (required.length > 0) {
    const totpSecret = process.env.VRCHAT_TOTP_SECRET;
    const wantsTotp = required.includes("totp") || required.includes("otp");
    if (!wantsTotp || !totpSecret) {
      throw new Error(
        `VRChat requires 2FA (${required.join(", ")}). Set VRCHAT_TOTP_SECRET (authenticator-app secret) on the account.`,
      );
    }
    const verifyRes = await fetch(`${API_BASE}/auth/twofactorauth/totp/verify`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
        ...(authCookie ? { Cookie: `auth=${authCookie}` } : {}),
      },
      body: JSON.stringify({ code: totpCode(totpSecret) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!verifyRes.ok) {
      const body = await verifyRes.text().catch(() => "");
      throw new Error(`VRChat 2FA verify failed (${verifyRes.status}): ${body.slice(0, 200)}`);
    }
    twoFactorCookie = readSetCookie(verifyRes.headers.getSetCookie?.() ?? [], "twoFactorAuth") ?? twoFactorCookie;
  }

  const cookies: SessionCookies = { auth: authCookie, twoFactor: twoFactorCookie };
  if (!cookies.auth) throw new Error("VRChat login did not return an auth cookie.");

  // Confirm + capture identity using the freshly-minted cookies.
  let vrchatUserId = data.id ?? null;
  let vrchatDisplayName = data.displayName ?? null;
  if (!vrchatUserId) {
    const meRes = await fetch(`${API_BASE}/auth/user`, {
      headers: { ...baseHeaders(), Cookie: cookieHeader(cookies) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (meRes.ok) {
      const me = (await meRes.json().catch(() => ({}))) as { id?: string; displayName?: string };
      vrchatUserId = me.id ?? null;
      vrchatDisplayName = me.displayName ?? null;
    }
  }

  await persistSession({
    authCookie: cookies.auth,
    twoFactorCookie: cookies.twoFactor,
    vrchatUserId,
    vrchatDisplayName,
    lastAuthAt: new Date(),
    lastError: null,
  });
  logger.info({ vrchatUserId }, "VRChat session established");
  return cookies;
}

// Authenticated GET against the VRChat API. Uses stored cookies; on 401 it
// re-logs-in exactly once and retries. Returns parsed JSON or throws.
async function apiGet<T>(path: string): Promise<T> {
  let cookies = await loadSession();
  if (!cookies.auth) cookies = await login();

  const doFetch = (c: SessionCookies) =>
    fetch(`${API_BASE}${path}`, {
      headers: { ...baseHeaders(), Cookie: cookieHeader(c) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  let res = await doFetch(cookies);
  if (res.status === 401) {
    cookies = await login();
    res = await doFetch(cookies);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`VRChat GET ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  await persistSession({ lastAuthAt: new Date(), lastError: null });
  return (await res.json()) as T;
}

// Raw VRChat group instance shape (subset we use; the API returns more).
export interface RawVrchatInstance {
  instanceId?: string;
  location?: string;
  region?: string;
  type?: string;
  groupAccessType?: string;
  userCount?: number;
  n_users?: number;
  memberCount?: number;
  capacity?: number;
  world?: {
    id?: string;
    name?: string;
    thumbnailImageUrl?: string;
    imageUrl?: string;
    capacity?: number;
  };
}

export async function fetchGroupInstances(groupId: string = NCRP_GROUP_ID): Promise<RawVrchatInstance[]> {
  const data = await apiGet<RawVrchatInstance[]>(`/groups/${groupId}/instances`);
  return Array.isArray(data) ? data : [];
}
