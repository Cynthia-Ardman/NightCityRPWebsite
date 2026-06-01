import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArchiveCharacter } from "@workspace/api-client-react";

const { mutate, delMutate } = vi.hoisted(() => ({ mutate: vi.fn(), delMutate: vi.fn() }));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useUpdateArchiveCharacter: () => ({ mutate, isPending: false }),
    useDeleteCharacter: () => ({ mutate: delMutate, isPending: false }),
    useListArchiveUsers: () => ({ data: [] }),
  };
});

import ArchiveEditDialog from "./ArchiveEditDialog";

beforeEach(() => {
  mutate.mockReset();
  delMutate.mockReset();
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

function renderDialog(character: ArchiveCharacter, isAdmin = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ArchiveEditDialog character={character} open onOpenChange={() => {}} isAdmin={isAdmin} />
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

describe("ArchiveEditDialog admin delete", () => {
  it("hides the danger zone for non-admins", () => {
    renderDialog(makeCharacter());
    expect(screen.queryByTestId("section-danger-zone")).toBeNull();
  });

  it("shows the danger zone for admins, gated until DELETE is typed", () => {
    renderDialog(makeCharacter(), true);

    expect(screen.getByTestId("section-danger-zone")).toBeInTheDocument();
    const button = screen.getByTestId("button-confirm-delete");
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByTestId("input-delete-confirm"), {
      target: { value: "delete" },
    });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByTestId("input-delete-confirm"), {
      target: { value: "DELETE" },
    });
    expect(button).not.toBeDisabled();
  });

  it("calls delete with the character id once confirmed", () => {
    renderDialog(makeCharacter({ id: 42 }), true);

    fireEvent.change(screen.getByTestId("input-delete-confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("button-confirm-delete"));

    expect(delMutate).toHaveBeenCalledTimes(1);
    expect(delMutate.mock.calls[0][0]).toEqual({ id: 42 });
  });
});
