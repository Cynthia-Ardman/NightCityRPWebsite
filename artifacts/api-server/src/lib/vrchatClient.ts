import crypto from "node:crypto";
import { db, vrchatSessions, users } from "@workspace/db";
import { and, eq, or, isNull, sql, arrayOverlaps } from "drizzle-orm";
import { logger } from "./logger";
import { ROLE_NAMES, sendDirectMessage } from "./discord";
import { createNotification } from "./notifications";
import { recordAudit } from "./audit";

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
  // A fresh session ends the current "disconnected episode": clear the episode
  // marker and the notify stamp so a FUTURE disconnect starts a fresh grace
  // window and can alert again without waiting out the previous cooldown.
  await persistSession({ disconnectedSince: null, lastDisconnectNotifyAt: null });
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

// Session-expiry handling. VRChat forces email-OTP for logins from datacenter
// IPs, so an unattended username/password re-login can NEVER succeed from this
// server — worse, repeated attempts trip VRChat's per-network failed-login
// limiter (429 "too many failed login attempts from network"), which then
// blocks even the manual staff reconnect flow for hours. So on a 401 we do NOT
// retry with login(); we clear the dead auth cookie (flipping the card to
// "not connected") and surface a reconnect instruction.
export const SESSION_EXPIRED_MSG =
  "VRChat session expired — a staff member must reconnect via System Admin → VRChat (Connect + email code).";

async function markSessionExpired(context: string, staleAuth: string | null): Promise<void> {
  // Keep the twoFactorAuth cookie: a remembered 2FA device can make the next
  // manual reconnect skip the challenge. Only the auth cookie is dead.
  //
  // Compare-and-set on the exact cookie this request saw fail: a concurrent
  // caller (or the auto-reconnect) may have already replaced the cookie with a
  // fresh one, and a stale in-flight 401 must never clobber that new session.
  const result = await db
    .update(vrchatSessions)
    .set({
      authCookie: null,
      lastError: `${SESSION_EXPIRED_MSG} (401 on ${context} at ${new Date().toISOString()})`.slice(0, 500),
    })
    .where(
      staleAuth === null
        ? eq(vrchatSessions.id, SESSION_ID)
        : and(eq(vrchatSessions.id, SESSION_ID), eq(vrchatSessions.authCookie, staleAuth)),
    )
    .returning({ id: vrchatSessions.id });
  if (result.length === 0) {
    logger.info({ context }, "VRChat 401 on a stale cookie; a newer session already exists — not expiring");
    return;
  }
  logger.warn({ context }, "VRChat session marked expired");
  // Surface the disconnect in the staff audit log (fire-and-forget; system actor).
  void recordAudit({
    category: "admin",
    action: "vrchat.session_expired",
    actorName: "system",
    targetType: "vrchat_session",
    targetId: SESSION_ID,
    message: `VRChat session disconnected (401 on ${context}); manual reconnect may be required.`,
  });
}

