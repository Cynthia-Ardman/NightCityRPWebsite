// getRedirectUri host-awareness. In production the OAuth state nonce lives in
// a session cookie scoped to the host the user is browsing on, so the Discord
// round-trip must stay on that SAME host (apex, www, or the replit.app
// domain) — but only for allowlisted hosts, since the Host header is
// client-controlled and echoing arbitrary hosts would be an open redirect.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRedirectUri } from "./discord";

const ENV_KEYS = [
  "REPLIT_DEPLOYMENT",
  "PUBLIC_BASE_URL",
  "REPLIT_DOMAINS",
  "REPLIT_DEV_DOMAIN",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.REPLIT_DEPLOYMENT = "1";
  process.env.PUBLIC_BASE_URL = "https://nightcityroleplay.com";
  process.env.REPLIT_DOMAINS = "night-city-interface.replit.app";
  delete process.env.REPLIT_DEV_DOMAIN;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getRedirectUri (deployment)", () => {
  it("defaults to the pinned PUBLIC_BASE_URL when no request host is given", () => {
    expect(getRedirectUri()).toBe(
      "https://nightcityroleplay.com/api/auth/discord/callback",
    );
  });

  it("echoes the apex host", () => {
    expect(getRedirectUri("nightcityroleplay.com")).toBe(
      "https://nightcityroleplay.com/api/auth/discord/callback",
    );
  });

  it("keeps the round-trip on the www variant of the pinned host", () => {
    expect(getRedirectUri("www.nightcityroleplay.com")).toBe(
      "https://www.nightcityroleplay.com/api/auth/discord/callback",
    );
  });

  it("keeps the round-trip on a REPLIT_DOMAINS host (replit.app)", () => {
    expect(getRedirectUri("night-city-interface.replit.app")).toBe(
      "https://night-city-interface.replit.app/api/auth/discord/callback",
    );
  });

  it("is case-insensitive on the request host", () => {
    expect(getRedirectUri("WWW.NightCityRoleplay.com")).toBe(
      "https://www.nightcityroleplay.com/api/auth/discord/callback",
    );
  });

  it("falls back to the pinned base URL for a non-allowlisted host (no open redirect)", () => {
    expect(getRedirectUri("evil.example.com")).toBe(
      "https://nightcityroleplay.com/api/auth/discord/callback",
    );
  });

  it("ignores the request host outside deployments (dev uses the workspace domain)", () => {
    process.env.REPLIT_DEPLOYMENT = "0";
    process.env.REPLIT_DEV_DOMAIN = "my-workspace.dev.replit.dev";
    expect(getRedirectUri("nightcityroleplay.com")).toBe(
      "https://my-workspace.dev.replit.dev/api/auth/discord/callback",
    );
  });
});
