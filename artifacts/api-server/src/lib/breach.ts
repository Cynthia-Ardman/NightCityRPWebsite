import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  breachPuzzles,
  breachPracticeStats,
  characters,
  missions,
  users,
  inventoryItems,
  type BreachPuzzle,
  type User,
} from "@workspace/db";
import {
  type Difficulty,
  type Pos,
  countPuzzleSolutions,
  generatePuzzleByDifficulty,
  scoreSelection,
  solvePuzzle,
} from "@workspace/breach";
import { hasRole, sendDirectMessage, postToChannel } from "./discord";
import { applyWalletDelta } from "./economy";
import { recordInventoryEvent } from "./inventoryEvents";
import { logger } from "./logger";

// A puzzle as serialized over the API. The stored row keeps grid/daemons/
// selection as jsonb; we surface them as typed arrays plus a few joined display
// names (creator, assignee, character).
export type BreachPuzzleView = BreachPuzzle & {
  createdByName: string | null;
  assignedUserName: string | null;
  missionTitle: string | null;
};

export type ServiceResult<T> = { status: number; body: T | { error: string } };

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "impossible"];

function isStaff(user: User): boolean {
  return hasRole(user.roles, "ADMIN") || hasRole(user.roles, "FIXER");
}

// The browser link a player follows to play a puzzle. Mirrors the offers play
// link pattern: prefer PUBLIC_BASE_URL, fall back to the first Replit domain.
function playLink(id: number): string {
  const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "")
    .replace(/^https?:\/\//, "");
  return portalBase ? `https://${portalBase}/breach/play/${id}` : `/breach/play/${id}`;
}

// Attach display names (creator + assignee) for the staff/history surfaces.
async function shape(row: BreachPuzzle): Promise<BreachPuzzleView> {
  const [creator] = await db
    .select({ username: users.username, globalName: users.globalName })
    .from(users)
    .where(eq(users.id, row.createdBy));
  const [assignee] = await db
    .select({ username: users.username, globalName: users.globalName })
    .from(users)
    .where(eq(users.id, row.assignedUserId));
  let missionTitle: string | null = null;
  if (row.missionId != null) {
    const [mission] = await db
      .select({ title: missions.title })
      .from(missions)
      .where(eq(missions.id, row.missionId));
    missionTitle = mission?.title ?? null;
  }
  return {
    ...row,
    createdByName: creator?.globalName ?? creator?.username ?? null,
    assignedUserName: assignee?.globalName ?? assignee?.username ?? null,
    missionTitle,
  };
}

// Hide the puzzle contents (matrix + daemon sequences) on list responses until
// the puzzle is completed. The grid is the only thing a player needs to solve
// offline, so revealing it anywhere other than getPuzzle (which anchors the
// server timer) would let a player read it from a list, solve untimed, then
// start+submit instantly. We keep the daemon COUNT (length) for history "x/y"
// displays but blank out each sequence, and blank the grid entirely.
function redactUnstarted(view: BreachPuzzleView): BreachPuzzleView {
  if (view.completedAt) return view;
  const daemonCount = Array.isArray(view.daemons) ? view.daemons.length : 0;
  return {
    ...view,
    grid: [],
    daemons: Array.from({ length: daemonCount }, () => []),
    selection: null,
  };
}

export type BreachPreview = {
  difficulty: Difficulty;
  grid: string[][];
  daemons: string[][];
  bufferSize: number;
  solutionCount: number;
  solutionPath: Pos[];
};

// Staff: generate a puzzle at a difficulty and return it WITH a worked solution
// path, without persisting anything. The fixer previews this, then calls
// createPuzzle with the previewed grid to assign exactly what they saw.
export function previewPuzzle(staff: User, difficulty: string): ServiceResult<BreachPreview> {
  if (!isStaff(staff)) return { status: 403, body: { error: "Requires FIXER or ADMIN role" } };
  const diff = difficulty as Difficulty;
  if (!DIFFICULTIES.includes(diff)) {
    return { status: 400, body: { error: "Invalid difficulty" } };
  }
  const puzzle = generatePuzzleByDifficulty(diff);
  const solutionPath = solvePuzzle(puzzle.grid, puzzle.daemons, puzzle.bufferSize) ?? [];
  return {
    status: 200,
    body: {
      difficulty: diff,
      grid: puzzle.grid,
      daemons: puzzle.daemons,
      bufferSize: puzzle.bufferSize,
      solutionCount: puzzle.solutionCount,
      solutionPath,
    },
  };
}