// A lone 401 from one endpoint is not proof the cookie is dead — VRChat
// occasionally returns transient 401s under rate-limit/CDN hiccups, and the
// 2-minute poller turns any such blip into a forced manual reconnect. Before
// discarding the cookie, confirm it is really dead against /auth/user. If the
// confirm call itself errors (network), treat the 401 as transient and keep
// the session.
async function confirmCookieDead(cookies: SessionCookies): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/user`, {
      headers: { ...baseHeaders(), Cookie: cookieHeader(cookies) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return true;
    if (res.ok) {
      // Cookie still valid; VRChat may require 2FA re-verify (body has
      // requiresTwoFactorAuth) but the auth cookie itself lives.
      return false;
    }
    return false; // 5xx/429 etc — inconclusive, keep the session
  } catch {
    return false; // network error — inconclusive, keep the session
  }
}

// VRChat rotates/refreshes cookies via Set-Cookie on ordinary API responses.
// Persist any rotation so the stored session tracks the live one instead of
// going stale and eventually 401ing.
async function captureRotatedCookies(res: Response, prior: SessionCookies): Promise<void> {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return;
  const auth = readSetCookie(setCookies, "auth");
  const twoFactor = readSetCookie(setCookies, "twoFactorAuth");
  const patch: Partial<typeof vrchatSessions.$inferInsert> = {};
  if (auth && auth !== prior.auth) patch.authCookie = auth;
  if (twoFactor && twoFactor !== prior.twoFactor) patch.twoFactorCookie = twoFactor;
  if (Object.keys(patch).length > 0) {
    await persistSession(patch);
    logger.info("VRChat session cookies rotated");
  }
}

// When the cookie is confirmed dead, try ONE unattended reconnect using the
// remembered twoFactorAuth cookie (beginManualLogin's no-challenge path — the
// same thing a staff member's single "Connect" click does when no email code
// is asked). Cooldown-guarded so a broken password / revoked 2FA device can't
// hammer VRChat's per-network failed-login limiter; if VRChat demands a code
// we fall back to marking the session expired for a manual reconnect (the
// code email is already on its way, so the staff click is one paste away).
const AUTO_RECONNECT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAutoReconnectAt = 0;

/** Test-only: clear the auto-reconnect cooldown between test cases. */
export function __resetAutoReconnectCooldownForTests(): void {
  lastAutoReconnectAt = 0;
}

async function tryAutoReconnect(context: string): Promise<boolean> {
  const nowMs = Date.now();
  if (nowMs - lastAutoReconnectAt < AUTO_RECONNECT_COOLDOWN_MS) return false;
  lastAutoReconnectAt = nowMs;
  try {
    const res = await beginManualLogin();
    if (res.status === "connected") {
      logger.info({ context }, "VRChat session auto-reconnected via remembered 2FA device");
      void recordAudit({
        category: "admin",
        action: "vrchat.session_auto_reconnected",
        actorName: "system",
        targetType: "vrchat_session",
        targetId: SESSION_ID,
        message: `VRChat session auto-reconnected via remembered 2FA device (${context}).`,
      });
      return true;
    }
    logger.warn({ context }, "VRChat auto-reconnect needs an email code; leaving for manual reconnect");
    return false;
  } catch (err) {
    logger.warn({ context, err }, "VRChat auto-reconnect attempt failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session maintenance + admin alerting. The instance-poll cron calls
// maintainVrchatSession() every cycle: while the session is healthy it is a
// no-op; when the auth cookie is gone it retries the same one-click reconnect
// a staff member would perform (remembered 2FA device, no email code), and if
// that genuinely needs a human it alerts every admin ONCE per disconnected
// episode (bell notification + Discord DM) instead of failing silently until
// someone happens to open the System Admin card.
// ---------------------------------------------------------------------------
const DISCONNECT_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// Grace window before paging admins: the session must have been down this long
// before an alert goes out. With the 15-minute auto-reconnect cooldown this
// guarantees at least TWO unattended reconnect attempts happen first, so a
// transient VRChat-side blip that self-heals within minutes never pages anyone.
const DISCONNECT_ALERT_GRACE_MS = 20 * 60 * 1000;

export async function maintainVrchatSession(): Promise<boolean> {
  if (!vrchatCredsConfigured()) return false;
  const cookies = await loadSession();
  if (cookies.auth) return true;
  // Mark the start of the disconnected episode (first tick that sees it down).
  // Conditional so later ticks / concurrent instances never move the start.
  await db
    .update(vrchatSessions)
    .set({ disconnectedSince: new Date() })
    .where(and(eq(vrchatSessions.id, SESSION_ID), isNull(vrchatSessions.disconnectedSince)));
  if (await tryAutoReconnect("session_maintenance")) return true;
  void notifyAdminsVrchatDisconnected();
  return false;
}

async function notifyAdminsVrchatDisconnected(): Promise<void> {
  // Our claim's exact stamp (as stored in the DB), so the failure path can
  // release ONLY this invocation's claim and never a concurrent one's.
  let claimStamp: Date | null = null;
  try {
    const now = new Date();
    const [row] = await db
      .select({
        lastError: vrchatSessions.lastError,
        disconnectedSince: vrchatSessions.disconnectedSince,
      })
      .from(vrchatSessions)
      .where(eq(vrchatSessions.id, SESSION_ID));
    // Still inside the grace window — keep retrying quietly, don't page anyone.
    const since = row?.disconnectedSince;
    if (!since || now.getTime() - since.getTime() < DISCONNECT_ALERT_GRACE_MS) return;
    // Claim the alert with a conditional UPDATE on the persisted notify stamp,
    // so overlapping cron ticks or multiple server instances can't each fire
    // their own copy of the alert (only one claimer wins per 12h window).
    const claimed = await db
      .update(vrchatSessions)
      .set({ lastDisconnectNotifyAt: now })
      .where(
        and(
          eq(vrchatSessions.id, SESSION_ID),
          or(
            isNull(vrchatSessions.lastDisconnectNotifyAt),
            sql`${vrchatSessions.lastDisconnectNotifyAt} < ${new Date(now.getTime() - DISCONNECT_NOTIFY_COOLDOWN_MS)}`,
          ),
        ),
      )
      .returning({ lastDisconnectNotifyAt: vrchatSessions.lastDisconnectNotifyAt });
    if (claimed.length === 0) return; // already alerted this episode/window
    claimStamp = claimed[0]?.lastDisconnectNotifyAt ?? now;
    const downMinutes = Math.round((now.getTime() - since.getTime()) / 60_000);
    const detail = row?.lastError ? ` Last error: ${row.lastError}` : "";
    const title = "VRChat session disconnected";
    const body = `The VRChat session has been down for ~${downMinutes} minutes and automatic reconnect attempts could not restore it — it needs a manual reconnect in System Admin → VRChat.${detail}`;
    const admins = await db
      .select({ id: users.id, discordId: users.discordId })
      .from(users)
      .where(arrayOverlaps(users.roles, ROLE_NAMES.ADMIN));
    for (const a of admins) {
      void createNotification({ userId: a.id, type: "vrchat_session", title, body, href: "/admin" });
      if (a.discordId) {
        // Best-effort; sendDirectMessage is deployment-gated internally.
        sendDirectMessage(a.discordId, `⚠️ ${title}\n${body}`).catch((err) =>
          logger.warn({ err }, "VRChat disconnect DM failed"),
        );
      }
    }
    logger.warn({ admins: admins.length }, "VRChat session disconnected — admins notified");
    void recordAudit({
      category: "admin",
      action: "vrchat.disconnect_alert_sent",
      actorName: "system",
      targetType: "vrchat_session",
      targetId: SESSION_ID,
      message: `VRChat session disconnected — alerted ${admins.length} admin(s) (bell + DM).${detail}`,
    });
  } catch (err) {
    // Don't burn the cooldown on a transient failure (e.g. DB hiccup) — release
    // the claim so the next cron tick retries the alert instead of going silent
    // for 12h. Best-effort: if this too fails, the 12h window eventually clears.
    logger.warn({ err }, "VRChat disconnect admin notify failed");
    // Release ONLY our own claim (exact timestamp match) — a concurrent
    // invocation's valid claim must never be cleared by our failure, or the
    // dedupe guarantee breaks and duplicate alerts come back.
    if (claimStamp) {
      await db
        .update(vrchatSessions)
        .set({ lastDisconnectNotifyAt: null })
        .where(
          and(
            eq(vrchatSessions.id, SESSION_ID),
            eq(vrchatSessions.lastDisconnectNotifyAt, claimStamp),
          ),
        )
        .catch(() => {});
    }
  }
}

// Shared 401 handling for apiGet/apiSend: verify before discarding.
async function handleUnauthorized(cookies: SessionCookies, context: string): Promise<never> {
  if (await confirmCookieDead(cookies)) {
    if (await tryAutoReconnect(context)) {
      throw new Error(`VRChat ${context} hit an expired cookie — session auto-reconnected, will retry next cycle.`);
    }
    await markSessionExpired(context, cookies.auth);
    throw new Error(SESSION_EXPIRED_MSG);
  }
  logger.warn({ context }, "VRChat returned a transient 401; keeping session");
  throw new Error(`VRChat ${context} returned a transient 401 — session kept, will retry next cycle.`);
}

export async function vrchatSessionConnected(): Promise<boolean> {
  const cookies = await loadSession();
  return !!cookies.auth;
}

// Authenticated GET against the VRChat API. Uses stored cookies; a 401 marks
// the session expired (no unattended re-login — see SESSION_EXPIRED_MSG).
async function apiGet<T>(path: string): Promise<T> {
  const cookies = await loadSession();
  if (!cookies.auth) throw new Error(SESSION_EXPIRED_MSG);

  const doFetch = (c: SessionCookies) =>
    fetch(`${API_BASE}${path}`, {
      headers: { ...baseHeaders(), Cookie: cookieHeader(c) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  const res = await doFetch(cookies);
  if (res.status === 401) {
    await handleUnauthorized(cookies, `GET ${path}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`VRChat GET ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  await captureRotatedCookies(res, cookies);
  await persistSession({ lastAuthAt: new Date(), lastError: null });
  return (await res.json()) as T;
}

// Authenticated write (POST/PUT/DELETE) against the VRChat API. Mirrors apiGet:
// replays stored cookies, marks the session expired on a 401 (no unattended
// re-login). Returns parsed JSON (or null for empty bodies) and throws on any
// non-2xx so callers can persist the error. Body is JSON-encoded when present.
async function apiSend<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const cookies = await loadSession();
  if (!cookies.auth) throw new Error(SESSION_EXPIRED_MSG);

  const doFetch = (c: SessionCookies) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...baseHeaders(),
        Cookie: cookieHeader(c),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  const res = await doFetch(cookies);
  if (res.status === 401) {
    await handleUnauthorized(cookies, `${method} ${path}`);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`VRChat ${method} ${path} failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  await captureRotatedCookies(res, cookies);
  await persistSession({ lastAuthAt: new Date(), lastError: null });
  const text = await res.text().catch(() => "");
  return (text ? JSON.parse(text) : null) as T;
}

