import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, characterSheets, users, activityEvents, type User } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { postToChannel } from "../lib/discord";

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
  const isApprover = req.user!.roles
    .map((r) => r.toLowerCase())
    .some((r) => ["cs approver", "character approver", "cs-approver", "admin", "administrator"].includes(r));
  if (!isOwner && !isApprover) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(s);
});

// NCRP canonical chrome taxonomy (matches client form / NCRP creation guidelines).
const NCRP_SLOTS = [
  "Arms & Arm Attachments (Left)",
  "Arms & Arm Attachments (Right)",
  "Auditory System",
  "Circulatory & Immune Systems",
  "Hands",
  "Feet",
  "Integumentary System",
  "Legs & Mobility (Left)",
  "Legs & Mobility (Right)",
  "Neural",
  "Ocular System",
  "Skeleton & Torso Musculature",
  "Universal Muscular (Arms/Legs/Tail)",
] as const;
const REQUIRED_SHEET_FIELDS = [
  "sheetType",
  "fullName",
  "pronouns",
  "occupation",
  "psychProfile",
  "physicalDescription",
] as const;

// Runs full submission validation. Returns null on success, error message on failure.
function validateSheetForSubmission(data: unknown): string | null {
  if (!data || typeof data !== "object") return "data required";
  const d = data as Record<string, unknown>;
  for (const f of REQUIRED_SHEET_FIELDS) {
    if (typeof d[f] !== "string" || !(d[f] as string).trim()) {
      return `Missing required field: ${f}`;
    }
  }
  if (!["PC", "NPC"].includes(d.sheetType as string)) {
    return "sheetType must be PC or NPC";
  }
  if (typeof d.age !== "number" || (d.age as number) <= 0) {
    return "Missing required field: age (positive integer)";
  }
  const skillsObj = d.skills;
  if (!skillsObj || typeof skillsObj !== "object" || Object.keys(skillsObj as object).length === 0) {
    return "Missing required field: skills (at least one)";
  }
  const gearList = d.gear;
  if (!Array.isArray(gearList) || gearList.filter((g) => typeof g === "string" && g.trim()).length === 0) {
    return "Missing required field: gear/equipment (at least one entry)";
  }
  const bySlot = Array.isArray(d.cyberwareBySlot)
    ? (d.cyberwareBySlot as Array<{ slot?: string }>)
    : null;
  if (!bySlot || bySlot.length !== NCRP_SLOTS.length) {
    return `cyberwareBySlot must contain exactly ${NCRP_SLOTS.length} entries in the canonical NCRP order`;
  }
  for (let i = 0; i < NCRP_SLOTS.length; i++) {
    if (bySlot[i]?.slot !== NCRP_SLOTS[i]) {
      return `cyberwareBySlot[${i}].slot must be "${NCRP_SLOTS[i]}"`;
    }
  }
  const miscEntries = Array.isArray(d.cyberwareMisc)
    ? (d.cyberwareMisc as Array<{ slot?: string; name?: string }>)
    : [];
  for (const m of miscEntries) {
    if (!m?.slot || !m?.name) {
      return "Each misc chrome entry requires slot (category) and name";
    }
  }
  const filledFoundational = bySlot.filter((c) => typeof (c as { name?: string }).name === "string" && ((c as { name: string }).name).trim().length > 0);
  const allChrome = [...filledFoundational, ...miscEntries] as Array<{ points?: number }>;
  const points = allChrome.reduce((s, c) => s + (Number(c.points) || 0), 0);
  if (points > 6) return "Max 6 cyberware humanity points at creation";
  if (filledFoundational.length > NCRP_SLOTS.length) return `Max ${NCRP_SLOTS.length} foundational chrome slots`;
  return null;
}

function computePoints(data: unknown): number {
  const d = (data ?? {}) as Record<string, unknown>;
  const bySlot = Array.isArray(d.cyberwareBySlot) ? (d.cyberwareBySlot as Array<{ name?: string; points?: number }>) : [];
  const misc = Array.isArray(d.cyberwareMisc) ? (d.cyberwareMisc as Array<{ points?: number }>) : [];
  const filled = bySlot.filter((c) => typeof c.name === "string" && c.name.trim().length > 0);
  return [...filled, ...misc].reduce((s, c) => s + (Number(c.points) || 0), 0);
}

async function announceSubmission(sheetId: number, name: string, data: any, user: User): Promise<void> {
  if (!CS_CHANNEL_ID) return;
  const sheetType = (data as { sheetType: string }).sheetType;
  const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "");
  const reviewUrl = portalBase ? `https://${portalBase}/sheets/${sheetId}` : `/sheets/${sheetId}`;
  const points = computePoints(data);
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
    const err = validateSheetForSubmission(data);
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
  if (existing.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (existing.status !== "draft" && existing.status !== "changes_requested") {
    res.status(409).json({ error: "Sheet is locked (already submitted/approved)" });
    return;
  }
  const { name, data, characterId } = req.body ?? {};
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
  const err = validateSheetForSubmission(existing.data);
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
  res.json(u);
});

export default router;