// Validate a previewed puzzle payload supplied by staff so createPuzzle assigns
// exactly what was generated/previewed (defends against a malformed body).
function sanitizePuzzleInput(
  p: { grid?: unknown; daemons?: unknown; bufferSize?: unknown } | undefined,
): { grid: string[][]; daemons: string[][]; bufferSize: number } | null {
  if (!p) return null;
  const grid = p.grid;
  const daemons = p.daemons;
  const bufferSize = p.bufferSize;
  if (!Array.isArray(grid) || grid.length === 0) return null;
  if (!grid.every((row) => Array.isArray(row) && row.length > 0 && row.every((c) => typeof c === "string"))) {
    return null;
  }
  if (!Array.isArray(daemons) || daemons.length === 0) return null;
  if (!daemons.every((d) => Array.isArray(d) && d.length > 0 && d.every((c) => typeof c === "string"))) {
    return null;
  }
  if (typeof bufferSize !== "number" || !Number.isFinite(bufferSize) || bufferSize < 1 || bufferSize > 12) {
    return null;
  }
  return { grid: grid as string[][], daemons: daemons as string[][], bufferSize: Math.round(bufferSize) };
}

// Staff: assign a puzzle to a character's player, persist it, and DM the player
// a play link. If `puzzle` is supplied (from a preview), that exact grid is
// assigned; otherwise a fresh puzzle is generated at the given difficulty.
export async function createPuzzle(
  staff: User,
  input: {
    assignedCharacterId: number;
    difficulty: string;
    timeLimitSeconds: number;
    rewardEddies?: number;
    rewardItemName?: string | null;
    rewardItemCategory?: string | null;
    rewardNote?: string | null;
    contextLabel?: string | null;
    missionId?: number | null;
    puzzle?: { grid?: unknown; daemons?: unknown; bufferSize?: unknown } | null;
  },
): Promise<ServiceResult<BreachPuzzleView>> {
  if (!isStaff(staff)) return { status: 403, body: { error: "Requires FIXER or ADMIN role" } };

  const difficulty = input.difficulty as Difficulty;
  if (!DIFFICULTIES.includes(difficulty)) {
    return { status: 400, body: { error: "Invalid difficulty" } };
  }
  const timeLimitSeconds = Math.round(input.timeLimitSeconds);
  if (!Number.isFinite(timeLimitSeconds) || timeLimitSeconds < 10 || timeLimitSeconds > 600) {
    return { status: 400, body: { error: "timeLimitSeconds must be between 10 and 600" } };
  }
  const rewardEddies = Math.max(0, Math.round(input.rewardEddies ?? 0));

  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, input.assignedCharacterId));
  if (!character) return { status: 404, body: { error: "Character not found" } };
  if (!character.ownerId) {
    return { status: 400, body: { error: "Character has no linked player to receive the puzzle" } };
  }
  const [player] = await db.select().from(users).where(eq(users.id, character.ownerId));
  if (!player) return { status: 400, body: { error: "Character owner is not a registered player" } };

  // Optional hard link to a real mission. Validate it exists and snapshot its
  // title into contextLabel when the staff member didn't type their own label,
  // so the breach log + DM still read well even if the mission is later renamed
  // or deleted.
  let missionId: number | null = null;
  let contextLabel = input.contextLabel?.trim() ? input.contextLabel.trim() : null;
  if (input.missionId != null) {
    const [mission] = await db
      .select({ id: missions.id, title: missions.title })
      .from(missions)
      .where(eq(missions.id, input.missionId));
    if (!mission) return { status: 404, body: { error: "Mission not found" } };
    missionId = mission.id;
    if (!contextLabel) contextLabel = mission.title;
  }

  // Use the previewed puzzle when provided (so staff assign exactly what they
  // saw); otherwise generate a fresh one at the requested difficulty.
  let puzzle: { grid: string[][]; daemons: string[][]; bufferSize: number; solutionCount: number };
  if (input.puzzle) {
    const sanitized = sanitizePuzzleInput(input.puzzle);
    if (!sanitized) return { status: 400, body: { error: "Invalid puzzle payload" } };
    puzzle = {
      ...sanitized,
      solutionCount: countPuzzleSolutions(sanitized.grid, sanitized.daemons),
    };
  } else {
    puzzle = generatePuzzleByDifficulty(difficulty);
  }

  const [row] = await db
    .insert(breachPuzzles)
    .values({
      createdBy: staff.id,
      assignedUserId: player.id,
      assignedCharacterId: character.id,
      assignedCharacterName: character.name,
      difficulty,
      timeLimitSeconds,
      grid: puzzle.grid,
      daemons: puzzle.daemons,
      bufferSize: puzzle.bufferSize,
      solutionCount: puzzle.solutionCount,
      rewardEddies,
      rewardItemName: input.rewardItemName ?? null,
      rewardItemCategory: input.rewardItemCategory ?? null,
      rewardNote: input.rewardNote ?? null,
      contextLabel,
      missionId,
      status: "sent",
    })
    .returning();

  // DM the player a play link (best-effort; record delivery).
  const link = playLink(row.id);
  const rewardLine = rewardEddies > 0 || input.rewardItemName
    ? `\nReward on success: ${[
        rewardEddies > 0 ? `${rewardEddies.toLocaleString()} eddies` : null,
        input.rewardItemName ? `**${input.rewardItemName}**` : null,
      ].filter(Boolean).join(" + ")}`
    : "";
  const contextLine = row.contextLabel ? `\nContext: **${row.contextLabel}**` : "";
  const dm = await sendDirectMessage(
    player.discordId,
    `**Breach Protocol** — incoming ICE for **${character.name}**.\n` +
      `Difficulty: **${difficulty}** · Time limit: **${timeLimitSeconds}s**.${contextLine}${rewardLine}\n` +
      `Jack in: ${link}`,
  );
  if (dm) {
    const [updated] = await db
      .update(breachPuzzles)
      .set({ dmSentAt: new Date() })
      .where(eq(breachPuzzles.id, row.id))
      .returning();
    return { status: 201, body: await shape(updated) };
  }
  return { status: 201, body: await shape(row) };
}

