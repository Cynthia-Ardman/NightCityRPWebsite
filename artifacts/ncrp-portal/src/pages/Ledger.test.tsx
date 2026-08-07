import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// Estimate-mode wallet state: the live UnbelievaBoat read failed, so the
// server sent source:"local" with an unknown cash/bank split (nulls). The
// Ledger must show "—" for the split (never a false 0 bank), surface the
// estimate warning, and pause bank moves.
const h = vi.hoisted(() => ({
  wallet: {
    data: { balance: 5500, cash: null, bank: null, source: "local" } as {
      balance: number;
      cash: number | null;
      bank: number | null;
      source: string;
    },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: "u1", username: "tester" }, isLoading: false }),
  getGetMeQueryKey: () => ["me"],
  useGetMyWallet: () => ({ data: h.wallet.data }),
  getGetMyWalletQueryKey: () => ["my-wallet"],
  useGetMyWalletTransactions: () => ({ data: [], isLoading: false }),
  getGetMyWalletTransactionsQueryKey: () => ["my-wallet-txns"],
  useTransferEddiesFromAccount: () => ({ mutate: () => {}, isPending: false, isError: false, error: null }),
  useListPublicPlayers: () => ({ data: [], isFetching: false }),
  getListPublicPlayersQueryKey: (p?: unknown) => ["public-players", p],
  useWithdrawEddies: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDepositEddies: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useTransferEddies: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  usePayBusiness: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSinkEddies: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useListMyStores: () => ({ data: [], isLoading: false }),
  getListMyStoresQueryKey: () => ["my-stores"],
  useListPublicCharacters: () => ({ data: [], isFetching: false }),
  getListPublicCharactersQueryKey: () => ["public-chars"],
  useListMyCharacters: () => ({ data: [], isLoading: false }),
  getListMyCharactersQueryKey: () => ["my-chars"],
  useListStores: () => ({ data: [], isLoading: false }),
  getListStoresQueryKey: () => ["stores"],
  useListRipperdocs: () => ({ data: [], isLoading: false }),
  getListRipperdocsQueryKey: () => ["ripperdocs"],
  useGiveToStore: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useGiveToRipperdoc: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import Ledger from "./Ledger";

describe("Ledger estimate mode (wallet source: local)", () => {
  it("shows total but an unknown split as em-dashes, never bank 0", () => {
    render(<Ledger />);
    expect(screen.getByTestId("text-balance-total").textContent).toContain("5,500");
    expect(screen.getByTestId("text-balance-cash").textContent).toContain("—");
    expect(screen.getByTestId("text-balance-bank").textContent).toContain("—");
    expect(screen.getByTestId("text-balance-bank").textContent).not.toContain("0");
  });

  it("shows the estimate warning and pauses bank moves", () => {
    render(<Ledger />);
    expect(screen.getByTestId("text-wallet-stale-warning")).toBeInTheDocument();
    expect(screen.getByTestId("text-bank-stale-warning")).toBeInTheDocument();
    expect(screen.getByTestId("button-withdraw")).toBeDisabled();
    expect(screen.getByTestId("button-deposit")).toBeDisabled();
  });

  it("renders a known stale split normally (with warning, no dashes)", () => {
    h.wallet.data = { balance: 5500, cash: 1200, bank: 4300, source: "local" };
    render(<Ledger />);
    expect(screen.getByTestId("text-balance-cash").textContent).toContain("1,200");
    expect(screen.getByTestId("text-balance-bank").textContent).toContain("4,300");
    expect(screen.getByTestId("text-wallet-stale-warning")).toBeInTheDocument();
  });
});
