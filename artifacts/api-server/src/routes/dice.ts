import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, diceRolls, characters } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { roll } from "../lib/dice";

const router: IRouter = Router();

router.post("/dice/roll", requireAuth, async (req, res): Promise<void> => {
  const { expression, label, characterId } = req.body ?? {};
  if (typeof expression !== "string" || !expression.trim()) {
    res.status(400).json({ error: "expression required" });
    return;
  }
  try {
    const result = roll(expression);
    let characterName: string | null = null;
    if (characterId) {
      const [c] = await db.select().from(characters).where(eq(characters.id, characterId));
      if (c) characterName = c.name;
    }
    const [stored] = await db
      .insert(diceRolls)
      .values({
        userId: req.user!.id,
        characterId: characterId ?? null,
        characterName,
        expression: result.expression,
        label: label ?? null,
        rolls: result.rolls,
        modifier: result.modifier,
        total: result.total,
      })
      .returning();
    res.json(stored);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid expression" });
  }
});

router.get("/dice/history", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(diceRolls)
    .where(eq(diceRolls.userId, req.user!.id))
    .orderBy(desc(diceRolls.createdAt))
    .limit(50);
  res.json(rows);
});

export default router;
