import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "../test/app";

const app = buildTestApp();

describe("GET /healthz", () => {
  it("returns 200 with status ok and needs no auth", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
