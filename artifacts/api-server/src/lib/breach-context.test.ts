import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the DM payload so we can assert the context line appears in the
// assignment DM. Discord is best-effort, so stub it to never touch the network.
vi.mock("./discord", async (orig) => {
  const actual = await orig<typeof import("./discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    postToChannel: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("./unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import { sendDirectMessage } from "./discord";
import { createUser, createAdmin, createCharacter } from "../test/testDb";
import { previewPuzzle, createPuzzle, listPuzzles, getPuzzle } from "./breach";

const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue(null);
});

// Generate + assign a puzzle to the given character's owner, returning the
// created puzzle id. Mirrors the staff preview→create flow.
async function assignPuzzle(
  staff: Awaited<ReturnType<typeof createAdmin>>,
  characterId: number,
  contextLabel: string | null | undefined,
) {
  const preview = previewPuzzle(staff, "easy");
  expect(preview.status).toBe(200);
  const body = preview.body as Extract<typeof preview.body, { grid: unknown }>;
  const created = await createPuzzle(staff, {
    assignedCharacterId: characterId,
    difficulty: "easy",
    timeLimitSeconds: 120,
    contextLabel,
    puzzle: { grid: body.grid, daemons: body.daemons, bufferSize: body.bufferSize },
  });
  expect(created.status).toBe(201);
  const view = created.body as Extract<typeof created.body, { id: number }>;
  return view.id;
}

describe("breach contextLabel round-trip", () => {
  it("persists contextLabel and surfaces it through list, get, and the assignment DM", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const character = await createCharacter({ ownerId: player.id });

    const label = "Arasaka server farm — node 7";
    const id = await assignPuzzle(staff, character.id, label);

    // Round-trips through the staff list.
    const list = await listPuzzles(staff);
    expect(list.status).toBe(200);
    const listed = (list.body as Awaited<ReturnType<typeof listPuzzles>>["body"] as Array<{ id: number; contextLabel: string | null }>).find(
      (p) => p.id === id,
    );
    expect(listed).toBeDefined();
    expect(listed!.contextLabel).toBe(label);

    // Round-trips through the single-puzzle get (staff view).
    const got = await getPuzzle(staff, id);
    expect(got.status).toBe(200);
    expect((got.body as { contextLabel: string | null }).contextLabel).toBe(label);

    // Appears in the assignment DM line.
    expect(mockDm).toHaveBeenCalledTimes(1);
    const dmBody = mockDm.mock.calls[0][1] as string;
    expect(dmBody).toContain(`Context: **${label}**`);
  });

  it("trims the label and stores null when blank, omitting the DM context line", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const character = await createCharacter({ ownerId: player.id });

    const id = await assignPuzzle(staff, character.id, "   ");

    const got = await getPuzzle(staff, id);
    expect(got.status).toBe(200);
    expect((got.body as { contextLabel: string | null }).contextLabel).toBeNull();

    const dmBody = mockDm.mock.calls[0][1] as string;
    expect(dmBody).not.toContain("Context:");
  });

  it("trims surrounding whitespace from a non-blank label", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const character = await createCharacter({ ownerId: player.id });

    const id = await assignPuzzle(staff, character.id, "  Militech vault  ");

    const got = await getPuzzle(staff, id);
    expect((got.body as { contextLabel: string | null }).contextLabel).toBe("Militech vault");

    const dmBody = mockDm.mock.calls[0][1] as string;
    expect(dmBody).toContain("Context: **Militech vault**");
  });
});
