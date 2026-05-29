import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  decideMutate: vi.fn(),
  setLocation: vi.fn(),
  state: {
    status: "pending" as string,
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
      ownerId: 999,
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      decisionNote: null,
      data: SHEET_DATA,
    },
    isLoading: false,
  }),
  useDecideSheet: () => ({ mutate: h.decideMutate, isPending: false }),
  useListCyberware: () => ({ data: [] }),
  useGetMe: () => ({ data: h.state.me }),
  getGetMeQueryKey: () => ["me"],
  getGetSheetQueryKey: (id: number) => ["sheets", id],
  getListPendingSheetsQueryKey: () => ["sheets", "pending"],
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

describe("SheetDetail approval decisions", () => {
  beforeEach(() => {
    h.decideMutate.mockReset();
    h.setLocation.mockReset();
    h.state.status = "pending";
    h.state.me = { id: 1, isCsApprover: true, isAdmin: false, isFixer: false };
  });

  it("lets an approver approve, request changes, and reject with a note", () => {
    render(<SheetDetail />);

    fireEvent.change(screen.getByTestId("input-decision-note"), {
      target: { value: "Looks good" },
    });

    fireEvent.click(screen.getByTestId("button-approve"));
    expect(h.decideMutate).toHaveBeenLastCalledWith({
      id: 7,
      data: { decision: "approved", note: "Looks good" },
    });

    fireEvent.click(screen.getByTestId("button-request-changes"));
    expect(h.decideMutate).toHaveBeenLastCalledWith({
      id: 7,
      data: { decision: "changes_requested", note: "Looks good" },
    });

    fireEvent.click(screen.getByTestId("button-reject"));
    expect(h.decideMutate).toHaveBeenLastCalledWith({
      id: 7,
      data: { decision: "rejected", note: "Looks good" },
    });

    expect(h.decideMutate).toHaveBeenCalledTimes(3);
  });

  it("hides the decision panel from non-approvers", () => {
    h.state.me = { id: 1, isCsApprover: false, isAdmin: false, isFixer: false };
    render(<SheetDetail />);

    expect(screen.queryByTestId("button-approve")).toBeNull();
    expect(screen.queryByTestId("input-decision-note")).toBeNull();
  });

  it("hides the decision panel once the sheet is no longer pending", () => {
    h.state.status = "approved";
    render(<SheetDetail />);

    expect(screen.queryByTestId("button-approve")).toBeNull();
    expect(screen.getByTestId("badge-status")).toHaveTextContent("approved");
  });
});
