import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Shared mock state — vi.hoisted lets the vi.mock factories below read these.
const h = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  invalidateQueries: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  state: {
    isPending: false as boolean,
    capturedOptions: undefined as
      | undefined
      | {
          mutation?: {
            onSuccess?: (resp: unknown) => void;
            onError?: (err: unknown) => void;
          };
        },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useUpdateCharacter: (opts: {
    mutation?: {
      onSuccess?: (resp: unknown) => void;
      onError?: (err: unknown) => void;
    };
  }) => {
    h.state.capturedOptions = opts;
    return { mutate: h.updateMutate, isPending: h.state.isPending };
  },
  getGetCharacterPendingEditQueryKey: (id: number) => [
    "character-pending-edit",
    id,
  ],
  getListPendingEditsQueryKey: () => ["pending-edits"],
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/characters/9", h.navigate],
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
  };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));

// The upload helper performs a real network round trip. Stub it so the file
// pickers in the embedded ImageEditor don't blow up if they're ever clicked.
vi.mock("@/lib/uploadImage", () => ({ uploadImage: vi.fn() }));

import EditCharacterDialog from "./EditCharacterDialog";

// Cast as any — Character is a wide generated type and the dialog only reads
// the fields we set here (mirrors the DeleteCharacterDialog test pattern).
const CHAR = {
  id: 9,
  name: "Mesirah Mes",
  kind: "pc",
  approved: true,
  archetype: "Solo",
  background: "Heywood",
  portraitUrl: "https://img/1.png",
  portraitUrls: ["https://img/1.png", "https://img/2.png"],
  statsImageUrls: ["https://img/stats.png"],
  lifeStatus: "active",
  traumaTeamTier: "gold",
  xanaduGold: true,
  sheetData: {
    preamble: "Hello world",
    sections: { Backstory: "Born here.", Quirks: "loud" },
  },
  createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  ownerId: 1,
} as any;

function renderDialog(
  overrides?: Partial<React.ComponentProps<typeof EditCharacterDialog>>,
) {
  const onOpenChange = vi.fn();
  const utils = render(
    <EditCharacterDialog
      character={CHAR}
      open
      onOpenChange={onOpenChange}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange };
}