export async function listPuzzles(
  staff: User,
  status?: string,
  missionId?: number,
): Promise<ServiceResult<BreachPuzzleView[]>> {
  if (!isStaff(staff)) return { status: 403, body: { error: "Requires FIXER or ADMIN role" } };
  const filters = [
    status ? eq(breachPuzzles.status, status) : undefined,
    missionId != null ? eq(breachPuzzles.missionId, missionId) : undefined,
  ].filter(Boolean);
  const rows = filters.length
    ? await db
        .select()
        .from(breachPuzzles)
        .where(filters.length === 1 ? filters[0] : and(...filters))
        .orderBy(desc(breachPuzzles.createdAt))
    : await db.select().from(breachPuzzles).orderBy(desc(breachPuzzles.createdAt));
  return { status: 200, body: await Promise.all(rows.map(shape)) };
}

export async function listMyPuzzles(user: User): Promise<ServiceResult<BreachPuzzleView[]>> {
  const rows = await db
    .select()
    .from(breachPuzzles)
    .where(eq(breachPuzzles.assignedUserId, user.id))
    .orderBy(desc(breachPuzzles.createdAt));
  const shaped = await Promise.all(rows.map(shape));
  return { status: 200, body: shaped.map(redactUnstarted) };
}

export async function listCharacterPuzzles(user: User, characterId: number): Promise<ServiceResult<BreachPuzzleView[]>> {
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) return { status: 404, body: { error: "Character not found" } };
  if (!isStaff(user) && character.ownerId !== user.id) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  const rows = await db
    .select()
    .from(breachPuzzles)
    .where(eq(breachPuzzles.assignedCharacterId, characterId))
    .orderBy(desc(breachPuzzles.createdAt));
  const shaped = await Promise.all(rows.map(shape));
  // Staff may inspect full puzzle contents; the owner only sees redacted rows
  // until each puzzle is completed (same anti-offline-solve rule as listMy).
  return { status: 200, body: isStaff(user) ? shaped : shaped.map(redactUnstarted) };
}

