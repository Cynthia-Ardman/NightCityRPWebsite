import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, missions, loreEntries } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();

type Item = { href: string; name: string; staffOnly?: boolean };

describe("GET /search (site-wide command palette)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(app).get("/api/search?q=zeta");
    expect(res.status).toBe(401);
  });

  it("returns empty groups for queries under 2 characters", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/search?q=z").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body.characters).toEqual([]);
    expect(res.body.missions).toEqual([]);
    expect(res.body.ncpd).toEqual([]);
  });

  it("players search only their OWN characters, with player-openable hrefs", async () => {
    const user = await createUser();
    const mine = await createCharacter({ name: "Zeta Runner", ownerId: user.id });
    const other = await createCharacter({ name: "Zeta Stranger" });

    const res = await request(app).get("/api/search?q=Zeta").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    const hrefs = (res.body.characters as Item[]).map((c) => c.href);
    // Own character links to the player character page (the only one they can open).
    expect(hrefs).toContain(`/characters/${mine.id}`);
    // Someone else's character is not searchable for a plain player at all.
    expect(hrefs).toHaveLength(1);
    expect(JSON.stringify(hrefs)).not.toContain(String(other.id));
  });

  it("staff search the full roster with archive-detail hrefs", async () => {
    const admin = await createAdmin();
    const someoneElses = await createCharacter({ name: "Yotta Nomad" });
    const res = await request(app).get("/api/search?q=Yotta").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const hit = (res.body.characters as Item[]).find(
      (c) => c.href === `/directory/characters/${someoneElses.id}`,
    );
    expect(hit).toBeTruthy();
    expect(hit!.name).toBe("Yotta Nomad");
    // Non-owned rows are staffOnly so View-as-player can scrub them client-side.
    expect(hit!.staffOnly).toBe(true);

    // A character the admin OWNS is not staffOnly and uses the player href.
    const ownChar = await createCharacter({ name: "Yotta Own", ownerId: admin.id });
    const res2 = await request(app).get("/api/search?q=Yotta Own").set("x-test-user", admin.id);
    const own = (res2.body.characters as Item[]).find((c) => c.href === `/characters/${ownChar.id}`);
    expect(own).toBeTruthy();
    expect(own!.staffOnly).toBeFalsy();
  });

  it("players only see POSTED missions; managers see the whole pipeline flagged staffOnly", async () => {
    const player = await createUser();
    const admin = await createAdmin();
    const [posted] = await db
      .insert(missions)
      .values({ title: "Qwark Heist Posted", workflowState: "posted" })
      .returning();
    const [draft] = await db
      .insert(missions)
      .values({ title: "Qwark Heist Draft", workflowState: "draft" })
      .returning();

    const pres = await request(app).get("/api/search?q=Qwark").set("x-test-user", player.id);
    expect(pres.status).toBe(200);
    const phrefs = (pres.body.missions as Item[]).map((m) => m.href);
    expect(phrefs).toContain(`/missions/${posted.id}`);
    expect(phrefs).not.toContain(`/missions/${draft.id}`);

    const ares = await request(app).get("/api/search?q=Qwark").set("x-test-user", admin.id);
    const amissions = ares.body.missions as Item[];
    const adraft = amissions.find((m) => m.href === `/missions/${draft.id}`);
    const aposted = amissions.find((m) => m.href === `/missions/${posted.id}`);
    expect(adraft).toBeTruthy();
    expect(adraft!.staffOnly).toBe(true);
    expect(aposted!.staffOnly).toBe(false);
  });

  it("NCPD group is EMPTY for plain players and populated (staffOnly) for staff", async () => {
    const player = await createUser();
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Vexley Crumb" });

    const pres = await request(app).get("/api/search?q=Vexley").set("x-test-user", player.id);
    expect(pres.status).toBe(200);
    expect(pres.body.ncpd).toEqual([]);

    const ares = await request(app).get("/api/search?q=Vexley").set("x-test-user", admin.id);
    const hit = (ares.body.ncpd as Item[]).find((i) => i.href === `/ncpd/characters/${char.id}`);
    expect(hit).toBeTruthy();
    expect(hit!.staffOnly).toBe(true);
  });

  it("searches lore by name and alias without leaking fixer-only fields", async () => {
    const user = await createUser();
    const [entry] = await db
      .insert(loreEntries)
      .values({
        slug: "xylophone-syndicate",
        name: "Xylophone Syndicate",
        category: "faction",
        summary: "A very loud gang.",
        aliases: ["The Xylos"],
        fixerBody: "SECRET fixer intel",
      })
      .returning();

    const byAlias = await request(app).get("/api/search?q=Xylos").set("x-test-user", user.id);
    expect(byAlias.status).toBe(200);
    const hit = (byAlias.body.lore as Item[]).find((l) => l.href === `/directory/lore/${entry.id}`);
    expect(hit).toBeTruthy();
    expect(JSON.stringify(byAlias.body)).not.toContain("SECRET fixer intel");
  });
});
