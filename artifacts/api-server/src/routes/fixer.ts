import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, fixerNpcs, users } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/fixer/npcs/mine", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const rows = await db.select().from(fixerNpcs).where(eq(fixerNpcs.fixerId, req.user!.id)).orderBy(desc(fixerNpcs.createdAt));
  res.json(rows);
});

router.get("/fixer/npcs", requireAuth, requireRole("FIXER"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: fixerNpcs.id,
      name: fixerNpcs.name,
      archetype: fixerNpcs.archetype,
      district: fixerNpcs.district,
      description: fixerNpcs.description,
      portraitUrl: fixerNpcs.portraitUrl,
      contact: fixerNpcs.contact,
      createdAt: fixerNpcs.createdAt,
      fixerName: users.username,
      fixerAvatarUrl: users.avatarUrl,
    })
    .from(fixerNpcs)
    .leftJoin(users, eq(users.id, fixerNpcs.fixerId))
    .orderBy(desc(fixerNpcs.createdAt));
  res.json(rows);
});

router.post("/fixer/npcs", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const { name, archetype, district, description, portraitUrl, contact } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [n] = await db
    .insert(fixerNpcs)
    .values({
      fixerId: req.user!.id,
      name,
      archetype: archetype ?? null,
      district: district ?? null,
      description: description ?? null,
      portraitUrl: portraitUrl ?? null,
      contact: contact ?? null,
    })
    .returning();
  res.status(201).json(n);
});

router.get("/fixer/npcs/:id", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [n] = await db.select().from(fixerNpcs).where(eq(fixerNpcs.id, id));
  if (!n) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(n);
});

router.patch("/fixer/npcs/:id", requireAuth, requireRole("FIXER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [n] = await db.select().from(fixerNpcs).where(and(eq(fixerNpcs.id, id), eq(fixerNpcs.fixerId, req.user!.id)));
  if (!n) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, archetype, district, description, portraitUrl, contact } = req.body ?? {};
  const [u] = await db
    .update(fixerNpcs)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(archetype !== undefined ? { archetype } : {}),
      ...(district !== undefined ? { district } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(portraitUrl !== undefined ? { portraitUrl } : {}),
      ...(contact !== undefined ? { contact } : {}),
    })
    .where(eq(fixerNpcs.id, id))
    .returning();
  res.json(u);
});

export default router;
