import { Router, type IRouter } from "express";
import type { Pos } from "@workspace/breach";
import { requireAuth, requireAnyRole } from "../middlewares/auth";
import {
  createPuzzle,
  previewPuzzle,
  listPuzzles,
  listMyPuzzles,
  countMyPendingPuzzles,
  listCharacterPuzzles,
  getPuzzle,
  startPuzzle,
  submitResult,
  getPracticeStats,
  recordPracticeAttempt,
  mergePracticeStats,
  clearPracticeStats,
  getPracticeLeaderboard,
} from "../lib/breach";

const router: IRouter = Router();

// Staff log of every generated puzzle.
router.get("/breach/puzzles", requireAuth, requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const missionIdRaw = typeof req.query.missionId === "string" ? parseInt(req.query.missionId, 10) : NaN;
  const missionId = Number.isFinite(missionIdRaw) ? missionIdRaw : undefined;
  const result = await listPuzzles(req.user!, status, missionId);
  res.status(result.status).json(result.body);
});

// Staff: generate a puzzle + worked solution for preview (not persisted).
router.post("/breach/puzzles/preview", requireAuth, requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const result = previewPuzzle(req.user!, String(req.body?.difficulty ?? ""));
  res.status(result.status).json(result.body);
});

// Staff: assign + DM a puzzle (optionally the previewed grid).
router.post("/breach/puzzles", requireAuth, requireAnyRole(["ADMIN", "FIXER"]), async (req, res): Promise<void> => {
  const result = await createPuzzle(req.user!, req.body ?? {});
  res.status(result.status).json(result.body);
});

// The caller's own assigned puzzles.
router.get("/breach/mine", requireAuth, async (req, res): Promise<void> => {
  const result = await listMyPuzzles(req.user!);
  res.status(result.status).json(result.body);
});

// Lightweight count of the caller's un-started incoming breaches. Polled by the
// sidebar to flash the "My Breaches" nav when a fresh puzzle arrives. Declared
// before "/breach/puzzles/:id" so it never gets shadowed by the :id matcher.
router.get("/breach/mine/pending-count", requireAuth, async (req, res): Promise<void> => {
  const result = await countMyPendingPuzzles(req.user!);
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

// --- Practice stats (opt-in, personal-only; no economy/rewards/leaderboard) ---

// The caller's own account-synced practice stats.
router.get("/breach/practice/stats", requireAuth, async (req, res): Promise<void> => {
  const result = await getPracticeStats(req.user!);
  res.status(result.status).json(result.body);
});

// Record one practice attempt against the caller's account.
router.post("/breach/practice/record", requireAuth, async (req, res): Promise<void> => {
  const result = await recordPracticeAttempt(
    req.user!,
    req.body?.difficulty,
    req.body?.success === true,
    req.body?.elapsedMs,
  );
  res.status(result.status).json(result.body);
});

// First-sync merge of the browser's local-only stats into the account.
router.post("/breach/practice/merge", requireAuth, async (req, res): Promise<void> => {
  const result = await mergePracticeStats(req.user!, req.body?.stats);
  res.status(result.status).json(result.body);
});

// Reset the caller's account-synced practice stats.
router.delete("/breach/practice/stats", requireAuth, async (req, res): Promise<void> => {
  const result = await clearPracticeStats(req.user!);
  res.status(result.status).json(result.body);
});

// Fastest practice clear times per difficulty, by username (opted-in players).
// Public: the leaderboard is a read-only cross-user surface, viewable without login.
router.get("/breach/practice/leaderboard", async (_req, res): Promise<void> => {
  const result = await getPracticeLeaderboard();
  res.status(result.status).json(result.body);
});

export default router;
