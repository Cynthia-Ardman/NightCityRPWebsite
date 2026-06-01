import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  voteMutate: vi.fn(),
  overrideMutate: vi.fn(),
  resubmitMutate: vi.fn(),
  setLocation: vi.fn(),
  state: {
    status: "pending" as string,
    ownerId: 999 as number,
    canVote: true,
    canOverride: false,
    canRequestChanges: true,
    canResubmit: false,
    myVote: null as null | { vote: string; note: string | null },
    me: { id: 1, isCsApprover: true, isAdmin: false, isFixer: false } as Record<string, unknown>,
  },
}));

const SHEET_DATA = {
  fullName: "Vincent Vega",
  nickname: "V",
  archetype: "Solo",
  age: 31,
  gender: "M",
  occupation: "Mercenary",
  physicalDescription: "Tall",
  appearance: "Leather",
  psychProfile: "Loyal",
  background: "Heywood",
  skills: "Handguns",
  gear: ["Pistol"],
  cyberware: [],
};

vi.mock("@workspace/api-client-react", () => ({
  useGetSheet: () => ({
    data: {
      id: 7,
      name: "Vincent Vega",
      status: h.state.status,
      ownerId: h.state.ownerId,
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      decisionNote: null,
      data: SHEET_DATA,
      approveCount: 0,
      rejectCount: 0,
      threshold: 1,
      eligibleVoterCount: 1,
      canVote: h.state.canVote,
      canOverride: h.state.canOverride,
      canRequestChanges: h.state.canRequestChanges,
      canResubmit: h.state.canResubmit,
      myVote: h.state.myVote,
    },
    isLoading: false,
  }),
  useVoteSheet: () => ({ mutate: h.voteMutate, isPending: false }),
  useOverrideSheet: () => ({ mutate: h.overrideMutate, isPending: false }),
  useSubmitDraftSheet: () => ({ mutate: h.resubmitMutate, isPending: false }),
  useListCyberware: () => ({ data: [] }),
  getGetSheetQueryKey: (id: number) => ["sheets", id],
  getListPendingSheetsQueryKey: () => ["sheets", "pending"],
  useListReviewComments: () => ({ data: [], isLoading: false }),
  usePostReviewComment: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkReviewSeen: () => ({ mutate: vi.fn(), isPending: false }),
  getListReviewCommentsQueryKey: (t: string, id: number) => ["review", t, id, "comments"],
  getGetReviewUnseenCountsQueryKey: () => ["review", "unseen-counts"],
}));

vi.mock("@/hooks/useAuthMe", () => ({
  useAuthMe: () => ({ data: h.state.me }),
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "7" }),
  useLocation: () => ["/sheets/7", h.setLocation],
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

import SheetDetail from "./SheetDetail";

describe("SheetDetail review pipeline", () => {
  beforeEach(() => {
    h.voteMutate.mockReset();
    h.overrideMutate.mockReset();
    h.resubmitMutate.mockReset();
    h.setLocation.mockReset();
    h.state.status = "pending";
    h.state.ownerId = 999;
    h.state.canVote = true;
    h.state.canOverride = false;
    h.state.canRequestChanges = true;
    h.state.canResubmit = false;
    h.state.myVote = null;
    h.state.me = { id: 1, isCsApprover: true, isAdmin: false, isFixer: false };
  });

  it("lets a reviewer cast approve and reject votes carrying the note", () => {
    render(<SheetDetail />);

    fireEvent.change(screen.getByTestId("input-decision-note"), {
      target: { value: "Looks good" },
    });

    fireEvent.click(screen.getByTestId("button-approve"));
    expect(h.voteMutate).toHaveBeenLastCalledWith({
      id: 7,
      data: { vote: "approve", note: "Looks good" },
    });

    fireEvent.click(screen.getByTestId("button-reject"));
    expect(h.voteMutate).toHaveBeenLastCalledWith({
      id: 7,
      data: { vote: "reject", note: "Looks good" },
    });

    expect(h.voteMutate).toHaveBeenCalledTimes(2);
  });

  it("lets an admin override-approve", () => {
    h.state.canOverride = true;
    h.state.me = { id: 1, isCsApprover: false, isAdmin: true, isFixer: false };
    render(<SheetDetail />);

    fireEvent.click(screen.getByTestId("button-override"));
    expect(h.overrideMutate).toHaveBeenLastCalledWith({ id: 7 });
  });

  it("lets the owner resubmit after changes were requested", () => {
    h.state.status = "changes_requested";
    h.state.ownerId = 1;
    h.state.canVote = false;
    h.state.canRequestChanges = false;
    h.state.canResubmit = true;
    h.state.me = { id: 1, isCsApprover: false, isAdmin: false, isFixer: false };
    render(<SheetDetail />);

    fireEvent.click(screen.getByTestId("button-resubmit"));
    expect(h.resubmitMutate).toHaveBeenLastCalledWith({ id: 7 });
  });

  it("shows the self-review notice and no vote panel to the submitting reviewer", () => {
    h.state.ownerId = 1;
    h.state.canVote = false;
    h.state.canRequestChanges = false;
    render(<SheetDetail />);

    expect(screen.queryByTestId("button-approve")).toBeNull();
    expect(screen.queryByTestId("input-decision-note")).toBeNull();
    expect(screen.getByTestId("text-self-review-blocked")).toBeInTheDocument();
  });

  it("hides the vote panel from non-reviewers", () => {
    h.state.canVote = false;
    h.state.canRequestChanges = false;
    h.state.me = { id: 1, isCsApprover: false, isAdmin: false, isFixer: false };
    render(<SheetDetail />);

    expect(screen.queryByTestId("button-approve")).toBeNull();
    expect(screen.queryByTestId("button-override")).toBeNull();
    expect(screen.queryByTestId("input-decision-note")).toBeNull();
  });

  it("hides the vote panel once the sheet is no longer pending", () => {
    h.state.status = "approved";
    h.state.canVote = false;
    h.state.canRequestChanges = false;
    render(<SheetDetail />);

    expect(screen.queryByTestId("button-approve")).toBeNull();
    expect(screen.getByTestId("badge-status")).toHaveTextContent("approved");
  });
});