// --- Group calendar (VRChat 2025.3.1+) --------------------------------------
// The dedicated account must hold the group permission that allows creating /
// editing calendar entries, or these return 403. Rate-limited (~1 write/60s) —
// callers must space writes. Endpoints are unofficial and may change.
export interface VrchatCalendarInput {
  title: string;
  startsAt: string; // ISO 8601 UTC
  endsAt: string; // ISO 8601 UTC
  description?: string;
  category?: string;
  accessType?: "public" | "group" | "private";
  sendCreationNotification?: boolean;
}

interface VrchatCalendarEventResponse {
  id: string;
}

export async function createGroupCalendarEvent(
  input: VrchatCalendarInput,
  groupId: string = NCRP_GROUP_ID,
): Promise<string> {
  const res = await apiSend<VrchatCalendarEventResponse>(
    "POST",
    `/calendar/${groupId}/event`,
    input,
  );
  if (!res?.id) throw new Error("VRChat calendar create returned no event id");
  return res.id;
}

export async function updateGroupCalendarEvent(
  calendarId: string,
  input: VrchatCalendarInput,
  groupId: string = NCRP_GROUP_ID,
): Promise<void> {
  await apiSend<unknown>("PUT", `/calendar/${groupId}/${calendarId}/event`, input);
}

