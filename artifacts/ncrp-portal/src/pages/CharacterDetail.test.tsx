import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mutable shared mock state, set per-test before rendering.
const h = vi.hoisted(() => ({
  state: {
    isAdmin: false as boolean,
    pendingEdit: undefined as unknown,
    sheetData: null as unknown,
    background: "" as string,
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
  // Stable empty-query result for the dialog's cyberware hydration effect, which
  // depends on the inventory/catalog array identity and writes back to state.
  // A fresh [] per render would re-fire it forever and hang the test.
  const stableEmpty = { data: [] as never[], isLoading: false };
  const idleMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  });
  return {
    // Reads
    useGetCharacter: () =>
      idleQuery({ ...CHAR, sheetData: h.state.sheetData, background: h.state.background }),
    useGetMe: () => idleQuery({ id: 1, isAdmin: h.state.isAdmin }),
    useGetCharacterPendingEdit: () => idleQuery(h.state.pendingEdit),
    useListCharacterUpdates: () => idleQuery([]),
    useGetWalletTransactions: () => idleQuery([]),
    useGetMyWallet: () => idleQuery({ balance: 0 }),
    useGetCharacterInventory: () => stableEmpty,
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
    useListOwnedMissions: () => idleQuery([]),
    useListCharacterBreachPuzzles: () => idleQuery([]),
    useListRentListings: () => idleQuery([]),
    useListGuns: () => idleQuery([]),
    useListCyberware: () => stableEmpty,
    // CatalogRequestSection + CharacterPicker render inside the page tree.
    useListMyCharacters: () => idleQuery([]),
    useListMyCustomRequests: () => idleQuery([]),
    useListRipperdocs: () => idleQuery([]),
    useListStores: () => idleQuery([]),
    useListPublicCharacters: () => idleQuery([]),
    // NcpdRecordPanel (NCPD tab) hooks — the tab is gated off in these tests,
    // but the module import must still resolve every hook it references.
    useGetNcpdRecord: () => idleQuery(undefined),

    // Mutations
    useSubmitCustomRequest: idleMutation,
    useTransferEddies: idleMutation,
    useAddInventoryItem: idleMutation,
    useUpdateInventoryItem: idleMutation,
    useRemoveInventoryItem: idleMutation,
    useTransferInventoryItem: idleMutation,
    useVacateHousing: idleMutation,
    useUpdateHousingLease: idleMutation,
    useLeaseHousing: idleMutation,
    useUpdateCharacterStatus: idleMutation,
    useSetCharacterLifestyle: idleMutation,
    useUpdateCharacter: idleMutation,
    useDeleteCharacter: idleMutation,
    useCreateNcpdReport: idleMutation,
    useUpdateNcpdReport: idleMutation,
    useDeleteNcpdReport: idleMutation,
    useCreateNcpdWarrant: idleMutation,
    useUpdateNcpdWarrant: idleMutation,
    useDeleteNcpdWarrant: idleMutation,
    useCreateNcpdNote: idleMutation,
    useDeleteNcpdNote: idleMutation,

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
    getListMyMissionsQueryKey: queryKey,
    getListOwnedMissionsQueryKey: queryKey,
    getListMyCustomRequestsQueryKey: queryKey,
    getListRipperdocsQueryKey: queryKey,
    getListStoresQueryKey: queryKey,
    getListPublicCharactersQueryKey: queryKey,
    getGetNcpdRecordQueryKey: queryKey,
    getListNcpdReportsQueryKey: queryKey,
    getListNcpdWarrantsQueryKey: queryKey,
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

// Both the page and the edit dialog read the effective viewer via
// useEffectiveMe. Drive it from the same shared admin flag so the delete gate
// (canDelete = admin || archivist || coordinator) is controllable per-test.
vi.mock("@/contexts/ViewAsContext", () => ({
  useEffectiveMe: () => ({ data: { id: 1, isAdmin: h.state.isAdmin } }),
}));

// Render the Radix tab/accordion primitives flat so the dialog's fields all
// mount at once and the Radix presence ref loop ("Maximum update depth
// exceeded") doesn't fire under jsdom.
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/accordion", () => ({
  Accordion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Radix Dialog's presence ref-callback loops under jsdom; render it flat so the
// edit dialog's delete affordance is reachable without the loop.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Replace the heavy uploadImage helper to keep EditCharacterDialog inert.
vi.mock("@/lib/uploadImage", () => ({ uploadImage: vi.fn() }));

import CharacterDetail from "./CharacterDetail";

describe("CharacterDetail: admin-only delete affordance", () => {
  beforeEach(() => {
    h.state.isAdmin = false;
    h.state.pendingEdit = undefined;
    h.state.sheetData = null;
    h.state.background = "";
  });

  it("does NOT expose the delete control in the edit dialog for a non-admin", () => {
    h.state.isAdmin = false;
    render(<CharacterDetail />);

    // The character header still renders (smoke check).
    expect(screen.getByTestId("text-char-name")).toHaveTextContent(CHAR.name);
    // Open the edit dialog — a non-admin owner may edit, but the danger zone
    // (delete) must not appear.
    fireEvent.click(screen.getByTestId("button-edit-character"));
    expect(screen.queryByTestId("section-danger-zone")).toBeNull();
    expect(screen.queryByTestId("button-confirm-delete")).toBeNull();
  });

  it("exposes the delete control inside the edit dialog for an admin", () => {
    h.state.isAdmin = true;
    render(<CharacterDetail />);

    expect(screen.getByTestId("text-char-name")).toHaveTextContent(CHAR.name);
    fireEvent.click(screen.getByTestId("button-edit-character"));
    expect(screen.getByTestId("section-danger-zone")).toBeInTheDocument();
    expect(screen.getByTestId("button-confirm-delete")).toBeInTheDocument();
  });

  it("keeps admin delete reachable even when a pending edit locks the edit flow", () => {
    h.state.isAdmin = true;
    h.state.pendingEdit = { id: 99 };
    render(<CharacterDetail />);

    // A pending edit normally disables EDIT, but admins must still reach the
    // danger zone to delete the character.
    const editBtn = screen.getByTestId("button-edit-character") as HTMLButtonElement;
    expect(editBtn).toBeEnabled();
    fireEvent.click(editBtn);
    expect(screen.getByTestId("button-confirm-delete")).toBeInTheDocument();
  });

  it("non-admins remain locked out of editing while a pending edit exists", () => {
    h.state.isAdmin = false;
    h.state.pendingEdit = { id: 99 };
    render(<CharacterDetail />);

    expect(screen.getByTestId("button-edit-character")).toBeDisabled();
  });
});

describe("CharacterDetail: dossier background rendering", () => {
  beforeEach(() => {
    h.state.isAdmin = false;
    h.state.pendingEdit = undefined;
    h.state.sheetData = null;
    h.state.background = "";
  });

  it("renders the column background even when the character also has sections", () => {
    // Regression: a character whose bio lives in the top-level `background`
    // column AND who has a non-empty free-form `sections` map (e.g. Psychology,
    // Skills) used to have the background silently dropped — the discrete card
    // was suppressed whenever any section existed, and SheetSections never
    // renders the column value.
    h.state.background = "Grew up in Watson, ran with the Maelstrom.";
    h.state.sheetData = {
      sections: { Psychology: "Calm under fire.", Skills: "Netrunning" },
    };
    render(<CharacterDetail />);

    expect(screen.getByTestId("dossier-background")).toHaveTextContent(
      "Grew up in Watson, ran with the Maelstrom.",
    );
    // The free-form sections still render alongside it.
    expect(screen.getByTestId("section-Psychology")).toBeInTheDocument();
  });

  it("does NOT duplicate the bio when a 'Background' section already shows it", () => {
    h.state.background = "Grew up in Watson.";
    h.state.sheetData = {
      sections: { Background: "Grew up in Watson.", Skills: "Netrunning" },
    };
    render(<CharacterDetail />);

    // The section card carries the bio; the discrete column card is suppressed.
    expect(screen.getByTestId("section-Background")).toBeInTheDocument();
    expect(screen.queryByTestId("dossier-background")).toBeNull();
  });

  it("renders both when the column bio differs from a stale 'Background' section", () => {
    // The edit form rewrites the column but a legacy "Background" section may
    // still hold older text — surface BOTH so the newer column bio is not hidden.
    h.state.background = "Newly edited bio: now runs solo.";
    h.state.sheetData = {
      sections: { Background: "Old legacy bio.", Skills: "Netrunning" },
    };
    render(<CharacterDetail />);

    expect(screen.getByTestId("dossier-background")).toHaveTextContent(
      "Newly edited bio: now runs solo.",
    );
    expect(screen.getByTestId("section-Background")).toBeInTheDocument();
  });
});
