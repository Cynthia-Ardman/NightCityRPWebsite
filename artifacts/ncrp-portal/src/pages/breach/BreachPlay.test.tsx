import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BreachPlay from "./BreachPlay";

// Shared, mutable spies/state set per test before rendering.
const h = vi.hoisted(() => ({
  submitAsync: vi.fn(),
  startAsync: vi.fn(),
}));

// An assigned puzzle whose timer has ALREADY expired: started 120s ago with a
// 10s limit. Opening the play screen will immediately auto-submit the empty run.
// Crucially the QUERY status stays "sent" — the only authoritative "expired"
// signal comes from the SUBMIT response, which is exactly what the overlay must
// trust (the regression: deriving expired from the stale query showed FAILED).
const EXPIRED_PUZZLE = {
  id: 2,
  difficulty: "easy",
  timeLimitSeconds: 10,
  grid: [
    ["1A", "55"],
    ["BD", "E9"],
  ],
  daemons: [["1A", "55"]],
  bufferSize: 4,
  status: "sent",
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  completedAt: null,
  selection: null,
  solvedCount: 0,
  assignedCharacterName: "Tester",
  contextLabel: null,
};

vi.mock("wouter", () => ({
  useParams: () => ({ id: "2" }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetBreachPuzzle: () => ({ data: EXPIRED_PUZZLE, isLoading: false, error: null }),
  useStartBreachPuzzle: () => ({ mutateAsync: h.startAsync, isPending: false }),
  useSubmitBreachResult: () => ({ mutateAsync: h.submitAsync, isPending: false }),
  useReportBreachProgress: () => ({ mutate: vi.fn(), isPending: false }),
  getGetBreachPuzzleQueryKey: () => ["breach-puzzle", 2],
  getListMyBreachPuzzlesQueryKey: () => ["my-breach-puzzles"],
  getGetMyWalletQueryKey: () => ["my-wallet"],
}));

function renderPlay() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BreachPlay />
    </QueryClientProvider>,
  );
}

describe("BreachPlay timeout regression", () => {
  beforeEach(() => {
    h.startAsync.mockReset().mockResolvedValue(undefined);
    // The server records the overdue submission as 'expired'.
    h.submitAsync.mockReset().mockResolvedValue({
      puzzle: { ...EXPIRED_PUZZLE, status: "expired", completedAt: new Date().toISOString() },
      success: false,
      valid: true,
      solvedCount: 0,
      totalDaemons: 1,
      rewardPaid: false,
    });
  });

  it("shows TIME UP (not BREACH FAILED) when an assigned submit comes back expired", async () => {
    renderPlay();

    // The overdue timer auto-submits the empty run on load.
    await waitFor(() => expect(h.submitAsync).toHaveBeenCalledTimes(1));

    // The overlay title must reflect the server's expired status...
    await waitFor(() =>
      expect(screen.getByText("TRACE COMPLETE — TIME UP")).toBeInTheDocument(),
    );
    // ...and never the plain failure title.
    expect(screen.queryByText("BREACH FAILED")).not.toBeInTheDocument();
    expect(screen.queryByText("BREACH SUCCESSFUL")).not.toBeInTheDocument();
  });
});