export async function getPuzzle(user: User, id: number): Promise<ServiceResult<BreachPuzzleView>> {
  const [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
  if (!row) return { status: 404, body: { error: "Not found" } };
  if (!isStaff(user) && row.assignedUserId !== user.id) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  // Server-authoritative timer anchor: the assigned player can only see the grid
  // by fetching it, so we start the clock here (idempotently) the first time the
  // player loads the puzzle. This closes the bypass where a client skips /start,
  // solves offline, and posts /result. Staff viewing never starts the clock.
  if (
    row.assignedUserId === user.id &&
    !row.completedAt &&
    !row.startedAt
  ) {
    const [started] = await db
      .update(breachPuzzles)
      .set({ startedAt: new Date(), status: "in_progress" })
      .where(and(eq(breachPuzzles.id, id), isNull(breachPuzzles.startedAt)))
      .returning();
    if (started) return { status: 200, body: await shape(started) };
    const [fresh] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    return { status: 200, body: await shape(fresh ?? row) };
  }
  return { status: 200, body: await shape(row) };
}

// Player: start the server-authoritative timer. Idempotent — once startedAt is
// set it never moves, so a refresh can't reset the clock.
export async function startPuzzle(user: User, id: number): Promise<ServiceResult<BreachPuzzleView>> {
  const [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
  if (!row) return { status: 404, body: { error: "Not found" } };
  if (row.assignedUserId !== user.id) return { status: 403, body: { error: "Forbidden" } };
  if (row.completedAt) return { status: 409, body: { error: "Puzzle already completed" } };
  if (row.startedAt) return { status: 200, body: await shape(row) };
  const [updated] = await db
    .update(breachPuzzles)
    .set({ startedAt: new Date(), status: "in_progress" })
    .where(and(eq(breachPuzzles.id, id), eq(breachPuzzles.assignedUserId, user.id)))
    .returning();
  return { status: 200, body: await shape(updated) };
}

export type SubmitResult = {
  puzzle: BreachPuzzleView;
  success: boolean;
  valid: boolean;
  solvedCount: number;
  totalDaemons: number;
  rewardPaid: boolean;
  rewardEddies: number;
  rewardItemName: string | null;
  message: string | null;
};

// Player: submit the final path. Server scores authoritatively, records the
// outcome once (idempotent on completedAt), pays any reward exactly once
// (idempotency key guards double-pay), and notifies staff.
export async function submitResult(
  user: User,
  id: number,
  selection: Pos[],
): Promise<ServiceResult<SubmitResult>> {
  const [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
  if (!row) return { status: 404, body: { error: "Not found" } };
  if (row.assignedUserId !== user.id) return { status: 403, body: { error: "Forbidden" } };

  const grid = row.grid as string[][];
  const daemons = row.daemons as string[][];
  const totalDaemons = daemons.length;

  // Already completed → return the recorded outcome (idempotent retry). If this
  // was a success whose reward never fully settled — e.g. a crash between the
  // completion write and payout, or a partial payout — retry settlement here so
  // the player eventually gets paid. payReward is idempotent and only stamps
  // rewardPaidAt once everything has settled.
  if (row.completedAt) {
    const { rewardPaid, rewardMessage } = await settleIfNeeded(row);
    const [current] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    const settled = current ?? row;
    const view = await shape(settled);
    return {
      status: 200,
      body: {
        puzzle: view,
        success: settled.status === "success",
        valid: true,
        solvedCount: settled.solvedCount,
        totalDaemons,
        rewardPaid,
        rewardEddies: settled.rewardEddies,
        rewardItemName: settled.rewardItemName,
        message: rewardMessage
          ? `Reward settled: ${rewardMessage}`
          : "Puzzle already completed",
      },
    };
  }

  // Time-limit enforcement: the timer is anchored server-side when the player
  // first fetches the puzzle (getPuzzle). A submission with no startedAt means
  // the client never legitimately opened the puzzle (e.g. a direct POST to
  // bypass the clock) — record it as expired. Otherwise compare against the
  // server clock.
  const now = new Date();
  let timeTakenSeconds: number | null = null;
  let expired = false;
  if (row.startedAt) {
    timeTakenSeconds = Math.round((now.getTime() - row.startedAt.getTime()) / 1000);
    if (timeTakenSeconds > row.timeLimitSeconds) expired = true;
  } else {
    expired = true;
  }

  const score = scoreSelection(grid, daemons, row.bufferSize, Array.isArray(selection) ? selection : []);
  const valid = !expired && score.valid;
  const solvedCount = valid ? score.solvedDaemons.length : 0;
  const success = !expired && score.allSolved;
  const finalStatus = expired ? "expired" : success ? "success" : "failed";

  // Atomic check-and-set: only the request that flips completedAt from NULL
  // proceeds to score/pay. A concurrent second submit updates zero rows and
  // falls through to the idempotent already-completed reply below — this is
  // what guarantees the reward (incl. item minting) is granted exactly once.
  const [updated] = await db
    .update(breachPuzzles)
    .set({
      status: finalStatus,
      selection,
      solvedCount,
      timeTakenSeconds,
      completedAt: now,
      startedAt: row.startedAt ?? now,
    })
    .where(
      and(
        eq(breachPuzzles.id, id),
        eq(breachPuzzles.assignedUserId, user.id),
        isNull(breachPuzzles.completedAt),
      ),
    )
    .returning();

  if (!updated) {
    // Lost the race to a concurrent submit — return the recorded outcome, but
    // still retry reward settlement in case the winning request flipped
    // completedAt and then failed to pay.
    const [current] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    const { rewardPaid, rewardMessage } = await settleIfNeeded(current ?? row);
    const [after] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    const finalRow = after ?? current ?? row;
    const view = await shape(finalRow);
    return {
      status: 200,
      body: {
        puzzle: view,
        success: finalRow.status === "success",
        valid: true,
        solvedCount: finalRow.solvedCount,
        totalDaemons,
        rewardPaid,
        rewardEddies: finalRow.rewardEddies,
        rewardItemName: finalRow.rewardItemName,
        message: rewardMessage
          ? `Reward settled: ${rewardMessage}`
          : "Puzzle already completed",
      },
    };
  }

  let rewardPaid = false;
  let rewardMessage: string | null = null;
  if (success) {
    const paid = await payReward(updated);
    rewardPaid = paid.paid;
    rewardMessage = paid.message;
  }

  await notifyStaff(updated, success, expired);

  const view = await shape(updated);
  return {
    status: 200,
    body: {
      puzzle: view,
      success,
      valid,
      solvedCount,
      totalDaemons,
      rewardPaid,
      rewardEddies: updated.rewardEddies,
      rewardItemName: updated.rewardItemName,
      message: expired
        ? "Time expired — connection terminated."
        : success
          ? "Breach successful."
          : "Breach failed.",
    },
  };
}

// Retry reward settlement for an already-completed puzzle when it was a success
// that has not yet been fully paid. Used by the idempotent already-completed
// reply paths so a crash (or a partial payout) between completion and payout
// eventually settles on a later submit.
async function settleIfNeeded(
  p: BreachPuzzle,
): Promise<{ rewardPaid: boolean; rewardMessage: string | null }> {
  if (p.status === "success" && !p.rewardPaidAt) {
    const paid = await payReward(p);
    return { rewardPaid: paid.paid, rewardMessage: paid.message };
  }
  return { rewardPaid: false, rewardMessage: null };
}

// Discriminated result of the item-mint critical section so the caller can tell
// a fresh mint (which must emit an inventory event) from a no-op (item already
// minted by a prior attempt).
type MintResult =
  | { id: number; fresh: false }
  | { id: number; fresh: true; instanceUuid: string; characterName: string; itemName: string };

// Pay the success reward, eventually-exactly-once. Each reward part has its own
// durable guard: eddies are idempotent on the wallet key, and the item mint is
// guarded by rewardItemId under a row lock. rewardPaidAt is stamped ONLY once
// every required part has settled — a partial payout leaves it NULL so a later
// submit retries just the unsettled part (never re-paying what already landed).
async function payReward(row: BreachPuzzle): Promise<{ paid: boolean; message: string | null }> {
  if (row.rewardPaidAt) return { paid: false, message: null };

  const [player] = await db.select().from(users).where(eq(users.id, row.assignedUserId));
  if (!player) return { paid: false, message: null };

  const assignedCharacterId = row.assignedCharacterId;
  const rewardItemName = row.rewardItemName;
  const needsEddies = row.rewardEddies > 0;
  const needsItem = !!(rewardItemName && assignedCharacterId);

  // No reward configured → stamp settled so a successful no-reward puzzle is not
  // retried on every subsequent submit.
  if (!needsEddies && !needsItem) {
    await db
      .update(breachPuzzles)
      .set({ rewardPaidAt: new Date() })
      .where(and(eq(breachPuzzles.id, row.id), isNull(breachPuzzles.rewardPaidAt)));
    return { paid: false, message: null };
  }

  let ledgerId = row.rewardLedgerId ?? null;
  let rewardItemId = row.rewardItemId ?? null;
  let eddiesSettled = !needsEddies || ledgerId != null;
  let itemSettled = !needsItem || rewardItemId != null;
  const parts: string[] = [];

  // 1) Eddies — applyWalletDelta reserves a ledger row before the external UB
  //    call and is idempotent on the key, so it is safe to call without a lock
  //    and safe to retry.
  if (needsEddies && !eddiesSettled) {
    const wallet = await applyWalletDelta({
      userId: player.id,
      discordId: player.discordId,
      amount: row.rewardEddies,
      source: "admin",
      kind: "breach_reward",
      reason: `Breach Protocol reward (puzzle #${row.id})`,
      characterId: row.assignedCharacterId,
      relatedEntityType: "breach_puzzle",
      relatedEntityId: row.id,
      idempotencyKey: `breach-reward-${row.id}`,
    });
    if (wallet.ok) {
      ledgerId = wallet.ledgerId ?? null;
      eddiesSettled = true;
      parts.push(`${row.rewardEddies.toLocaleString()} eddies`);
    } else {
      logger.error({ puzzleId: row.id, err: wallet.error }, "breach reward eddies payout failed");
    }
  }

  // 2) Item — minting is NOT idempotent, so claim the right to mint under a row
  //    lock (re-checking rewardItemId inside the tx) before inserting. This
  //    serializes concurrent retries so the item is granted exactly once.
  if (needsItem && !itemSettled && rewardItemName && assignedCharacterId) {
    const minted: MintResult | null = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(breachPuzzles)
        .where(eq(breachPuzzles.id, row.id))
        .for("update");
      if (!locked) return null;
      if (locked.rewardItemId) return { id: locked.rewardItemId, fresh: false };
      const [character] = await tx
        .select()
        .from(characters)
        .where(eq(characters.id, assignedCharacterId));
      if (!character) return null;
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          characterId: character.id,
          ownerId: character.ownerId,
          name: rewardItemName,
          category: row.rewardItemCategory,
          quantity: 1,
          notes: row.rewardNote ?? `Breach Protocol reward (puzzle #${row.id})`,
          acquiredAt: new Date(),
        })
        .returning();
      await tx
        .update(breachPuzzles)
        .set({ rewardItemId: item.id })
        .where(eq(breachPuzzles.id, row.id));
      return {
        id: item.id,
        fresh: true,
        instanceUuid: item.instanceUuid,
        characterName: character.name,
        itemName: item.name,
      };
    });
    if (minted) {
      rewardItemId = minted.id;
      itemSettled = true;
      parts.push(rewardItemName);
      if (minted.fresh) {
        await recordInventoryEvent({
          instanceUuid: minted.instanceUuid,
          kind: "created",
          actorId: row.createdBy,
          toCharacterId: assignedCharacterId,
          toCharacterName: minted.characterName,
          itemName: minted.itemName,
          quantity: 1,
          reason: `Breach Protocol reward (puzzle #${row.id})`,
        });
      }
    }
  }

  const fullySettled = eddiesSettled && itemSettled;

  // Persist whatever settled (ledger/item ids). Only stamp rewardPaidAt once
  // EVERY required part has settled; otherwise leave it NULL so a later submit
  // retries the rest. Writes coalesce against the stored value so a lagging
  // concurrent attempt can never null-out a column another attempt already
  // populated (state only ever advances, never regresses).
  await db
    .update(breachPuzzles)
    .set({
      rewardLedgerId: sql`coalesce(${breachPuzzles.rewardLedgerId}, ${ledgerId})`,
      rewardItemId: sql`coalesce(${breachPuzzles.rewardItemId}, ${rewardItemId})`,
      ...(fullySettled
        ? { rewardPaidAt: sql`coalesce(${breachPuzzles.rewardPaidAt}, now())` }
        : {}),
    })
    .where(eq(breachPuzzles.id, row.id));

  return { paid: parts.length > 0, message: parts.length > 0 ? parts.join(" + ") : null };
}

