import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";

// --- Mocks -----------------------------------------------------------------
// The sheet form pulls every server interaction through generated react-query
// hooks. We stub the whole module so the component renders without a real API
// or QueryClientProvider, and so we can assert that the debounced autosave
// actually calls the create mutation.
const submitMutateAsync = vi.fn().mockResolvedValue({ id: 123 });
const updateMutateAsync = vi.fn().mockResolvedValue({ id: 123 });

vi.mock("@workspace/api-client-react", () => ({
  useSubmitSheet: () => ({ mutateAsync: submitMutateAsync, isPending: false }),
  useUpdateSheet: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useSubmitDraftSheet: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useDeleteSheet: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useGetSheet: () => ({ data: undefined, isLoading: false }),
  useListCyberware: () => ({ data: [] }),
  // useAuthMe is a thin wrapper around useGetMe from this same module.
  useGetMe: () => ({ data: { id: 1, isFixer: false, isAdmin: false }, isLoading: false }),
  getGetMeQueryKey: () => ["me"],
  getListMySheetsQueryKey: () => ["sheets", "mine"],
  getGetSheetQueryKey: (id: number) => ["sheets", id],
}));

const setLocationMock = vi.fn();
vi.mock("wouter", () => ({
  useParams: () => ({}),
  useLocation: () => ["/sheets/new", setLocationMock],
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import NewSheet from "./NewSheet";

// Every markdown-enabled field in the form, by its testId. These mirror the
// data-testid props wired into <MarkdownEditor> in NewSheet.tsx.
const MARKDOWN_FIELDS = [
  "input-occupation",
  "input-physical",
  "input-psych",
  "input-background",
  "input-skills",
] as const;

describe("NewSheet markdown editor", () => {
  beforeEach(() => {
    submitMutateAsync.mockClear();
    updateMutateAsync.mockClear();
    setLocationMock.mockClear();
    toastMock.mockClear();
  });

  it("renders a live formatted preview for every markdown-enabled field", () => {
    render(<NewSheet />);

    for (const field of MARKDOWN_FIELDS) {
      const textarea = screen.getByTestId(field);
      fireEvent.change(textarea, { target: { value: `**bold-${field}**` } });

      const preview = screen.getByTestId(`${field}-preview`);
      // The preview must render real <strong>, not the literal asterisks.
      const strong = within(preview).getByText(`bold-${field}`);
      expect(strong.tagName).toBe("STRONG");
      expect(preview.textContent).not.toContain("**");
    }
  });

  it("renders italics and list markdown in the preview", () => {
    render(<NewSheet />);

    const textarea = screen.getByTestId("input-background");
    fireEvent.change(textarea, {
      target: { value: "*emphasis*\n\n- first\n- second" },
    });

    const preview = screen.getByTestId("input-background-preview");
    const em = within(preview).getByText("emphasis");
    expect(em.tagName).toBe("EM");
    expect(within(preview).getAllByRole("listitem")).toHaveLength(2);
    expect(preview.textContent).not.toContain("*emphasis*");
  });

  it("fires the debounced autosave after edits settle", async () => {
    vi.useFakeTimers();
    try {
      render(<NewSheet />);

      // Autosave is gated on a non-empty name for a brand-new draft.
      fireEvent.change(screen.getByTestId("input-fullname"), {
        target: { value: "Test Runner" },
      });
      fireEvent.change(screen.getByTestId("input-background"), {
        target: { value: "**chrome heart**" },
      });

      // Nothing should have been persisted yet — the save is debounced.
      expect(submitMutateAsync).not.toHaveBeenCalled();

      // Advance past the 3s debounce window. The debounce callback invokes the
      // create mutation synchronously, and act() flushes the resolving promise
      // (which updates the draft id / autosave status afterwards).
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(submitMutateAsync).toHaveBeenCalledTimes(1);

      const payload = submitMutateAsync.mock.calls[0][0];
      expect(payload.data.name).toBe("Test Runner");
      expect(payload.data.data.background).toBe("**chrome heart**");
      expect(payload.data.status).toBe("draft");
    } finally {
      vi.useRealTimers();
    }
  });
});
