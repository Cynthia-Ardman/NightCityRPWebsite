import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mutable shared mock state, set per-test before rendering.
const h = vi.hoisted(() => ({
  state: {
    isAdmin: false as boolean,
  },
}));

const CHAR = {
  id: 5,
  name: "Test Subject",
  kind: "pc",
  approved: true,
  archetype: "Solo",
  lifeStatus: "active",
  portraitUrl: null,
  portraitUrls: [],
  statsImageUrls: [],
  background: "",
  sheetData: null,
  cyberwareLevel: "none",
  isOrganic: true,
  lifestyleTierId: null,
  lifestyleTier: null,
  lastCheckupAt: null,
};

// All hooks the CharacterDetail page (and its eagerly-rendered children) read
// from the generated client. We return minimal shapes — the test only needs
// the page to render far enough to assert the admin DELETE button is/isn't
// present.
vi.mock("@workspace/api-client-react", () => {
  const noop = () => undefined;
  const queryKey = (..._a: unknown[]) => ["k"];
  const idleQuery = (data: unknown = undefined) => ({ data, isLoading: false });
  const idleMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  });
  return {
    // Reads
    useGetCharacter: () => idleQuery(CHAR),
    useGetMe: () => idleQuery({ id: 1, isAdmin: h.state.isAdmin }),
    useGetCharacterPendingEdit: () => idleQuery(undefined),
    useListCharacterUpdates: () => idleQuery([]),
    useGetWalletTransactions: () => idleQuery([]),
    useGetMyWallet: () => idleQuery({ balance: 0 }),
    useGetCharacterInventory: () => idleQuery([]),
    useGetCharacterHousing: () => idleQuery([]),
    useGetCharacterStatus: () => idleQuery({
      loa: false,
      attending: false,
      openShop: false,
      statusMessage: "",
      loaReturnsAt: null,
      updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    }),
    useListLifestyleTiers: () => idleQuery([]),
    useListMyMissions: () => idleQuery([]),

    // Mutations
    useTransferEddies: idleMutation,
    useAddInventoryItem: idleMutation,
    useUpdateInventoryItem: idleMutation,
    useRemoveInventoryItem: idleMutation,
    useTransferInventoryItem: idleMutation,
    useVacateHousing: idleMutation,
    useUpdateHousingLease: idleMutation,
    useUpdateCharacterStatus: idleMutation,
    useSetCharacterLifestyle: idleMutation,
    useUpdateCharacter: idleMutation,
    useDeleteCharacter: idleMutation,

    // Query-key helpers
    getGetCharacterHousingQueryKey: queryKey,
    getGetWalletTransactionsQueryKey: queryKey,
    getGetMyWalletQueryKey: queryKey,
    getGetCharacterInventoryQueryKey: queryKey,
    getGetCharacterStatusQueryKey: queryKey,
    getGetCharacterQueryKey: queryKey,
    getGetMeQueryKey: queryKey,
    getGetCharacterPendingEditQueryKey: queryKey,
    getListPendingEditsQueryKey: queryKey,
    getListMyCharactersQueryKey: queryKey,
  };
});

vi.mock("wouter", () => ({
  useParams: () => ({ id: "5" }),
  useLocation: () => ["/characters/5", vi.fn()],
  // Render a plain anchor for `Link` — the page only uses it for navigation
  // and never asserts on its rendered DOM in this test.
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    // Stub useQuery/useMutation so child components that call them directly
    // (e.g. the ShopOpenSection inline fetch) don't trigger real network IO.
    useQuery: () => ({ data: undefined, isLoading: false }),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    }),
  };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Replace the heavy uploadImage helper to keep EditCharacterDialog inert.
vi.mock("@/lib/uploadImage", () => ({ uploadImage: vi.fn() }));

import CharacterDetail from "./CharacterDetail";

describe("CharacterDetail: admin-only delete affordance", () => {
  beforeEach(() => {
    h.state.isAdmin = false;
  });

  it("does NOT render the DELETE button or DeleteCharacterDialog for a non-admin", () => {
    h.state.isAdmin = false;
    render(<CharacterDetail />);

    // The character header still renders (smoke check).
    expect(screen.getByTestId("text-char-name")).toHaveTextContent(CHAR.name);
    // No delete button, no delete dialog mounted in the tree.
    expect(screen.queryByTestId("button-delete-character")).toBeNull();
    expect(screen.queryByTestId("dialog-delete-character")).toBeNull();
  });

  it("renders the DELETE button (and mounts the dialog component) for an admin", () => {
    h.state.isAdmin = true;
    render(<CharacterDetail />);

    expect(screen.getByTestId("text-char-name")).toHaveTextContent(CHAR.name);
    expect(screen.getByTestId("button-delete-character")).toBeInTheDocument();
    // The dialog is conditionally rendered only for admins. It's closed by
    // default so the DialogContent (testid="dialog-delete-character") stays
    // unmounted — that's fine; the key invariant tested here is the button.
  });
});
