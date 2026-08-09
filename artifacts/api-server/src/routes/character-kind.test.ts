import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import request from "supertest";

import { db, characters, auditLog, characterStatus } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";
import { householdEffectiveCheckupDate } from "../lib/jobs";

const app = buildTestApp();

// Helper: set the self-service transient LOA flag on a character.
// The kind-conversion route reads character_status.loa — the same source
// the billing cron's isOnLoa() check uses to skip ALL personal billing.
async function setTransientLoa(characterId: number, loa: boolean) {
  await db
    .insert(characterStatus)
    .values({ characterId, loa })
    .onConflictDoUpdate({ target: characterStatus.characterId, set: { loa } });
}

describe("PATCH /characters/:id/kind", () => {
  it("403 for a regular player (even the owner)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", owner.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(403);
  });

  it("fixer can convert a PC to an NPC (and back), with audit trail", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "pc" });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("npc");
    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.kind).toBe("npc");
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, String(char.id)));
    expect(audits.some((a) => a.action === "set_kind")).toBe(true);
    const back = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(back.status).toBe(200);
    expect(back.body.kind).toBe("pc");
  });

  it("400 for an invalid kind", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const char = await createCharacter({ ownerId: fixer.id });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "monster" });
    expect(res.status).toBe(400);
  });

  it("no-op when the kind already matches", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const char = await createCharacter({ ownerId: fixer.id, kind: "npc" });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, String(char.id)));
    expect(audits.some((a) => a.action === "set_kind")).toBe(false);
  });

  it("409 when converting an over-cap NPC to PC", async () => {
    const { inventoryItems } = await import("@workspace/db");
    const fixer = await createUser({ roles: ["fixer"] });
    const char = await createCharacter({ ownerId: fixer.id, kind: "npc" });
    await db.insert(inventoryItems).values({
      characterId: char.id,
      ownerId: fixer.id,
      name: "Heavy Chrome",
      category: "cyberware",
      quantity: 1,
      notes: "CWP 20 · Installed at Rook's on 2026-01-01",
    });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/CWP/);
    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.kind).toBe("npc");
  });

  it("404 for an unknown character", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app)
      .patch(`/api/characters/999999/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(404);
  });

  // ---- Billing-effect policy tests ----
  // Policy (docs/pc-npc-conversion-policy.md): billing is cron-driven and
  // uses a shared personal-billing predicate for baseline, TT, and Xanadu
  // (transient LOA skips the entire personal billing loop for a character).
  // Meds adds a headline life-status exclusion on top of that.
  //
  // Audit field legend:
  //   characterPersonalBillingBefore/After
  //     — kind='pc' + approved + !archived + owner + !character_status.loa
  //     — All three personal fees (baseline, TT, Xanadu) use this same predicate
  //   characterMedsBillingBefore/After
  //     — same as personal + lifeStatus not in {dead, retired, loa}
  //   ownerOtherPersonalBillingEligiblePcCount
  //     — owner's other PCs passing the same personal predicate (LOA excluded)
  //   transientLoaActive, lifeStatusMedsExcluded — reference, unchanged by conversion

  it("PC→NPC: billing stops when this was the owner's only personally-eligible PC", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    expect(effects.characterPersonalBillingBefore).toBe(true);
    expect(effects.characterPersonalBillingAfter).toBe(false);
    expect(effects.characterMedsBillingBefore).toBe(true);
    expect(effects.characterMedsBillingAfter).toBe(false);
    expect(effects.transientLoaActive).toBe(false);
    expect(Number(effects.ownerOtherPersonalBillingEligiblePcCount)).toBe(0);
    expect(String(effects.personalBillingNote)).toMatch(/billing will stop/);
    expect(String(effects.medsBillingNote)).toMatch(/removed from meds household/);
  });

  it("PC→NPC: billing continues when owner has another personally-eligible PC", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const sibling = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    const char = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    expect(Number(effects.ownerOtherPersonalBillingEligiblePcCount)).toBe(1);
    expect(String(effects.personalBillingNote)).toMatch(/billing continues/);
    void sibling;
  });

  it("sibling on transient LOA is NOT counted as a personally-eligible PC", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const sibling = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    await setTransientLoa(sibling.id, true); // sibling is on self-service LOA → skipped by cron
    const char = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    // LOA sibling is excluded → count = 0 → billing stops note is correct.
    expect(Number(effects.ownerOtherPersonalBillingEligiblePcCount)).toBe(0);
    expect(String(effects.personalBillingNote)).toMatch(/billing will stop/);
    void sibling;
  });

  it("NPC→PC: billing starts when this is the owner's first personally-eligible PC", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "npc", approved: true });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    expect(effects.characterPersonalBillingBefore).toBe(false);
    expect(effects.characterPersonalBillingAfter).toBe(true);
    expect(effects.characterMedsBillingBefore).toBe(false);
    expect(effects.characterMedsBillingAfter).toBe(true);
    expect(Number(effects.ownerOtherPersonalBillingEligiblePcCount)).toBe(0);
    expect(String(effects.personalBillingNote)).toMatch(/billing will start/);
    expect(String(effects.medsBillingNote)).toMatch(/added to meds household/);
  });

  it("NPC→PC: billing unchanged when owner already has a personally-eligible PC", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    const char = await createCharacter({ ownerId: owner.id, kind: "npc", approved: true });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    expect(Number(effects.ownerOtherPersonalBillingEligiblePcCount)).toBeGreaterThanOrEqual(1);
    expect(String(effects.personalBillingNote)).toMatch(/already had/);
  });

  it("PC on transient LOA → NPC: not personally eligible (LOA blocks all billing); note reflects it", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    await setTransientLoa(char.id, true);
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    // LOA blocks all personal billing, so not eligible before or after.
    expect(effects.characterPersonalBillingBefore).toBe(false);
    expect(effects.characterPersonalBillingAfter).toBe(false);
    expect(effects.transientLoaActive).toBe(true);
    expect(String(effects.personalBillingNote)).toMatch(/self-service LOA/);
    expect(effects.characterMedsBillingBefore).toBe(false);
    expect(effects.characterMedsBillingAfter).toBe(false);
    expect(String(effects.medsBillingNote)).toMatch(/excluded from meds household/);
  });

  it("NPC on transient LOA → PC: still not personally eligible (LOA blocks billing); note reflects it", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "npc", approved: true });
    await setTransientLoa(char.id, true);
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    // LOA blocks all personal billing; not eligible as NPC before, not eligible as PC (LOA) after.
    expect(effects.characterPersonalBillingBefore).toBe(false);
    expect(effects.characterPersonalBillingAfter).toBe(false);
    expect(effects.transientLoaActive).toBe(true);
    expect(String(effects.personalBillingNote)).toMatch(/self-service LOA/);
    expect(String(effects.medsBillingNote)).toMatch(/excluded from meds household/);
  });

  it("unapproved PC→NPC: all billing flags false; notes say not in billing pool", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "pc", approved: false });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    expect(effects.characterPersonalBillingBefore).toBe(false);
    expect(effects.characterPersonalBillingAfter).toBe(false);
    expect(effects.characterMedsBillingBefore).toBe(false);
    expect(effects.characterMedsBillingAfter).toBe(false);
    expect(String(effects.personalBillingNote)).toMatch(/not in the personal billing pool/);
    expect(String(effects.medsBillingNote)).toMatch(/excluded from meds household/);
  });

  it("unapproved NPC→PC: all billing flags false; notes say not in billing pool", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, kind: "npc", approved: false });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "pc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    expect(effects.characterPersonalBillingBefore).toBe(false);
    expect(effects.characterPersonalBillingAfter).toBe(false);
    expect(effects.characterMedsBillingBefore).toBe(false);
    expect(effects.characterMedsBillingAfter).toBe(false);
    expect(String(effects.personalBillingNote)).toMatch(/not in the personal billing pool/);
    expect(String(effects.medsBillingNote)).toMatch(/excluded from meds household/);
  });

  it("dead PC→NPC: personal billing stops; meds was already excluded by life status", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    // Dead PCs ARE included in the personal billing loop (cron doesn't filter
    // by lifeStatus before baseline/TT/Xanadu), so they are personally eligible.
    const char = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true, lifeStatus: "dead" });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/kind`)
      .set("x-test-user", fixer.id)
      .send({ kind: "npc" });
    expect(res.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(char.id)), eq(auditLog.action, "set_kind")));
    const effects = (audit.afterJson as Record<string, unknown>).billingEffects as Record<string, unknown>;
    // Dead PCs count for personal billing (baseline/TT/Xanadu).
    expect(effects.characterPersonalBillingBefore).toBe(true);
    expect(effects.characterPersonalBillingAfter).toBe(false);
    // But dead is excluded from meds.
    expect(effects.lifeStatusMedsExcluded).toBe(true);
    expect(effects.characterMedsBillingBefore).toBe(false);
    expect(effects.characterMedsBillingAfter).toBe(false);
    expect(String(effects.medsBillingNote)).toMatch(/excluded from meds household/);
  });
});

