import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArchiveCharacter } from "@workspace/api-client-react";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useUpdateArchiveCharacter: () => ({ mutate, isPending: false }),
    useListArchiveUsers: () => ({ data: [] }),
  };
});

import ArchiveEditDialog from "./ArchiveEditDialog";

beforeEach(() => {
  mutate.mockReset();
});

function makeCharacter(overrides: Partial<ArchiveCharacter> = {}): ArchiveCharacter {
  return {
    id: 7,
    name: "Status Test",
    archetype: "Solo",
    kind: "pc",
    archived: false,
    lifeStatus: "active",
    claimed: true,
    ownerId: null,
    ownerName: null,
    cwpBand: "none",
    tags: [],
    sheetData: { preamble: "", sections: {} },
    ...overrides,
  } as ArchiveCharacter;
}

function renderDialog(character: ArchiveCharacter) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ArchiveEditDialog character={character} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("ArchiveEditDialog status field", () => {
  it("defaults the status toggle to the character's current lifeStatus", () => {
    renderDialog(makeCharacter({ lifeStatus: "loa" }));
    const active = screen.getByTestId("toggle-status-loa");
    expect(active.className).toContain("border-nc-cyan");
  });

  it("sends the selected lifeStatus in the save payload", () => {
    renderDialog(makeCharacter({ lifeStatus: "active" }));

    fireEvent.click(screen.getByTestId("toggle-status-dead"));
    fireEvent.change(screen.getByTestId("input-edit-commit"), {
      target: { value: "died on stream" },
    });
    fireEvent.click(screen.getByTestId("button-edit-save"));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [payload] = mutate.mock.calls[0];
    expect(payload.id).toBe(7);
    expect(payload.data.lifeStatus).toBe("dead");
    expect(payload.data.commitMessage).toBe("died on stream");
  });

  it("does not submit without a commit message (save stays disabled)", () => {
    renderDialog(makeCharacter());

    fireEvent.click(screen.getByTestId("toggle-status-missing"));
    fireEvent.click(screen.getByTestId("button-edit-save"));

    expect(screen.getByTestId("button-edit-save")).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
