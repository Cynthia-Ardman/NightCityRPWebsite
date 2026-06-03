import { Router, type IRouter } from "express";
import type { Pos } from "@workspace/breach";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import {
  createPuzzle,
  listPuzzles,
  listMyPuzzles,
  listCharacterPuzzles,
  getPuzzle,
  startPuzzle,
  submitResult,
} from "../lib/breach";

const router: IRouter = Router();

// Staff log of every generated puzzle.
router.get("/breach/puzzles", requireAuth, requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const result = await listPuzzles(req.user!, status);
  res.status(result.status).json(result.body);
});

// Staff: generate + assign + DM a puzzle.
router.post("/breach/puzzles", requireAuth, requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const result = await createPuzzle(req.user!, req.body ?? {});
  res.status(result.status).json(result.body);
});

// The caller's own assigned puzzles.
router.get("/breach/mine", requireAuth, async (req, res): Promise<void> => {
  const result = await listMyPuzzles(req.user!);
  res.status(result.status).json(result.body);
});

// A single puzzle (assigned player or staff).
router.get("/breach/puzzles/:id", requireAuth, async (req, res): Promise<void> => {
  const result = await getPuzzle(req.user!, parseInt(String(req.params.id), 10));
  res.status(result.status).json(result.body);
});

// Player: start the timer (idempotent).
router.post("/breach/puzzles/:id/start", requireAuth, async (req, res): Promise<void> => {
  const result = await startPuzzle(req.user!, parseInt(String(req.params.id), 10));
  res.status(result.status).json(result.body);
});

// Player: submit the final path for scoring + reward.
router.post("/breach/puzzles/:id/result", requireAuth, async (req, res): Promise<void> => {
  const selection = (req.body?.selection ?? []) as Pos[];
  const result = await submitResult(req.user!, parseInt(String(req.params.id), 10), selection);
  res.status(result.status).json(result.body);
});

// Per-character history (owner or staff).
router.get("/characters/:id/breach", requireAuth, async (req, res): Promise<void> => {
  const result = await listCharacterPuzzles(req.user!, parseInt(String(req.params.id), 10));
  res.status(result.status).json(result.body);
});

export default router;