// Notify the assigning staff member (DM) + the staff approval channel that a
// puzzle resolved.
async function notifyStaff(row: BreachPuzzle, success: boolean, expired: boolean): Promise<void> {
  const outcome = success ? "✅ SUCCESS" : expired ? "⌛ EXPIRED" : "❌ FAILED";
  const who = row.assignedCharacterName ?? "a runner";
  const line = `**Breach Protocol** — puzzle #${row.id} (${row.difficulty}) for **${who}**: ${outcome} (${row.solvedCount} daemon(s) breached).`;
  try {
    const [staff] = await db.select().from(users).where(eq(users.id, row.createdBy));
    if (staff) await sendDirectMessage(staff.discordId, line);
  } catch (err) {
    logger.error({ puzzleId: row.id, err }, "breach staff DM notify failed");
  }
  const channelId = process.env.CS_APPROVAL_CHANNEL_ID;
  if (channelId) {
    try {
      await postToChannel(channelId, line);
    } catch (err) {
      logger.error({ puzzleId: row.id, err }, "breach staff channel notify failed");
    }
  }
}

// ---------------------------------------------------------------------------
// PRACTICE STATS (opt-in, account-synced, personal-only)
// ---------------------------------------------------------------------------
// These mirror the local-only practice progress kept in the browser. They are
// NEVER part of the economy, rewards, leaderboards, or the assigned-puzzle
// flow. The practice page stays "not recorded"; this only lets a player carry
// THEIR OWN attempts/solves/fastest-clear across their devices.

