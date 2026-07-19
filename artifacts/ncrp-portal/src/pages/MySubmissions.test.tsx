import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

let sheets: unknown[] = [];
let edits: unknown[] = [];

vi.mock("wouter", () => ({
  useLocation: () => ["/submissions", navigate] as const,
}));

vi.mock("@/hooks/useAuthMe", () => ({
  useAuthMe: () => ({ data: { id: "me-1", username: "Me" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListMyCustomRequests: () => ({ data: [], isLoading: false }),
  useListMyHousingRequests: () => ({ data: [], isLoading: false }),
  useListMySheets: () => ({ data: sheets, isLoading: false }),
  useListPendingEdits: () => ({ data: edits, isLoading: false }),
  useDecideStockCostRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCustomRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResubmitCustomRequest: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useSubmitDraftCustomRequest: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteDraftCustomRequest: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useWithdrawCustomRequest: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useGetMyUnseen: () => ({ data: { request: [], edit: [], sheet: [], total: 0 }, isLoading: false }),
  getListMyCustomRequestsQueryKey: () => ["my-custom-requests"],
  getListPendingEditsQueryKey: (params?: unknown) => ["pending-edits", params],
  getGetMyUnseenQueryKey: () => ["my-unseen"],
}));

import MySubmissions from "./MySubmissions";

beforeEach(() => {
  navigate.mockReset();
  sheets = [];
  edits = [];
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MySubmissions />
    </QueryClientProvider>,
  );
}

describe("MySubmissions character submissions", () => {
  it("shows a new-character sheet that needs changes and links to it", () => {
    sheets = [
      {
        id: 12,
        ownerId: "me-1",
        name: "Vega",
        status: "changes_requested",
        decisionNote: "Tone down the backstory",
        createdAt: "2026-05-01T00:00:00.000Z",
        decidedAt: "2026-05-02T00:00:00.000Z",
        data: {},
      },
    ];
    renderPage();

    expect(screen.getByTestId("row-my-request-sheet-12")).toBeInTheDocument();
    expect(screen.getByText("Tone down the backstory", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-respond-sheet-12"));
    expect(navigate).toHaveBeenCalledWith("/sheets/12");
  });

  it("hides draft sheets (not yet submitted)", () => {
    sheets = [
      { id: 5, ownerId: "me-1", name: "Draft Guy", status: "draft", createdAt: "2026-05-01T00:00:00.000Z", data: {} },
    ];
    renderPage();
    expect(screen.queryByTestId("row-my-request-sheet-5")).toBeNull();
  });

  it("shows the player's own character edit and links to it, hiding others'", () => {
    edits = [
      {
        id: 99,
        characterId: 3,
        characterName: "Vega",
        submittedBy: "me-1",
        updateNote: "Add new arm cyberware",
        status: "changes_requested",
        reviewComment: "Needs CWP breakdown",
        submittedAt: "2026-05-03T00:00:00.000Z",
        decidedAt: "2026-05-04T00:00:00.000Z",
        approveCount: 0,
        rejectCount: 0,
        threshold: 1,
        voters: [],
      },
      {
        id: 100,
        characterId: 4,
        characterName: "Someone Else",
        submittedBy: "other-user",
        status: "changes_requested",
        submittedAt: "2026-05-03T00:00:00.000Z",
        approveCount: 0,
        rejectCount: 0,
        threshold: 1,
        voters: [],
      },
    ];
    renderPage();

    expect(screen.getByTestId("row-my-request-edit-99")).toBeInTheDocument();
    expect(screen.queryByTestId("row-my-request-edit-100")).toBeNull();

    fireEvent.click(screen.getByTestId("button-respond-edit-99"));
    expect(navigate).toHaveBeenCalledWith("/pending-edits/99");
  });

  it("does not show a respond button once the edit is approved", () => {
    edits = [
      {
        id: 77,
        characterId: 3,
        characterName: "Vega",
        submittedBy: "me-1",
        status: "approved",
        submittedAt: "2026-05-03T00:00:00.000Z",
        approveCount: 1,
        rejectCount: 0,
        threshold: 1,
        voters: [],
      },
    ];
    renderPage();

    expect(screen.getByTestId("row-my-request-edit-77")).toBeInTheDocument();
    expect(screen.queryByTestId("button-respond-edit-77")).toBeNull();
  });
});
