import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, characterSheets, users, activityEvents } from "@workspace/db";
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
  "background",
] as const;

router.post("/sheets", requireAuth, async (req, res): Promise<void> => {
  const { name, data, characterId } = req.body ?? {};
  if (!name || !data || typeof data !== "object") {
    res.status(400).json({ error: "name and data required" });
    return;
  }
  // Required identity / narrative fields per NCRP template
  for (const f of REQUIRED_SHEET_FIELDS) {
    if (typeof (data as Record<string, unknown>)[f] !== "string" || !(data as Record<string, string>)[f].trim()) {
      res.status(400).json({ error: `Missing required field: ${f}` });
      return;
    }
  }
  if (!["PC", "NPC"].includes((data as { sheetType: string }).sheetType)) {
    res.status(400).json({ error: "sheetType must be PC or NPC" });
    return;
  }
  if (typeof (data as { age?: unknown }).age !== "number" || (data as { age: number }).age <= 0) {
    res.status(400).json({ error: "Missing required field: age (positive integer)" });
    return;
  }
  // Skills + Equipment are required per NCRP template.
  const skillsObj = (data as { skills?: unknown }).skills;
  if (!skillsObj || typeof skillsObj !== "object" || Object.keys(skillsObj as object).length === 0) {
    res.status(400).json({ error: "Missing required field: skills (at least one)" });
    return;
  }
  const gearList = (data as { gear?: unknown }).gear;
  if (!Array.isArray(gearList) || gearList.filter((g) => typeof g === "string" && g.trim()).length === 0) {
    res.status(400).json({ error: "Missing required field: gear/equipment (at least one entry)" });
    return;
  }
  // Foundational chrome template — exact 11 slots, in order, named correctly.
  const bySlot = Array.isArray((data as { cyberwareBySlot?: unknown }).cyberwareBySlot)
    ? ((data as { cyberwareBySlot: unknown[] }).cyberwareBySlot as Array<{ slot?: string }>)
    : null;
  if (!bySlot || bySlot.length !== NCRP_SLOTS.length) {
    res.status(400).json({ error: `cyberwareBySlot must contain exactly ${NCRP_SLOTS.length} entries in the canonical NCRP order` });
    return;
  }
  for (let i = 0; i < NCRP_SLOTS.length; i++) {
    if (bySlot[i]?.slot !== NCRP_SLOTS[i]) {
      res.status(400).json({ error: `cyberwareBySlot[${i}].slot must be "${NCRP_SLOTS[i]}"` });
      return;
    }
  }
  // Misc chrome is unlimited but each entry must have at least slot+name+points.
  const miscEntries = Array.isArray((data as { cyberwareMisc?: unknown }).cyberwareMisc)
    ? ((data as { cyberwareMisc: unknown[] }).cyberwareMisc as Array<{ slot?: string; name?: string }>)
    : [];
  for (const m of miscEntries) {
    if (!m?.slot || !m?.name) {
      res.status(400).json({ error: "Each misc chrome entry requires slot (category) and name" });
      return;
    }
  }
  // Server-recomputed point cap (don't trust client).
  const filledFoundational = bySlot.filter((c) => typeof (c as { name?: string }).name === "string" && ((c as { name: string }).name).trim().length > 0);
  const allChrome = [...filledFoundational, ...miscEntries] as Array<{ points?: number }>;
  const points = allChrome.reduce((s, c) => s + (Number(c.points) || 0), 0);
  if (points > 6) {
    res.status(400).json({ error: "Max 6 cyberware humanity points at creation" });
    return;
  }
  if (filledFoundational.length > NCRP_SLOTS.length) {
    res.status(400).json({ error: `Max ${NCRP_SLOTS.length} foundational chrome slots` });
    return;
  }
  const [s] = await db
    .insert(characterSheets)
    .values({
      ownerId: req.user!.id,
      characterId: characterId ?? null,
      name,
      data,
      status: "pending",
    })
    .returning();

  if (CS_CHANNEL_ID) {
    const sheetType = (data as { sheetType: string }).sheetType;
    const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "");
    const reviewUrl = portalBase ? `https://${portalBase}/sheets/${s.id}` : `/sheets/${s.id}`;
    const msgId = await postToChannel(CS_CHANNEL_ID, `New ${sheetType} sheet pending review: **${name}** by ${req.user!.username}`, [
      {
        title: name,
        description: data.background?.slice(0, 500) ?? "",
        fields: [
          { name: "Type", value: sheetType, inline: true },
          { name: "Player", value: req.user!.username, inline: true },
          { name: "Archetype", value: data.archetype ?? "—", inline: true },
          { name: "Pronouns", value: data.pronouns ?? "—", inline: true },
          { name: "Occupation", value: data.occupation ?? "—", inline: true },
          { name: "Cyberware Pts", value: `${points}/6`, inline: true },
          { name: "Review", value: reviewUrl, inline: false },
        ],
      },
    ]);
    if (msgId) {
      await db.update(characterSheets).set({ discordMessageId: msgId }).where(eq(characterSheets.id, s.id));
    }
  }

  await db.insert(activityEvents).values({
    kind: "sheet_submitted",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} submitted sheet for ${name}`,
  });

  res.status(201).json(s);
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