describe("EditCharacterDialog", () => {
  beforeEach(() => {
    h.updateMutate.mockReset();
    h.invalidateQueries.mockReset();
    h.navigate.mockReset();
    h.toast.mockReset();
    h.state.isPending = false;
    h.state.capturedOptions = undefined;
  });

  it("prefills every editable field from the passed character", () => {
    renderDialog();

    expect(
      (screen.getByTestId("input-edit-name") as HTMLInputElement).value,
    ).toBe("Mesirah Mes");
    expect(
      (screen.getByTestId("input-edit-archetype") as HTMLInputElement).value,
    ).toBe("Solo");
    expect(
      (screen.getByTestId("select-edit-life-status") as HTMLSelectElement)
        .value,
    ).toBe("active");
    expect(
      (screen.getByTestId("select-edit-trauma-tier") as HTMLSelectElement)
        .value,
    ).toBe("gold");
    expect(
      (screen.getByTestId("checkbox-edit-xanadu-gold") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByTestId("input-edit-background") as HTMLTextAreaElement)
        .value,
    ).toBe("Heywood");
    expect(
      (screen.getByTestId("input-edit-preamble") as HTMLTextAreaElement).value,
    ).toBe("Hello world");

    // sheetData.sections is converted to editable rows in declaration order.
    expect(
      (screen.getByTestId("input-section-key-0") as HTMLInputElement).value,
    ).toBe("Backstory");
    expect(
      (screen.getByTestId("input-section-value-0") as HTMLTextAreaElement)
        .value,
    ).toBe("Born here.");
    expect(
      (screen.getByTestId("input-section-key-1") as HTMLInputElement).value,
    ).toBe("Quirks");
    expect(
      (screen.getByTestId("input-section-value-1") as HTMLTextAreaElement)
        .value,
    ).toBe("loud");
  });

  it("blocks the save and toasts when the name is blank/whitespace", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("input-edit-name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("button-save-edit"));

    expect(h.updateMutate).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Name required" }),
    );
  });

  it("submits the edited fields via the update mutation with the right payload", () => {
    renderDialog();

    fireEvent.change(screen.getByTestId("input-edit-name"), {
      target: { value: "Mesirah Renamed" },
    });
    fireEvent.change(screen.getByTestId("input-edit-archetype"), {
      target: { value: "Netrunner" },
    });
    fireEvent.change(screen.getByTestId("select-edit-life-status"), {
      target: { value: "loa" },
    });
    fireEvent.change(screen.getByTestId("select-edit-trauma-tier"), {
      target: { value: "platinum" },
    });
    // Toggle xanaduGold from true -> false.
    fireEvent.click(screen.getByTestId("checkbox-edit-xanadu-gold"));
    fireEvent.change(screen.getByTestId("input-edit-update-note"), {
      target: { value: "  refit  " },
    });

    fireEvent.click(screen.getByTestId("button-save-edit"));

    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    const call = h.updateMutate.mock.calls[0][0] as {
      id: number;
      data: {
        name: string;
        archetype?: string;
        background: string;
        portraitUrl: string | null;
        portraitUrls: string[];
        statsImageUrls: string[];
        sheetData: { preamble: string; sections: Record<string, string> };
        lifeStatus: string;
        traumaTeamTier: string | null;
        xanaduGold: boolean;
        updateNote?: string;
      };
    };

    expect(call.id).toBe(9);
    expect(call.data.name).toBe("Mesirah Renamed");
    expect(call.data.archetype).toBe("Netrunner");
    expect(call.data.lifeStatus).toBe("loa");
    expect(call.data.traumaTeamTier).toBe("platinum");
    expect(call.data.xanaduGold).toBe(false);
    expect(call.data.background).toBe("Heywood");
    expect(call.data.portraitUrl).toBe("https://img/1.png");
    expect(call.data.portraitUrls).toEqual([
      "https://img/1.png",
      "https://img/2.png",
    ]);
    expect(call.data.statsImageUrls).toEqual(["https://img/stats.png"]);
    expect(call.data.sheetData).toEqual({
      preamble: "Hello world",
      sections: { Backstory: "Born here.", Quirks: "loud" },
    });
    // updateNote is trimmed before being sent.
    expect(call.data.updateNote).toBe("refit");
  });

  it("omits empty optional fields from the payload (archetype, updateNote)", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("input-edit-archetype"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("button-save-edit"));

    const call = h.updateMutate.mock.calls[0][0] as {
      data: { archetype?: string; updateNote?: string };
    };
    expect(call.data.archetype).toBeUndefined();
    expect(call.data.updateNote).toBeUndefined();
  });

  it("on success with a pendingEditId: toasts, invalidates queries, closes, navigates", () => {
    const { onOpenChange } = renderDialog();
    // Ensure the hook captured a onSuccess handler.
    expect(h.state.capturedOptions?.mutation?.onSuccess).toBeTypeOf("function");

    h.state.capturedOptions!.mutation!.onSuccess!({ pendingEditId: 77 });

    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Submitted for review" }),
    );
    expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["character-pending-edit", 9],
    });
    expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["pending-edits"],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.navigate).toHaveBeenCalledWith("/pending-edits/77");
  });

  it("on success without a pendingEditId: still toasts and closes, but does not navigate", () => {
    const { onOpenChange } = renderDialog();
    h.state.capturedOptions!.mutation!.onSuccess!({});
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("on a 409 with an existing pendingEditId: opens that pending edit instead", () => {
    const { onOpenChange } = renderDialog();
    expect(h.state.capturedOptions?.mutation?.onError).toBeTypeOf("function");

    h.state.capturedOptions!.mutation!.onError!({
      response: { data: { pendingEditId: 42 } },
    });

    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Edit already pending" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.navigate).toHaveBeenCalledWith("/pending-edits/42");
  });

  it("on a generic error: shows a destructive 'Save failed' toast", () => {
    renderDialog();
    h.state.capturedOptions!.mutation!.onError!({
      response: { data: { error: "boom" } },
    });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Save failed",
        description: "boom",
        variant: "destructive",
      }),
    );
  });

  it("reopening with a different character resets the form fields", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <EditCharacterDialog
        character={CHAR}
        open
        onOpenChange={onOpenChange}
      />,
    );

    // User edits the name in-place.
    fireEvent.change(screen.getByTestId("input-edit-name"), {
      target: { value: "Temp Edit" },
    });
    expect(
      (screen.getByTestId("input-edit-name") as HTMLInputElement).value,
    ).toBe("Temp Edit");

    // Close and reopen with a different character — the effect on `open` +
    // `character` should reset everything from the new character.
    rerender(
      <EditCharacterDialog
        character={CHAR}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    const OTHER = { ...CHAR, id: 12, name: "Other Choomba", archetype: "Fixer" };
    rerender(
      <EditCharacterDialog
        character={OTHER}
        open
        onOpenChange={onOpenChange}
      />,
    );

    expect(
      (screen.getByTestId("input-edit-name") as HTMLInputElement).value,
    ).toBe("Other Choomba");
    expect(
      (screen.getByTestId("input-edit-archetype") as HTMLInputElement).value,
    ).toBe("Fixer");
  });
});
