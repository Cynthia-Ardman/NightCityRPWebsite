import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Shared mock state — vi.hoisted lets the vi.mock factories below read these.
const h = vi.hoisted(() => ({
  adjustMutate: vi.fn(),
  sinkMutate: vi.fn(),
  state: {
    pending: false as boolean,
  },
}));

// WalletTab only touches useAdminAdjustWallet; the real CharacterPicker it
// renders pulls in useListPublicCharacters. Mock both so the tab mounts
// without a network layer. The picker starts disabled/closed, so the list
// hook is never actually fired.
vi.mock("@workspace/api-client-react", () => ({
  useListPublicPlayers: () => ({ data: [], isFetching: false }),
  getListPublicPlayersQueryKey: (p?: unknown) => ["public-players", p],
  useAdminAdjustWallet: () => ({
    mutate: h.adjustMutate,
    isPending: h.state.pending,
  }),
  useAdminSinkWallet: () => ({
    mutate: h.sinkMutate,
    isPending: h.state.pending,
  }),
  useListPublicCharacters: () => ({ data: undefined, isFetching: false }),
  getListPublicCharactersQueryKey: () => ["list-public-characters"],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { WalletTab } from "./AdminDashboard";

describe("WalletTab", () => {
  beforeEach(() => {
    h.adjustMutate.mockReset();
    h.sinkMutate.mockReset();
    h.state.pending = false;
  });

  // Regression guard: the tab once crashed on render because a form label
  // primitive was used outside its required <Form> context. Simply mounting
  // it (and the character picker within) must not throw.
  it("mounts the Wallets tab and its character picker without crashing", () => {
    expect(() => render(<WalletTab />)).not.toThrow();

    // Core surfaces are present: the picker search box and the submit button.
    expect(screen.getByTestId("input-wallet-char")).toBeInTheDocument();
    expect(screen.getByTestId("button-submit-wallet")).toBeInTheDocument();
  });

  it("keeps the submit button disabled until a character is selected", () => {
    render(<WalletTab />);
    const btn = screen.getByTestId("button-submit-wallet") as HTMLButtonElement;
    // No character picked yet (and not pending) — must stay disabled.
    expect(btn).toBeDisabled();
  });
});