export type PracticeDifficultyStats = {
  attempts: number;
  solves: number;
  fastestClearMs: number | null;
};

export type PracticeStatsView = Record<Difficulty, PracticeDifficultyStats>;

function emptyPracticeDifficulty(): PracticeDifficultyStats {
  return { attempts: 0, solves: 0, fastestClearMs: null };
}

function emptyPracticeStats(): PracticeStatsView {
  return {
    easy: emptyPracticeDifficulty(),
    medium: emptyPracticeDifficulty(),
    hard: emptyPracticeDifficulty(),
    impossible: emptyPracticeDifficulty(),
  };
}

function isValidDifficulty(raw: unknown): raw is Difficulty {
  return typeof raw === "string" && (DIFFICULTIES as string[]).includes(raw);
}

// Coerce an arbitrary client-supplied difficulty stat blob into a safe shape.
function sanitizePracticeDifficulty(raw: unknown): PracticeDifficultyStats {
  const base = emptyPracticeDifficulty();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const attempts = typeof r.attempts === "number" && Number.isFinite(r.attempts) ? Math.max(0, Math.floor(r.attempts)) : 0;
  const solves = typeof r.solves === "number" && Number.isFinite(r.solves) ? Math.max(0, Math.floor(r.solves)) : 0;
  base.attempts = attempts;
  base.solves = Math.min(solves, attempts);
  if (typeof r.fastestClearMs === "number" && Number.isFinite(r.fastestClearMs) && r.fastestClearMs >= 0) {
    base.fastestClearMs = Math.floor(r.fastestClearMs);
  }
  return base;
}

