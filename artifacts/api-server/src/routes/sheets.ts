import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, characterSheets, users, activityEvents, catalogCyberware, type User } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { postToChannel } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import { collectCyberware, buildCyberwareCostMap, entryPoints, validateCyberware } from "../lib/cyberware-cap";
import { validateSheetFields } from "../lib/sheet-validation";

const router: IRouter = Router();

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

router.get("/sheets", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(characterSheets)
    .where(eq(characterSheets.ownerId, req.user!.id))
    .orderBy(desc(characterSheets.createdAt));
  res.json(rows);
});

router.get("/sheets/pending", requireAuth, requireRole("CS_APPROVER"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: characterSheets.id,
      name: characterSheets.name,
      status: characterSheets.status,
      createdAt: characterSheets.createdAt,
      ownerId: characterSheets.ownerId,
      ownerName: users.username,
      ownerAvatarUrl: users.avatarUrl,
    })
    .from(characterSheets)
    .leftJoin(users, eq(users.id, characterSheets.ownerId))
    .where(eq(characterSheets.status, "pending"))
    .orderBy(desc(characterSheets.createdAt));
  res.json(rows);
});

router.get("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const isOwner = s.ownerId === req.user!.id;
  // Staff who can review/edit a sheet may also view it: CS approvers, admins,
  // and fixers. Kept in lockstep with the PATCH /sheets/:id edit permission.
  const isStaff =
    hasRole(req.user!.roles, "CS_APPROVER") ||
    hasRole(req.user!.roles, "ADMIN") ||
    hasRole(req.user!.roles, "FIXER");
  if (!isOwner && !isStaff) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(s);
});

// Loads the catalog cyberware CWP cost map from the database. The catalog is the
// single source of truth for an install's cost: the client never types CWP, it's
// set from the catalog. The pure map-building (incl. "highest CWP wins" on
// duplicate names) lives in ../lib/cyberware so it can be unit-tested.
async function loadCyberwareCostMap(): Promise<Map<string, number>> {
  const rows = await db
    .select({ name: catalogCyberware.name, cwp: catalogCyberware.cwp })
    .from(catalogCyberware);
  return buildCyberwareCostMap(rows);
}

// Runs full submission validation. Returns null on success, error message on failure.
// `user` is used to gate NPC sheets to fixers/admins only.
async function validateSheetForSubmission(data: unknown, user: User): Promise<string | null> {
  // Non-cyberware rules (required fields, PC/NPC gating, age, skills, gear) live
  // in ../lib/sheet-validation so they can be unit-tested without a database.
  const fieldErr = validateSheetFields(data, user.roles);
  if (fieldErr) return fieldErr;
  const d = data as Record<string, unknown>;
  // Cyberware is optional. If present, total CWP is capped at 6 at creation.
  // For catalog installs the cost is taken from the catalog (the client-sent
  // value is ignored), so the cap can't be bypassed by a crafted payload.
  // Custom (non-catalog) entries keep their client value; reject negatives so
  // they can't offset over-cap entries.
  const entries = collectCyberware(d);
  const costMap = await loadCyberwareCostMap();
  return validateCyberware(entries, costMap);
}

async function computePoints(data: unknown): Promise<number> {
  const d = (data ?? {}) as Record<string, unknown>;
  const costMap = await loadCyberwareCostMap();
  return collectCyberware(d).reduce((s, c) => s + entryPoints(c, costMap), 0);
}

async function announceSubmission(sheetId: number, name: string, data: any, user: User): Promise<void> {
  if (!CS_CHANNEL_ID) return;
  const sheetType = (data as { sheetType: string }).sheetType;
  const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "");
  const reviewUrl = portalBase ? `https://${portalBase}/sheets/${sheetId}` : `/sheets/${sheetId}`;
  const points = await computePoints(data);
  const msgId = await postToChannel(CS_CHANNEL_ID, `New ${sheetType} sheet pending review: **${name}** by ${user.username}`, [
    {
      title: name,
      description: data.background?.slice(0, 500) ?? "",
      fields: [
        { name: "Type", value: sheetType, inline: true },
        { name: "Player", value: user.username, inline: true },
        { name: "Archetype", value: data.archetype ?? "—", inline: true },
        { name: "Pronouns", value: data.pronouns ?? "—", inline: true },
        { name: "Occupation", value: data.occupation ?? "—", inline: true },
        { name: "Cyberware Pts", value: `${points}/6`, inline: true },
        { name: "Review", value: reviewUrl, inline: false },
      ],
    },
  ]);
  if (msgId) {
    await db.update(characterSheets).set({ discordMessageId: msgId }).where(eq(characterSheets.id, sheetId));
  }
  await db.insert(activityEvents).values({
    kind: "sheet_submitted",
    actorId: user.id,
    actorName: user.username,
    actorAvatarUrl: user.avatarUrl,
    message: `${user.username} submitted sheet for ${name}`,
  });
}

