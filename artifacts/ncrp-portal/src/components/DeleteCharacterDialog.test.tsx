import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Shared mock state — vi.hoisted lets the vi.mock factories below read these.
const h = vi.hoisted(() => ({
  deleteMutate: vi.fn(),
  invalidateQueries: vi.fn(),
  setLocation: vi.fn(),
  toast: vi.fn(),
  state: {
    isPending: false as boolean,
    capturedOptions: undefined as
      | undefined
      | { mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void } },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useDeleteCharacter: (opts: {
    mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void };
  }) => {
    h.state.capturedOptions = opts;
    return { mutate: h.deleteMutate, isPending: h.state.isPending };
  },
  getListMyCharactersQueryKey: () => ["characters", "mine"],
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/characters/9", h.setLocation],
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
  };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));

import DeleteCharacterDialog from "./DeleteCharacterDialog";

const CHAR = {
  id: 9,
  name: "Mesirah Mes",
  kind: "pc",
  approved: true,
  // Padding fields the dialog doesn't read but Character type tends to expect:
  createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  ownerId: 1,
} as any;

function renderDialog(open: boolean) {
  const onOpenChange = vi.fn();
  const utils = render(
    <DeleteCharacterDialog character={CHAR} open={open} onOpenChange={onOpenChange} />,
  );
  return { ...utils, onOpenChange };
}

describe("DeleteCharacterDialog", () => {
  beforeEach(() => {
    h.deleteMutate.mockReset();
    h.invalidateQueries.mockReset();
    h.setLocation.mockReset();
    h.toast.mockReset();
    h.state.isPending = false;
    h.state.capturedOptions = undefined;
  });

  it("keeps the delete button disabled until the typed text equals the name exactly", () => {
    renderDialog(true);

    const confirmBtn = screen.getByTestId("button-confirm-delete") as HTMLButtonElement;
    const input = screen.getByTestId("input-delete-confirm") as HTMLInputElement;

    expect(confirmBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: "Mesirah" } });
    expect(confirmBtn).toBeDisabled();

    // Trailing space must still keep it disabled — confirmation is strict.
    fireEvent.change(input, { target: { value: "Mesirah Mes " } });
    expect(confirmBtn).toBeDisabled();

    // Exact match unlocks delete.
    fireEvent.change(input, { target: { value: "Mesirah Mes" } });
    expect(confirmBtn).toBeEnabled();
  });

  it("clicking delete fires the delete mutation with the character id", () => {
    renderDialog(true);

    fireEvent.change(screen.getByTestId("input-delete-confirm"), {
      target: { value: CHAR.name },
    });
    fireEvent.click(screen.getByTestId("button-confirm-delete"));

    expect(h.deleteMutate).toHaveBeenCalledTimes(1);
    expect(h.deleteMutate).toHaveBeenCalledWith({ id: 9 });
  });

  it("does NOT fire the delete mutation while the button is disabled", () => {
    renderDialog(true);

    // No text typed — clicking the disabled button must be a no-op.
    fireEvent.click(screen.getByTestId("button-confirm-delete"));
    expect(h.deleteMutate).not.toHaveBeenCalled();
  });

  it("resets confirmation text when the dialog is reopened", () => {
    const { rerender, onOpenChange } = renderDialog(true);

    const input = screen.getByTestId("input-delete-confirm") as HTMLInputElement;
    fireEvent.change(input, { target: { value: CHAR.name } });
    expect(screen.getByTestId("button-confirm-delete")).toBeEnabled();

    // Close the dialog.
    rerender(
      <DeleteCharacterDialog character={CHAR} open={false} onOpenChange={onOpenChange} />,
    );
    // Reopen — the useEffect on `open` should wipe the confirm text.
    rerender(
      <DeleteCharacterDialog character={CHAR} open={true} onOpenChange={onOpenChange} />,
    );

    const inputAfter = screen.getByTestId("input-delete-confirm") as HTMLInputElement;
    expect(inputAfter.value).toBe("");
    expect(screen.getByTestId("button-confirm-delete")).toBeDisabled();
  });

  it("on success: toasts, invalidates the characters query, closes, and navigates", () => {
    const { onOpenChange } = renderDialog(true);

    // Force the dialog to render (and capture the mutation options).
    expect(h.state.capturedOptions?.mutation?.onSuccess).toBeTypeOf("function");

    h.state.capturedOptions!.mutation!.onSuccess!();

    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Character deleted" }),
    );
    expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["characters", "mine"],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.setLocation).toHaveBeenCalledWith("/characters");
  });
});