async function readPracticeStats(userId: string): Promise<PracticeStatsView> {
  const rows = await db
    .select()
    .from(breachPracticeStats)
    .where(eq(breachPracticeStats.userId, userId));
  const out = emptyPracticeStats();
  for (const row of rows) {
    if (isValidDifficulty(row.difficulty)) {
      out[row.difficulty] = {
        attempts: row.attempts,
        solves: row.solves,
        fastestClearMs: row.fastestClearMs,
      };
    }
  }
  return out;
}

export async function getPracticeStats(user: User): Promise<ServiceResult<PracticeStatsView>> {
  return { status: 200, body: await readPracticeStats(user.id) };
}

// Record a single practice attempt against the user's account. Atomic upsert:
// attempts += 1, solves += (success ? 1 : 0), fastest = min(existing, elapsed).
export async function recordPracticeAttempt(
  user: User,
  rawDifficulty: unknown,
  success: boolean,
  rawElapsedMs: unknown,
): Promise<ServiceResult<PracticeStatsView>> {
  if (!isValidDifficulty(rawDifficulty)) {
    return { status: 400, body: { error: "Invalid difficulty" } };
  }
  const difficulty = rawDifficulty;
  const won = success === true;
  const elapsedMs =
    typeof rawElapsedMs === "number" && Number.isFinite(rawElapsedMs) && rawElapsedMs >= 0
      ? Math.floor(rawElapsedMs)
      : null;
  // Only a winning attempt contributes a clear time.
  const clearMs = won ? elapsedMs : null;
  await db
    .insert(breachPracticeStats)
    .values({
      userId: user.id,
      difficulty,
      attempts: 1,
      solves: won ? 1 : 0,
      fastestClearMs: clearMs,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [breachPracticeStats.userId, breachPracticeStats.difficulty],
      set: {
        attempts: sql`${breachPracticeStats.attempts} + 1`,
        solves: sql`${breachPracticeStats.solves} + ${won ? 1 : 0}`,
        // Keep the smaller (better) of the existing best and this clear time.
        fastestClearMs:
          clearMs === null
            ? sql`${breachPracticeStats.fastestClearMs}`
            : sql`LEAST(COALESCE(${breachPracticeStats.fastestClearMs}, ${clearMs}), ${clearMs})`,
        updatedAt: new Date(),
      },
    });
  return { status: 200, body: await readPracticeStats(user.id) };
}

