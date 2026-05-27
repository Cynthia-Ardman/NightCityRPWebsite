import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, characterSheets, users, activityEvents } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { postToChannel } from "../lib/discord";

const router: IRouter = Router();

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

router.get("/me/sheets", requireAuth, async (req, res): Promise<void> => {
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

router.post("/sheets", requireAuth, async (req, res): Promise<void> => {
  const { name, data, characterId } = req.body ?? {};
  if (!name || !data) {
    res.status(400).json({ error: "name and data required" });
    return;
  }
  // Validate cyberware caps
  const cw = Array.isArray(data.cyberware) ? data.cyberware : [];
  if (cw.length > 11) {
    res.status(400).json({ error: "Max 11 cyberware slots" });
    return;
  }
  const points = typeof data.cyberwarePointsSpent === "number" ? data.cyberwarePointsSpent : 0;
  if (points > 6) {
    res.status(400).json({ error: "Max 6 cyberware points at creation" });
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
    const msgId = await postToChannel(CS_CHANNEL_ID, `New character sheet pending: **${name}** by ${req.user!.username}`, [
      {
        title: name,
        description: data.background?.slice(0, 500) ?? "",
        fields: [
          { name: "Archetype", value: data.archetype ?? "—", inline: true },
          { name: "Cyberware Pts", value: String(points), inline: true },
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

router.post("/sheets/:id/decide", requireAuth, requireRole("CS_APPROVER"), async (req, res): Promise<void> => {
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