export async function deleteGroupCalendarEvent(
  calendarId: string,
  groupId: string = NCRP_GROUP_ID,
): Promise<void> {
  // NOTE: unlike create/update, VRChat's delete endpoint takes NO `/event`
  // suffix — `DELETE /calendar/{groupId}/{calendarId}`. With the suffix it
  // returns 405 Method Not Allowed.
  await apiSend<unknown>("DELETE", `/calendar/${groupId}/${calendarId}`);
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
  // Group role IDs allowed to join. VRChat only populates this for group
  // instances that were created with the "Group Roles" restriction; open
  // (public/plus) instances leave it empty/absent.
  roleIds?: string[];
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

interface RawGroupRole {
  id?: string;
  name?: string;
}

// Fetch the group's roles (id -> name). Used to translate an instance's opaque
// roleIds into human-readable role names for display.
export async function fetchGroupRoles(
  groupId: string = NCRP_GROUP_ID,
): Promise<RawGroupRole[]> {
  const data = await apiGet<RawGroupRole[]>(`/groups/${groupId}/roles`);
  return Array.isArray(data) ? data : [];
}

// Group roles change very rarely, so cache the id->name map in-memory with a
// short TTL to avoid hitting the rate-limited VRChat API on every poll.
const ROLE_MAP_TTL_MS = 30 * 60 * 1000;
let roleMapCache: { at: number; map: Map<string, string> } | null = null;

// Resolve the group's roles to an id->name Map (best-effort: returns the last
// good cache, or an empty map, if the fetch fails — callers fall back to
// showing nothing rather than failing the whole poll).
export async function getGroupRoleMap(
  groupId: string = NCRP_GROUP_ID,
): Promise<Map<string, string>> {
  const now = Date.now();
  if (roleMapCache && now - roleMapCache.at < ROLE_MAP_TTL_MS) {
    return roleMapCache.map;
  }
  try {
    const roles = await fetchGroupRoles(groupId);
    const map = new Map<string, string>();
    for (const r of roles) {
      if (r.id && r.name) map.set(r.id, r.name);
    }
    roleMapCache = { at: now, map };
    return map;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "VRChat group roles fetch failed; role names unavailable this poll",
    );
    return roleMapCache?.map ?? new Map<string, string>();
  }
}
