import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

// The object-storage client talks to Replit App Storage over the network. We
// stub the whole module so the route's request-validation, auth gating, and
// client-facing path-rewrite logic can be exercised hermetically. The spies are
// created via vi.hoisted so they exist before the mocked class is instantiated
// at import time (eventsService news up ObjectStorageService on load).
const { getUploadURL, normalizePath } = vi.hoisted(() => ({
  getUploadURL: vi.fn(),
  normalizePath: vi.fn(),
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    getObjectEntityUploadURL = getUploadURL;
    normalizeObjectEntityPath = normalizePath;
  },
  ObjectNotFoundError: class extends Error {},
}));
vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read", WRITE: "write" },
  getObjectAclPolicy: vi.fn(),
}));

const app = buildTestApp();

beforeEach(() => {
  getUploadURL.mockReset();
  normalizePath.mockReset();
});

describe("POST /storage/uploads/request-url", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app)
      .post("/api/storage/uploads/request-url")
      .send({ name: "a.png", size: 10, contentType: "image/png" });
    expect(res.status).toBe(401);
    expect(getUploadURL).not.toHaveBeenCalled();
  });

  it("400s on a missing/invalid body", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/storage/uploads/request-url")
      .set("x-test-user", user.id)
      .send({ name: "", size: 0 });
    expect(res.status).toBe(400);
    expect(getUploadURL).not.toHaveBeenCalled();
  });

  it("rewrites a bare /objects/ path to the client-facing /api/storage prefix", async () => {
    const user = await createUser();
    getUploadURL.mockResolvedValue("https://signed.example/upload?token=x");
    normalizePath.mockReturnValue("/objects/uploads/abc123");

    const res = await request(app)
      .post("/api/storage/uploads/request-url")
      .set("x-test-user", user.id)
      .send({ name: "portrait.png", size: 2048, contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.uploadURL).toBe("https://signed.example/upload?token=x");
    expect(res.body.objectPath).toBe("/api/storage/objects/uploads/abc123");
  });

  it("500s when the storage client throws", async () => {
    const user = await createUser();
    getUploadURL.mockRejectedValue(new Error("storage down"));
    const res = await request(app)
      .post("/api/storage/uploads/request-url")
      .set("x-test-user", user.id)
      .send({ name: "x.png", size: 1, contentType: "image/png" });
    expect(res.status).toBe(500);
  });
});
