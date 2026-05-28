import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, lifestyleTiers } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

// Public-ish: any authenticated user can browse the lifestyle catalog so
// players know what each tier costs before picking one. Archived tiers are
// hidden by default; pass ?all=true to include them (admin/staff use).
router.get("/catalog/lifestyle", requireAuth, async (req, res): Promise<void> => {
  const includeArchived = String(req.query.all ?? "") === "true";
  const rows = await db.select().from(lifestyleTiers).orderBy(asc(lifestyleTiers.monthlyCost));
  res.json(includeArchived ? rows : rows.filter((r) => !r.archived));
});

// ===== Admin CRUD =====
router.get("/admin/lifestyle-tiers", requireAuth, requireRole("ADMIN"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(lifestyleTiers).orderBy(asc(lifestyleTiers.monthlyCost));
  res.json(rows);
});

router.post("/admin/lifestyle-tiers", requireAuth, requireRole("ADMIN"), async (req, res): Promise<void> => {
  const { name, monthlyCost, description } = req.body ?? {};
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [row] = await db
    .insert(lifestyleTiers)
    .values({
      name,
      monthlyCost: Math.max(0, Number(monthlyCost) || 0),
      description: description ?? null,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/admin/lifestyle-tiers/:id", requireAuth, requireRole("ADMIN"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { name, monthlyCost, description, archived } = req.body ?? {};
  const [row] = await db
    .update(lifestyleTiers)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(monthlyCost !== undefined ? { monthlyCost: Math.max(0, Number(monthlyCost) || 0) } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(archived !== undefined ? { archived: Boolean(archived) } : {}),
    })
    .where(eq(lifestyleTiers.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/admin/lifestyle-tiers/:id", requireAuth, requireRole("ADMIN"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Soft-delete: archived tiers stop being billed and stop appearing in the
  // catalog, but existing characters keep their `lifestyleTierId` so history
  // (wallet transactions, audit) keeps its FK target intact.
  const [row] = await db
    .update(lifestyleTiers)
    .set({ archived: true })
    .where(eq(lifestyleTiers.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
