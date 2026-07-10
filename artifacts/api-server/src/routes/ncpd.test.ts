import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();

// Role markers as injected by applyRoleIdGrants for the id-pinned Discord
// roles (see lib/discord.ts ROLE_NAMES.NCPD / NCPD_COMMISSIONER).
const OFFICER = ["ncpd-officer"];
const COMMISSIONER = ["ncpd-commissioner"];

const createOfficer = () => createUser({ roles: OFFICER });
const createCommissioner = () => createUser({ roles: COMMISSIONER });
const createFixer = () => createUser({ roles: ["fixer"] });

describe("NCPD access gating", () => {
  it("blocks plain players from every records surface (403)", async () => {
    const player = await createUser();
    const c = await createCharacter();
    for (const [method, url] of [
      ["get", "/api/ncpd/characters?q=ab"],
      ["get", `/api/ncpd/characters/${c.id}/record`],
      ["get", "/api/ncpd/reports"],
      ["get", "/api/ncpd/warrants"],
    ] as const) {
      const res = await request(app)[method](url).set("x-test-user", player.id);
      expect(res.status, url).toBe(403);
    }
    const post = await request(app)
      .post("/api/ncpd/reports")
      .set("x-test-user", player.id)
      .send({ characterId: c.id, title: "t", body: "b" });
    expect(post.status).toBe(403);
  });

  it("does NOT let a character's owner read their own record", async () => {
    const owner = await createUser();
    const c = await createCharacter({ ownerId: owner.id });
    const res = await request(app).get(`/api/ncpd/characters/${c.id}/record`).set("x-test-user", owner.id);
    expect(res.status).toBe(403);
  });

  it("requires authentication (401)", async () => {
    const res = await request(app).get("/api/ncpd/laws");
    expect(res.status).toBe(401);
  });

  it("lets fixers and admins through the records gate", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();
    const c = await createCharacter();
    for (const u of [fixer, admin]) {
      const res = await request(app).get(`/api/ncpd/characters/${c.id}/record`).set("x-test-user", u.id);
      expect(res.status).toBe(200);
    }
  });
});

describe("NCPD character lookup", () => {
  it("finds characters by name and by character number", async () => {
    const officer = await createOfficer();
    const c = await createCharacter({ name: "Johnny Silverhand" });
    const byName = await request(app).get("/api/ncpd/characters?q=silverhand").set("x-test-user", officer.id);
    expect(byName.status).toBe(200);
    expect(byName.body.map((r: { id: number }) => r.id)).toContain(c.id);

    const byId = await request(app).get(`/api/ncpd/characters?q=${c.id}`).set("x-test-user", officer.id);
    expect(byId.status).toBe(200);
    expect(byId.body.map((r: { id: number }) => r.id)).toContain(c.id);
  });

  it("returns the full record: identity + reports + warrants + notes", async () => {
    const officer = await createOfficer();
    const c = await createCharacter({ name: "Rogue" });
    await request(app)
      .post("/api/ncpd/reports")
      .set("x-test-user", officer.id)
      .send({ characterId: c.id, title: "Bar fight", body: "Afterlife incident", charges: "Assault" });
    await request(app)
      .post("/api/ncpd/warrants")
      .set("x-test-user", officer.id)
      .send({ characterId: c.id, reason: "Failure to appear" });
    await request(app)
      .post(`/api/ncpd/characters/${c.id}/notes`)
      .set("x-test-user", officer.id)
      .send({ note: "Known associate of Silverhand" });

    const res = await request(app).get(`/api/ncpd/characters/${c.id}/record`).set("x-test-user", officer.id);
    expect(res.status).toBe(200);
    expect(res.body.character).toMatchObject({ id: c.id, name: "Rogue" });
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({ title: "Bar fight", charges: "Assault" });
    expect(res.body.warrants).toHaveLength(1);
    expect(res.body.warrants[0]).toMatchObject({ reason: "Failure to appear", status: "open" });
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({ note: "Known associate of Silverhand" });
  });

  it("404s on a missing character", async () => {
    const officer = await createOfficer();
    const res = await request(app).get("/api/ncpd/characters/999999/record").set("x-test-user", officer.id);
    expect(res.status).toBe(404);
  });
});

describe("NCPD reports CRUD", () => {
  it("officer can file, edit and delete a report", async () => {
    const officer = await createOfficer();
    const c = await createCharacter();
    const created = await request(app)
      .post("/api/ncpd/reports")
      .set("x-test-user", officer.id)
      .send({ characterId: c.id, title: "Theft", body: "Stole a Quadra" });
    expect(created.status).toBe(201);
    expect(created.body.officerName).toBe(officer.username);

    const patched = await request(app)
      .patch(`/api/ncpd/reports/${created.body.id}`)
      .set("x-test-user", officer.id)
      .send({ charges: "Grand theft auto" });
    expect(patched.status).toBe(200);
    expect(patched.body.charges).toBe("Grand theft auto");
    expect(patched.body.title).toBe("Theft");

    const list = await request(app).get("/api/ncpd/reports").set("x-test-user", officer.id);
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ id: created.body.id, characterName: c.name });

    const del = await request(app).delete(`/api/ncpd/reports/${created.body.id}`).set("x-test-user", officer.id);
    expect(del.status).toBe(200);
    const after = await request(app).get(`/api/ncpd/characters/${c.id}/record`).set("x-test-user", officer.id);
    expect(after.body.reports).toHaveLength(0);
  });

  it("rejects a report without title/body (400) and unknown character (404)", async () => {
    const officer = await createOfficer();
    const c = await createCharacter();
    const bad = await request(app)
      .post("/api/ncpd/reports")
      .set("x-test-user", officer.id)
      .send({ characterId: c.id, title: "  ", body: "" });
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .post("/api/ncpd/reports")
      .set("x-test-user", officer.id)
      .send({ characterId: 999999, title: "t", body: "b" });
    expect(missing.status).toBe(404);
  });
});

