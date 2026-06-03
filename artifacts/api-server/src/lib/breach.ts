import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  breachPuzzles,
  characters,
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
  return {
    ...row,
    createdByName: creator?.globalName ?? creator?.username ?? null,
    assignedUserName: assignee?.globalName ?? assignee?.username ?? null,
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
  const dm = await sendDirectMessage(
    player.discordId,
    `**Breach Protocol** — incoming ICE for **${character.name}**.\n` +
      `Difficulty: **${difficulty}** · Time limit: **${timeLimitSeconds}s**.${rewardLine}\n` +
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

export async function listPuzzles(staff: User, status?: string): Promise<ServiceResult<BreachPuzzleView[]>> {
  if (!isStaff(staff)) return { status: 403, body: { error: "Requires FIXER or ADMIN role" } };
  const rows = status
    ? await db.select().from(breachPuzzles).where(eq(breachPuzzles.status, status)).orderBy(desc(breachPuzzles.createdAt))
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

  // Already completed → return the recorded outcome (idempotent retry).
  if (row.completedAt) {
    const view = await shape(row);
    return {
      status: 200,
      body: {
        puzzle: view,
        success: row.status === "success",
        valid: true,
        solvedCount: row.solvedCount,
        totalDaemons,
        rewardPaid: false,
        rewardEddies: row.rewardEddies,
        rewardItemName: row.rewardItemName,
        message: "Puzzle already completed",
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
    // Lost the race to a concurrent submit — return the recorded outcome.
    const [current] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    const view = await shape(current ?? row);
    return {
      status: 200,
      body: {
        puzzle: view,
        success: (current ?? row).status === "success",
        valid: true,
        solvedCount: (current ?? row).solvedCount,
        totalDaemons,
        rewardPaid: false,
        rewardEddies: (current ?? row).rewardEddies,
        rewardItemName: (current ?? row).rewardItemName,
        message: "Puzzle already completed",
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

// Pay the success reward exactly once. rewardPaidAt is the durable guard; the
// wallet idempotency key is a second line of defense against double-pay.
async function payReward(row: BreachPuzzle): Promise<{ paid: boolean; message: string | null }> {
  if (row.rewardPaidAt) return { paid: false, message: null };

  const [player] = await db.select().from(users).where(eq(users.id, row.assignedUserId));
  if (!player) return { paid: false, message: null };

  let ledgerId: number | null = null;
  let rewardItemId: number | null = null;
  const parts: string[] = [];

  // Eddies reward via the wallet (idempotent on the key).
  if (row.rewardEddies > 0) {
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
      parts.push(`${row.rewardEddies.toLocaleString()} eddies`);
    } else {
      logger.error({ puzzleId: row.id, err: wallet.error }, "breach reward eddies payout failed");
    }
  }

  // Item reward → mint an inventory item on the assigned character.
  if (row.rewardItemName && row.assignedCharacterId) {
    const [character] = await db.select().from(characters).where(eq(characters.id, row.assignedCharacterId));
    if (character) {
      const [item] = await db
        .insert(inventoryItems)
        .values({
          characterId: character.id,
          ownerId: character.ownerId,
          name: row.rewardItemName,
          category: row.rewardItemCategory,
          quantity: 1,
          notes: row.rewardNote ?? `Breach Protocol reward (puzzle #${row.id})`,
          acquiredAt: new Date(),
        })
        .returning();
      rewardItemId = item.id;
      parts.push(row.rewardItemName);
      await recordInventoryEvent({
        instanceUuid: item.instanceUuid,
        kind: "created",
        actorId: row.createdBy,
        toCharacterId: character.id,
        toCharacterName: character.name,
        itemName: item.name,
        quantity: 1,
        reason: `Breach Protocol reward (puzzle #${row.id})`,
      });
    }
  }

  await db
    .update(breachPuzzles)
    .set({ rewardPaidAt: new Date(), rewardLedgerId: ledgerId, rewardItemId })
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