router.post("/sheets", requireAuth, async (req, res): Promise<void> => {
  const { name, data, characterId, status } = req.body ?? {};
  if (!name || !data || typeof data !== "object") {
    res.status(400).json({ error: "name and data required" });
    return;
  }
  const wantsDraft = status === "draft";
  if (!wantsDraft) {
    const err = await validateSheetForSubmission(data, req.user!);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }
  const [s] = await db
    .insert(characterSheets)
    .values({
      ownerId: req.user!.id,
      characterId: characterId ?? null,
      name,
      data,
      status: wantsDraft ? "draft" : "pending",
    })
    .returning();

  if (!wantsDraft) {
    await announceSubmission(s.id, name, data, req.user!);
  }
  await recordAudit({
    req,
    category: "sheet",
    action: wantsDraft ? "draft" : "submit",
    targetType: "sheet",
    targetId: s.id,
    message: `${req.user!.username} ${wantsDraft ? "drafted" : "submitted"} sheet "${name}"`,
    after: { name, characterId: s.characterId },
  });
  res.status(201).json(s);
});

// Owner can edit any sheet that is still editable (draft or changes_requested).
router.patch("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const isOwner = existing.ownerId === req.user!.id;
  const isStaff =
    hasRole(req.user!.roles, "CS_APPROVER") ||
    hasRole(req.user!.roles, "ADMIN") ||
    hasRole(req.user!.roles, "FIXER");
  if (!isOwner && !isStaff) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Owners can edit their own draft / changes-requested / in-review sheets.
  // Staff (reviewers) can edit a sheet while it is in review (pending) so they
  // can adjust any part of the ticket before approving it. Status is left
  // unchanged — editing in review does not require a re-submit.
  const allowed = isOwner ? ["draft", "changes_requested", "pending"] : ["pending"];
  if (!allowed.includes(existing.status)) {
    res.status(409).json({ error: "Sheet is locked (already approved/rejected)" });
    return;
  }
  const { name, data, characterId } = req.body ?? {};
  // A sheet in review can be edited in place (no re-submit), so the full
  // submission validation is skipped to allow incremental tweaks. The 6-CWP
  // cap is a hard rule though, so enforce the cyberware cap (and reject
  // negatives) whenever a pending sheet's data is updated — otherwise it could
  // be pushed over-cap after submission and approved without re-validation.
  if (existing.status === "pending" && data && typeof data === "object") {
    const entries = collectCyberware(data as Record<string, unknown>);
    const costMap = await loadCyberwareCostMap();
    const cwErr = validateCyberware(entries, costMap);
    if (cwErr) {
      res.status(400).json({ error: cwErr });
      return;
    }
  }
  const [updated] = await db
    .update(characterSheets)
    .set({
      ...(typeof name === "string" && name.length ? { name } : {}),
      ...(data && typeof data === "object" ? { data } : {}),
      ...(characterId !== undefined ? { characterId } : {}),
    })
    .where(eq(characterSheets.id, id))
    .returning();
  res.json(updated);
});

// Promote a draft (or a changes-requested sheet) to "pending" review.
router.post("/sheets/:id/submit", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (existing.status !== "draft" && existing.status !== "changes_requested") {
    res.status(409).json({ error: "Sheet is not in a submittable state" });
    return;
  }
  const err = await validateSheetForSubmission(existing.data, req.user!);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const [updated] = await db
    .update(characterSheets)
    .set({ status: "pending", decisionBy: null, decisionNote: null, decidedAt: null })
    .where(eq(characterSheets.id, id))
    .returning();
  await announceSubmission(updated.id, updated.name, updated.data, req.user!);
  res.json(updated);
});

// Owner can delete their own drafts.
router.delete("/sheets/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(characterSheets).where(eq(characterSheets.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (existing.status !== "draft") {
    res.status(409).json({ error: "Only drafts can be deleted" });
    return;
  }
  await db.delete(characterSheets).where(eq(characterSheets.id, id));
  res.status(204).end();
});

router.post("/sheets/:id/decision", requireAuth, requireRole("CS_APPROVER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { decision, note } = req.body ?? {};
  if (!["approved", "rejected", "changes_requested"].includes(decision)) {
    res.status(400).json({ error: "Invalid decision" });
    return;
  }
  const [u] = await db
    .update(characterSheets)
    .set({
      status: decision,
      decisionBy: req.user!.id,
      decisionNote: note ?? null,
      decidedAt: new Date(),
    })
    .where(eq(characterSheets.id, id))
    .returning();
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordAudit({
    req,
    category: "sheet",
    action: `decision_${decision}`,
    targetType: "sheet",
    targetId: id,
    message: `${req.user!.username} ${decision} sheet "${u.name}"`,
    after: { decision, note: note ?? null },
  });
  res.json(u);
});

export default router;