describe("NCPD warrants", () => {
  it("issues, transitions and deletes a warrant", async () => {
    const officer = await createOfficer();
    const c = await createCharacter();
    const created = await request(app)
      .post("/api/ncpd/warrants")
      .set("x-test-user", officer.id)
      .send({ characterId: c.id, reason: "Cyberpsychosis incident" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("open");

    const served = await request(app)
      .patch(`/api/ncpd/warrants/${created.body.id}`)
      .set("x-test-user", officer.id)
      .send({ status: "served" });
    expect(served.status).toBe(200);
    expect(served.body.status).toBe("served");

    const badStatus = await request(app)
      .patch(`/api/ncpd/warrants/${created.body.id}`)
      .set("x-test-user", officer.id)
      .send({ status: "expired" });
    expect(badStatus.status).toBe(400);

    const filtered = await request(app).get("/api/ncpd/warrants?status=open").set("x-test-user", officer.id);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(0);

    const del = await request(app).delete(`/api/ncpd/warrants/${created.body.id}`).set("x-test-user", officer.id);
    expect(del.status).toBe(200);
  });
});

describe("NCPD notes", () => {
  it("adds and deletes a note", async () => {
    const officer = await createOfficer();
    const c = await createCharacter();
    const created = await request(app)
      .post(`/api/ncpd/characters/${c.id}/notes`)
      .set("x-test-user", officer.id)
      .send({ note: "Frequents Lizzie's Bar" });
    expect(created.status).toBe(201);
    expect(created.body.authorName).toBe(officer.username);

    const del = await request(app).delete(`/api/ncpd/notes/${created.body.id}`).set("x-test-user", officer.id);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
  });
});

describe("Book of Laws", () => {
  it("strips restricted fields for plain players but returns them to officers", async () => {
    const commissioner = await createCommissioner();
    const created = await request(app)
      .post("/api/ncpd/laws")
      .set("x-test-user", commissioner.id)
      .send({
        title: "No flying vehicles below 100m",
        body: "Keep your AV above the skyline.",
        severity: "misdemeanor",
        punishment: "500 eddie fine",
        restrictedNotes: "Usually waived for Trauma Team",
      });
    expect(created.status).toBe(201);

    const player = await createUser();
    const publicView = await request(app).get("/api/ncpd/laws").set("x-test-user", player.id);
    expect(publicView.status).toBe(200);
    expect(publicView.body).toHaveLength(1);
    expect(publicView.body[0].title).toBe("No flying vehicles below 100m");
    expect(publicView.body[0]).not.toHaveProperty("severity");
    expect(publicView.body[0]).not.toHaveProperty("punishment");
    expect(publicView.body[0]).not.toHaveProperty("restrictedNotes");

    const officer = await createOfficer();
    const privileged = await request(app).get("/api/ncpd/laws").set("x-test-user", officer.id);
    expect(privileged.status).toBe(200);
    expect(privileged.body[0]).toMatchObject({
      severity: "misdemeanor",
      punishment: "500 eddie fine",
      restrictedNotes: "Usually waived for Trauma Team",
    });
  });

  it("blocks rank-and-file officers and players from writing laws (403)", async () => {
    const officer = await createOfficer();
    const player = await createUser();
    for (const u of [officer, player]) {
      const res = await request(app)
        .post("/api/ncpd/laws")
        .set("x-test-user", u.id)
        .send({ title: "Test", body: "Test" });
      expect(res.status).toBe(403);
    }
  });

  it("lets commissioner, fixer and admin write laws", async () => {
    const commissioner = await createCommissioner();
    const fixer = await createFixer();
    const admin = await createAdmin();
    for (const u of [commissioner, fixer, admin]) {
      const res = await request(app)
        .post("/api/ncpd/laws")
        .set("x-test-user", u.id)
        .send({ title: `Law by ${u.username}`, body: "Body text" });
      expect(res.status).toBe(201);
    }
  });

  it("validates severity and supports edit + delete", async () => {
    const commissioner = await createCommissioner();
    const bad = await request(app)
      .post("/api/ncpd/laws")
      .set("x-test-user", commissioner.id)
      .send({ title: "T", body: "B", severity: "capital" });
    expect(bad.status).toBe(400);

    const created = await request(app)
      .post("/api/ncpd/laws")
      .set("x-test-user", commissioner.id)
      .send({ title: "Original", body: "B" });
    const patched = await request(app)
      .patch(`/api/ncpd/laws/${created.body.id}`)
      .set("x-test-user", commissioner.id)
      .send({ severity: "felony", punishment: "Jail" });
    expect(patched.status).toBe(200);
    expect(patched.body.severity).toBe("felony");

    const del = await request(app).delete(`/api/ncpd/laws/${created.body.id}`).set("x-test-user", commissioner.id);
    expect(del.status).toBe(200);

    const player = await createUser();
    const cannotDelete = await request(app).delete("/api/ncpd/laws/1").set("x-test-user", player.id);
    expect(cannotDelete.status).toBe(403);
  });
});
