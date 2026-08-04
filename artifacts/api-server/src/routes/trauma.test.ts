import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock only the Discord side-effects: the raw role-id lookup (subscription
// gate), the responder scan, and the DM send. Everything else stays real.
vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    fetchGuildMemberRoleIdsViaBot: vi.fn(),
    listGuildMembersWithRole: vi.fn(),
    sendDirectMessage: vi.fn(),
  };
});

import {
  fetchGuildMemberRoleIdsViaBot,
  listGuildMembersWithRole,
  sendDirectMessage,
} from "../lib/discord";
import { db, characters } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";
import { TRAUMA_TIER_ROLES } from "./trauma";

const app = buildTestApp();
const mockRoleIds = vi.mocked(fetchGuildMemberRoleIdsViaBot);
const mockScan = vi.mocked(listGuildMembersWithRole);
const mockDm = vi.mocked(sendDirectMessage);

const GOLD = TRAUMA_TIER_ROLES.find((t) => t.tier === "Gold")!.id;
const DIAMOND = TRAUMA_TIER_ROLES.find((t) => t.tier === "Diamond")!.id;

async function makeChar(ownerId: string, name: string): Promise<number> {
  const [row] = await db
    .insert(characters)
    .values({ name, kind: "pc", ownerId, claimed: true })
    .returning({ id: characters.id });
  return row.id;
}

beforeEach(() => {
  mockRoleIds.mockReset();
  mockScan.mockReset();
  mockDm.mockReset();
});

describe("GET /trauma/status", () => {
  it("reports the best held tier", async () => {
    const u = await createUser({ roles: [] });
    mockRoleIds.mockResolvedValue([GOLD, DIAMOND, "999"]);
    const res = await request(app).get("/api/trauma/status").set("x-test-user", u.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: true, tier: "Diamond", determined: true });
  });

  it("is ineligible without a tier role, undetermined on lookup failure", async () => {
    const u = await createUser({ roles: [] });
    mockRoleIds.mockResolvedValue(["999"]);
    let res = await request(app).get("/api/trauma/status").set("x-test-user", u.id);
    expect(res.body).toEqual({ eligible: false, tier: null, determined: true });
    mockRoleIds.mockResolvedValue(null);
    res = await request(app).get("/api/trauma/status").set("x-test-user", u.id);
    expect(res.body).toEqual({ eligible: false, tier: null, determined: false });
  });
});

describe("POST /trauma/call", () => {
  it("403s without a subscription role", async () => {
    const u = await createUser({ roles: [] });
    const cid = await makeChar(u.id, "NoSub");
    mockRoleIds.mockResolvedValue([]);
    const res = await request(app)
      .post("/api/trauma/call")
      .set("x-test-user", u.id)
      .send({ characterId: cid });
    expect(res.status).toBe(403);
    expect(mockDm).not.toHaveBeenCalled();
  });

  it("404s on someone else's character", async () => {
    const u = await createUser({ roles: [] });
    const other = await createUser({ roles: [] });
    const cid = await makeChar(other.id, "NotMine");
    mockRoleIds.mockResolvedValue([GOLD]);
    const res = await request(app)
      .post("/api/trauma/call")
      .set("x-test-user", u.id)
      .send({ characterId: cid });
    expect(res.status).toBe(404);
    expect(mockDm).not.toHaveBeenCalled();
  });

  it("DMs every responder with character, caller, and tier; then rate-limits", async () => {
    const u = await createUser({ roles: [] });
    const cid = await makeChar(u.id, "Vera Chrome");
    mockRoleIds.mockResolvedValue([GOLD]);
    mockScan.mockResolvedValue({
      holders: [
        { id: "111", username: "medic1", globalName: null, avatarUrl: null },
        { id: "222", username: "medic2", globalName: null, avatarUrl: null },
      ],
      truncated: false,
    });
    mockDm.mockResolvedValueOnce("m1").mockResolvedValueOnce(null); // one closed-DM miss
    const res = await request(app)
      .post("/api/trauma/call")
      .set("x-test-user", u.id)
      .send({ characterId: cid });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tier: "Gold", responders: 2, notified: 1 });
    expect(mockDm).toHaveBeenCalledTimes(2);
    const msg = mockDm.mock.calls[0][1];
    expect(msg).toContain("Vera Chrome");
    expect(msg).toContain(`<@${u.discordId}>`);
    expect(msg).toContain("Gold");

    // Immediate second call is throttled.
    const again = await request(app)
      .post("/api/trauma/call")
      .set("x-test-user", u.id)
      .send({ characterId: cid });
    expect(again.status).toBe(429);
    expect(mockDm).toHaveBeenCalledTimes(2);
  });

  it("502s (and keeps the cooldown unburned) when the responder scan fails", async () => {
    const u = await createUser({ roles: [] });
    const cid = await makeChar(u.id, "ScanFail");
    mockRoleIds.mockResolvedValue([GOLD]);
    mockScan.mockResolvedValueOnce(null);
    let res = await request(app)
      .post("/api/trauma/call")
      .set("x-test-user", u.id)
      .send({ characterId: cid });
    expect(res.status).toBe(502);

    // Retry immediately succeeds — the failed attempt didn't consume the cooldown.
    mockScan.mockResolvedValueOnce({
      holders: [{ id: "111", username: "medic1", globalName: null, avatarUrl: null }],
      truncated: false,
    });
    mockDm.mockResolvedValue("m1");
    res = await request(app)
      .post("/api/trauma/call")
      .set("x-test-user", u.id)
      .send({ characterId: cid });
    expect(res.status).toBe(200);
  });
});
