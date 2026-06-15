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

// Accept a few shapes a user might paste for the 2FA secret: the bare base32
// seed (ideal), or a full otpauth:// URL (extract its `secret=` param). Anything
// else falls through to base32Decode which ignores non-alphabet chars.
function normalizeTotpSecret(raw: string): string {
  const trimmed = raw.trim();
  const m = /[?&]secret=([^&\s]+)/i.exec(trimmed);
  if (m) return decodeURIComponent(m[1]);
  return trimmed;
}

function totpCode(rawSecret: string, atMs: number = Date.now()): string {
  const secret = normalizeTotpSecret(rawSecret);
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
    const lc = required.map((r) => r.toLowerCase());
    const wantsTotp = lc.includes("totp") || lc.includes("otp");
    if (lc.includes("emailotp") && !wantsTotp) {
      throw new Error(
        "VRChat is requiring EMAIL one-time codes (emailOtp) for this account, which can't be automated. Switch the account to an authenticator app (TOTP) in VRChat settings, then provide VRCHAT_TOTP_SECRET.",
      );
    }
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
      throw new Error(
        `VRChat 2FA verify failed (${verifyRes.status}) for methods [${required.join(", ")}]: ${body.slice(0, 200)}. The TOTP code was rejected — VRCHAT_TOTP_SECRET is likely not the account's authenticator seed.`,
      );
    }
    twoFactorCookie = readSetCookie(verifyRes.headers.getSetCookie?.() ?? [], "twoFactorAuth") ?? twoFactorCookie;
  }

  const cookies: SessionCookies = { auth: authCookie, twoFactor: twoFactorCookie };
  await finalizeSession(cookies, data);
  return cookies;
}

// Persist a freshly-established session: confirm + capture account identity using
// the new cookies, store them, clear any pending-login state, and mark healthy.
async function finalizeSession(
  cookies: SessionCookies,
  prelim: { id?: string; displayName?: string },
): Promise<{ vrchatUserId: string | null; vrchatDisplayName: string | null }> {
  if (!cookies.auth) throw new Error("VRChat login did not return an auth cookie.");
  let vrchatUserId = prelim.id ?? null;
  let vrchatDisplayName = prelim.displayName ?? null;
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
    pendingAuthCookie: null,
    vrchatUserId,
    vrchatDisplayName,
    lastAuthAt: new Date(),
    lastError: null,
  });
  logger.info({ vrchatUserId }, "VRChat session established");
  return { vrchatUserId, vrchatDisplayName };
}

export type ConnectStatus = "connected" | "needs_email_code";

export interface ConnectResult {
  status: ConnectStatus;
  displayName: string | null;
}

// Begin a STAFF-DRIVEN manual login. Posts credentials to /auth/user, which both
// tells us which 2FA method VRChat wants AND (for emailOtp) causes VRChat to send
// the code email. If a remembered twoFactor cookie or a configured TOTP secret can
// satisfy the challenge we finish immediately; otherwise we stash the auth cookie
// and report that an email code is needed. This exists because VRChat forces
// emailOtp on logins from this server's datacenter IP, which can't be automated.
export async function beginManualLogin(): Promise<ConnectResult> {
  const username = process.env.VRCHAT_USERNAME;
  const password = process.env.VRCHAT_PASSWORD;
  if (!username || !password) {
    throw new Error("VRChat credentials not configured (VRCHAT_USERNAME / VRCHAT_PASSWORD).");
  }
  const basic = Buffer.from(
    `${encodeURIComponent(username)}:${encodeURIComponent(password)}`,
  ).toString("base64");

  const prior = await loadSession();
  const authRes = await fetch(`${API_BASE}/auth/user`, {
    headers: {
      ...baseHeaders(),
      Authorization: `Basic ${basic}`,
      ...(prior.twoFactor ? { Cookie: `twoFactorAuth=${prior.twoFactor}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!authRes.ok) {
    const body = await authRes.text().catch(() => "");
    throw new Error(`VRChat login failed (${authRes.status}): ${body.slice(0, 200)}`);
  }
  const authCookie = readSetCookie(authRes.headers.getSetCookie?.() ?? [], "auth") ?? prior.auth;
  const data = (await authRes.json().catch(() => ({}))) as {
    requiresTwoFactorAuth?: string[];
    id?: string;
    displayName?: string;
  };
  const required = (data.requiresTwoFactorAuth ?? []).map((r) => r.toLowerCase());

  // No challenge — a remembered 2FA device (or a 2FA-free account) let us straight in.
  if (required.length === 0) {
    const res = await finalizeSession({ auth: authCookie, twoFactor: prior.twoFactor }, data);
    return { status: "connected", displayName: res.vrchatDisplayName };
  }

  // Authenticator challenge we CAN satisfy headlessly when a secret is configured.
  const totpSecret = process.env.VRCHAT_TOTP_SECRET;
  if ((required.includes("totp") || required.includes("otp")) && totpSecret) {
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
    if (verifyRes.ok) {
      const twoFactor = readSetCookie(verifyRes.headers.getSetCookie?.() ?? [], "twoFactorAuth");
      const res = await finalizeSession({ auth: authCookie, twoFactor }, data);
      return { status: "connected", displayName: res.vrchatDisplayName };
    }
    // Fall through to emailOtp if VRChat also offers it; else surface the error.
  }

  if (required.includes("emailotp")) {
    if (!authCookie) throw new Error("VRChat login did not return an auth cookie.");
    // VRChat already emailed the code as a side effect of the request above.
    await persistSession({ pendingAuthCookie: authCookie, lastError: null });
    return { status: "needs_email_code", displayName: null };
  }

  throw new Error(
    `VRChat requires 2FA (${required.join(", ")}) and no usable code source is configured for it.`,
  );
}

// Complete a manual login by submitting the 6-digit code VRChat emailed. Uses the
// auth cookie stashed by beginManualLogin and promotes the session on success.
export async function completeEmailOtpLogin(rawCode: string): Promise<ConnectResult> {
  const code = (rawCode ?? "").replace(/\D/g, "");
  if (code.length !== 6) {
    throw new Error("Enter the 6-digit code VRChat emailed you.");
  }
  const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
  const pending = row?.pendingAuthCookie ?? null;
  if (!pending) {
    throw new Error('No pending VRChat login — click "Connect" to request a fresh email code first.');
  }
  const verifyRes = await fetch(`${API_BASE}/auth/twofactorauth/emailotp/verify`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
      Cookie: `auth=${pending}`,
    },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!verifyRes.ok) {
    const body = await verifyRes.text().catch(() => "");
    throw new Error(
      `VRChat rejected that email code (${verifyRes.status}): ${body.slice(0, 150)}. Codes expire quickly — request a new one and try again.`,
    );
  }
  const twoFactor = readSetCookie(verifyRes.headers.getSetCookie?.() ?? [], "twoFactorAuth");
  const res = await finalizeSession({ auth: pending, twoFactor }, {});
  return { status: "connected", displayName: res.vrchatDisplayName };
}

// Session health for the staff control card. Never returns cookie values.
export interface VrchatSessionInfo {
  configured: boolean;
  connected: boolean;
  pending: boolean;
  displayName: string | null;
  lastAuthAt: string | null;
  lastError: string | null;
}

export async function getSessionInfo(): Promise<VrchatSessionInfo> {
  const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
  return {
    configured: vrchatCredsConfigured(),
    connected: !!row?.authCookie,
    pending: !!row?.pendingAuthCookie,
    displayName: row?.vrchatDisplayName ?? null,
    lastAuthAt: row?.lastAuthAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
  };
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
