import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Control the Discord side-effects of the Become-an-NPC flow without ever
// touching the real Discord API. We keep every other export real (notably the
// NPC_ROLE_ID constant the route checks against) and only override the three
// functions the npc-role endpoints call: the role-id lookup and the
// grant/remove writes. See memory: missions.test mocks discord the same way.
vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    fetchGuildMemberRoleIdsViaBot: vi.fn(),
    addGuildMemberRole: vi.fn(),
    removeGuildMemberRole: vi.fn(),
  };
});

import {
  fetchGuildMemberRoleIdsViaBot,
  addGuildMemberRole,
  removeGuildMemberRole,
  NPC_ROLE_ID,
} from "../lib/discord";
import { db, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

const app = buildTestApp();
const mockRoleIds = vi.mocked(fetchGuildMemberRoleIdsViaBot);
const mockAdd = vi.mocked(addGuildMemberRole);
const mockRemove = vi.mocked(removeGuildMemberRole);

// The clear error the route relays as a 502 when externalWritesAllowed() is
// false (the community test site). Mirrors the string the real lib returns.
const SUPPRESSED_ERROR =
  "External Discord writes are disabled in this (test) environment";

// The npc-role routes write their audit row fire-and-forget (`void
// recordAudit(...)`), so the insert can land just after the HTTP response.
// Poll briefly for it instead of reading once and racing the write.
async function waitForAudit(action: string) {
  let rows = await db.select().from(auditLog).where(eq(auditLog.action, action));
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    rows = await db.select().from(auditLog).where(eq(auditLog.action, action));
  }
  return rows;
}

beforeEach(() => {
  mockRoleIds.mockReset();
  mockAdd.mockReset();
  mockRemove.mockReset();
});

describe("GET /auth/npc-role", () => {
  it("401s when not authenticated", async () => {
    const res = await request(app).get("/api/auth/npc-role");
    expect(res.status).toBe(401);
    expect(mockRoleIds).not.toHaveBeenCalled();
  });

  it("reports determined:true, hasRole:false when the role is absent", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue(["999"]);
    const res = await request(app)
      .get("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasRole: false, determined: true });
    expect(mockRoleIds).toHaveBeenCalledWith(user.discordId);
  });

  it("reports hasRole:true when the member holds the NPC role", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([NPC_ROLE_ID, "999"]);
    const res = await request(app)
      .get("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasRole: true, determined: true });
  });

  it("reports determined:false when the bot lookup fails", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasRole: false, determined: false });
  });
});

describe("POST /auth/npc-role", () => {
  it("401s when not authenticated", async () => {
    const res = await request(app).post("/api/auth/npc-role");
    expect(res.status).toBe(401);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("short-circuits without calling Discord when the role is already held", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([NPC_ROLE_ID]);
    const res = await request(app)
      .post("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hasRole: true });
    expect(mockAdd).not.toHaveBeenCalled();
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "npc_role_grant"));
    expect(audits).toHaveLength(0);
  });

  it("502s with a clear error when external writes are suppressed", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([]);
    mockAdd.mockResolvedValue({ ok: false, error: SUPPRESSED_ERROR });
    const res = await request(app)
      .post("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: SUPPRESSED_ERROR });
    expect(mockAdd).toHaveBeenCalledWith(user.discordId, NPC_ROLE_ID);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "npc_role_grant"));
    expect(audits).toHaveLength(0);
  });

  it("grants the role and writes an audit row on success", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([]);
    mockAdd.mockResolvedValue({ ok: true });
    const res = await request(app)
      .post("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hasRole: true });
    expect(mockAdd).toHaveBeenCalledWith(user.discordId, NPC_ROLE_ID);
    const audits = await waitForAudit("npc_role_grant");
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(user.id);
  });

  it("proceeds to grant even when the pre-check lookup fails (null)", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue(null);
    mockAdd.mockResolvedValue({ ok: true });
    const res = await request(app)
      .post("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hasRole: true });
    expect(mockAdd).toHaveBeenCalledWith(user.discordId, NPC_ROLE_ID);
  });
});

describe("DELETE /auth/npc-role", () => {
  it("short-circuits without calling Discord when the role is absent", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([]);
    const res = await request(app)
      .delete("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hasRole: false });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("502s with a clear error when external writes are suppressed", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([NPC_ROLE_ID]);
    mockRemove.mockResolvedValue({ ok: false, error: SUPPRESSED_ERROR });
    const res = await request(app)
      .delete("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: SUPPRESSED_ERROR });
    expect(mockRemove).toHaveBeenCalledWith(user.discordId, NPC_ROLE_ID);
  });

  it("removes the role and writes an audit row on success", async () => {
    const user = await createUser();
    mockRoleIds.mockResolvedValue([NPC_ROLE_ID]);
    mockRemove.mockResolvedValue({ ok: true });
    const res = await request(app)
      .delete("/api/auth/npc-role")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hasRole: false });
    expect(mockRemove).toHaveBeenCalledWith(user.discordId, NPC_ROLE_ID);
    const audits = await waitForAudit("npc_role_remove");
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(user.id);
  });
});