// First-sync merge: fold the browser's local-only stats into the account,
// summing attempts/solves and keeping the better (smaller) fastest clear.
// Idempotency is the caller's responsibility (the client clears its local
// snapshot after a successful merge so the same history is not re-added).
export async function mergePracticeStats(
  user: User,
  rawStats: unknown,
): Promise<ServiceResult<PracticeStatsView>> {
  const incoming = (rawStats && typeof rawStats === "object" ? rawStats : {}) as Record<string, unknown>;
  for (const difficulty of DIFFICULTIES) {
    const local = sanitizePracticeDifficulty(incoming[difficulty]);
    if (local.attempts === 0 && local.solves === 0 && local.fastestClearMs === null) continue;
    await db
      .insert(breachPracticeStats)
      .values({
        userId: user.id,
        difficulty,
        attempts: local.attempts,
        solves: local.solves,
        fastestClearMs: local.fastestClearMs,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [breachPracticeStats.userId, breachPracticeStats.difficulty],
        set: {
          attempts: sql`${breachPracticeStats.attempts} + ${local.attempts}`,
          solves: sql`${breachPracticeStats.solves} + ${local.solves}`,
          fastestClearMs:
            local.fastestClearMs === null
              ? sql`${breachPracticeStats.fastestClearMs}`
              : sql`LEAST(COALESCE(${breachPracticeStats.fastestClearMs}, ${local.fastestClearMs}), ${local.fastestClearMs})`,
          updatedAt: new Date(),
        },
      });
  }
  return { status: 200, body: await readPracticeStats(user.id) };
}

export async function clearPracticeStats(user: User): Promise<ServiceResult<PracticeStatsView>> {
  await db.delete(breachPracticeStats).where(eq(breachPracticeStats.userId, user.id));
  return { status: 200, body: emptyPracticeStats() };
}