// ---- householdEffectiveCheckupDate excludes NPCs ----
// Policy: NPC chrome never counts toward the owner's meds household. The
// cron and this helper both filter to kind='pc' before computing the streak.

describe("householdEffectiveCheckupDate — NPC exclusion", () => {
  it("ignores NPC characters when computing the household effective checkup date", async () => {
    const owner = await createUser();
    const pc = await createCharacter({ ownerId: owner.id, kind: "pc", approved: true });
    const npc = await createCharacter({ ownerId: owner.id, kind: "npc", approved: true });

    const pcDate = new Date("2026-01-01T12:00:00.000Z");
    await db.update(characters).set({ lastCheckupAt: pcDate }).where(eq(characters.id, pc.id));

    const npcDate = new Date("2026-06-01T12:00:00.000Z");
    await db.update(characters).set({ lastCheckupAt: npcDate }).where(eq(characters.id, npc.id));

    const result = await householdEffectiveCheckupDate(db, owner.id);
    // Result must be the PC's date, not the NPC's later date.
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(pcDate.toISOString());
  });

  it("returns null when the owner's only character is an NPC", async () => {
    const owner = await createUser();
    const npc = await createCharacter({ ownerId: owner.id, kind: "npc", approved: true });
    await db.update(characters).set({ lastCheckupAt: new Date("2026-06-01T12:00:00.000Z") }).where(eq(characters.id, npc.id));

    const result = await householdEffectiveCheckupDate(db, owner.id);
    expect(result).toBeNull();
  });
});
