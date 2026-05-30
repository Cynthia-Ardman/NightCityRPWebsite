import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Shared, mutable mock state. vi.hoisted runs before the (hoisted) vi.mock
// factories, so the factories can safely close over `h` and read the latest
// values at render time — letting each test vary the loaded sheet / route.
const h = vi.hoisted(() => ({
  createMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  submitDraftMutateAsync: vi.fn(),
  deleteMutateAsync: vi.fn(),
  setLocation: vi.fn(),
  toast: vi.fn(),
  state: {
    getSheetData: undefined as undefined | Record<string, unknown>,
    paramsId: undefined as string | undefined,
    me: { id: 1, isFixer: false, isAdmin: false } as Record<string, unknown>,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useSubmitSheet: () => ({ mutateAsync: h.createMutateAsync, isPending: false }),
  useUpdateSheet: () => ({ mutateAsync: h.updateMutateAsync, isPending: false }),
  useSubmitDraftSheet: () => ({ mutateAsync: h.submitDraftMutateAsync, isPending: false }),
  useDeleteSheet: () => ({ mutateAsync: h.deleteMutateAsync, isPending: false }),
  useGetSheet: () => ({ data: h.state.getSheetData, isLoading: false }),
  useListCyberware: () => ({ data: [] }),
  useGetMe: () => ({ data: h.state.me, isLoading: false }),
  getGetMeQueryKey: () => ["me"],
  getListMySheetsQueryKey: () => ["sheets", "mine"],
  getGetSheetQueryKey: (id: number) => ["sheets", id],
}));

vi.mock("wouter", () => ({
  useParams: () => (h.state.paramsId ? { id: h.state.paramsId } : {}),
  useLocation: () => ["/", h.setLocation],
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));

// Uploads resolve to a deterministic object path so the portrait/stats
// required-to-submit gate can be satisfied by driving the file inputs.
vi.mock("@/lib/uploadImage", () => ({
  uploadImage: vi.fn(async (f: File) => `/api/storage/objects/${f.name}`),
}));

import NewSheet from "./NewSheet";

// Adds one portrait + one stats image via the shared ImageEditor file inputs.
async function uploadRequiredImages() {
  await act(async () => {
    fireEvent.change(screen.getByTestId("input-upload-sheet-portrait"), {
      target: { files: [new File(["p"], "portrait.png", { type: "image/png" })] },
    });
  });
  await act(async () => {
    fireEvent.change(screen.getByTestId("input-upload-sheet-stats"), {
      target: { files: [new File(["s"], "stats.png", { type: "image/png" })] },
    });
  });
}

describe("NewSheet submit-and-resubmit journey", () => {
  beforeEach(() => {
    h.createMutateAsync.mockReset().mockResolvedValue({ id: 55 });
    h.updateMutateAsync.mockReset().mockResolvedValue({ id: 0 });
    h.submitDraftMutateAsync.mockReset().mockResolvedValue({});
    h.deleteMutateAsync.mockReset().mockResolvedValue({});
    h.setLocation.mockReset();
    h.toast.mockReset();
    h.state.getSheetData = undefined;
    h.state.paramsId = undefined;
    h.state.me = { id: 1, isFixer: false, isAdmin: false };
  });

  it("creates a draft then promotes it out of draft on submit", async () => {
    render(<NewSheet />);

    fireEvent.change(screen.getByTestId("input-fullname"), { target: { value: "V" } });
    await uploadRequiredImages();

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-submit-sheet"));
    });

    await waitFor(() => expect(h.submitDraftMutateAsync).toHaveBeenCalledTimes(1));
    // The draft is created first, then submitted by its returned id.
    expect(h.createMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.submitDraftMutateAsync).toHaveBeenCalledWith({ id: 55 });
    expect(h.setLocation).toHaveBeenCalledWith("/characters");
    // A non-fixer's brand-new sheet must go out as a PC.
    expect(h.createMutateAsync.mock.calls[0][0].data.data.sheetType).toBe("PC");
  });

  it("blocks submit when the name is missing", async () => {
    render(<NewSheet />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-submit-sheet"));
    });

    expect(h.submitDraftMutateAsync).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Name required" }),
    );
  });

  it("blocks submit when portrait/stats images are missing", async () => {
    render(<NewSheet />);

    fireEvent.change(screen.getByTestId("input-fullname"), { target: { value: "V" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-submit-sheet"));
    });

    expect(h.submitDraftMutateAsync).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Portrait required" }),
    );
  });

  it("saves an in-review sheet in place without resubmitting", async () => {
    h.state.paramsId = "77";
    h.state.getSheetData = { id: 77, name: "V", status: "pending", data: { fullName: "V" } };
    render(<NewSheet />);

    // The submit button is hidden while in review; only "save changes" shows.
    expect(screen.queryByTestId("button-submit-sheet")).toBeNull();
    expect(screen.getByText("IN REVIEW")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-save-draft"));
    });

    await waitFor(() => expect(h.updateMutateAsync).toHaveBeenCalledTimes(1));
    expect(h.updateMutateAsync.mock.calls[0][0].id).toBe(77);
    // In-place save must NOT re-trigger the submit-for-review flow.
    expect(h.submitDraftMutateAsync).not.toHaveBeenCalled();
  });

  it("resubmits a changes-requested sheet and shows the approver note", async () => {
    h.state.paramsId = "88";
    h.state.getSheetData = {
      id: 88,
      name: "V",
      status: "changes_requested",
      decisionNote: "Add more backstory",
      data: {
        fullName: "V",
        portraitUrls: ["/api/storage/objects/portrait.png"],
        statsImageUrls: ["/api/storage/objects/stats.png"],
      },
    };
    render(<NewSheet />);

    expect(screen.getByText("CHANGES REQUESTED")).toBeInTheDocument();
    expect(screen.getByText("Add more backstory")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-submit-sheet"));
    });

    await waitFor(() => expect(h.submitDraftMutateAsync).toHaveBeenCalledTimes(1));
    // Existing draft id is updated (not created) then submitted.
    expect(h.updateMutateAsync.mock.calls[0][0].id).toBe(88);
    expect(h.submitDraftMutateAsync).toHaveBeenCalledWith({ id: 88 });
    expect(h.setLocation).toHaveBeenCalledWith("/characters");
  });
});
