import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@workspace/api-client-react";

// CatalogRent gates the admin Assign/Remove panel on `canAdminAssign =
// realIsAdmin && !viewAs`. These tests lock two things a regression could break:
//   1. a real admin previewing a lower role (viewAs set) must NOT see the panel,
//   2. a staff row-click opens the history modal and the assign flow fires the
//      lease mutation + refreshes the listing.
//
// useEffectiveMe is mocked so each test controls realIsAdmin / viewAs directly;
// its own admin-gating logic is covered by ViewAsContext.test.tsx.

const h = vi.hoisted(() => ({
  me: null as Me | null,
  realIsAdmin: false,
  viewAs: null as string | null,
  leaseMutate: vi.fn(),
  leaseOnSuccess: undefined as undefined | (() => void),
  history: null as unknown,
  listings: [] as unknown[],
  adminCharacters: [] as Array<{ id: number; name: string; ownerName?: string | null; archived?: boolean }>,
}));

vi.mock("@/contexts/ViewAsContext", () => ({
  useEffectiveMe: () => ({
    data: h.me,
    realIsAdmin: h.realIsAdmin,
    viewAs: h.viewAs,
    isLoading: false,
    isError: false,
  }),
}));

// Pull the CatalogRequestSection out — it has its own hooks/markup we don't test
// here and would only add noise to the render.
vi.mock("@/components/catalog/CatalogRequestSection", () => ({
  default: () => null,
}));

vi.mock("@workspace/api-client-react", () => ({
  useListRentListings: () => ({ data: h.listings as unknown[], isLoading: false }),
  useListMyCharacters: () => ({ data: [] }),
  useLeaseHousing: (opts?: { mutation?: { onSuccess?: () => void } }) => {
    h.leaseOnSuccess = opts?.mutation?.onSuccess;
    return {
      mutate: (vars: unknown) => {
        h.leaseMutate(vars);
        h.leaseOnSuccess?.();
      },
      isPending: false,
    };
  },
  useVacateHousing: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitCustomRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useListMyHousingRequests: () => ({ data: [] }),
  useListLifestyleTiers: () => ({ data: [] }),
  useUpdateRentListing: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useListDistricts: () => ({ data: [], isLoading: false }),
  useCreateDistrict: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCreateRentListing: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteRentListing: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useListPublicCharacters: () => ({ data: h.adminCharacters, isFetching: false }),
  getListDistrictsQueryKey: () => ["districts"],
  getListPublicCharactersQueryKey: () => ["public-characters"],
  useGetListingHistory: () => ({ data: h.history, isLoading: false }),
  useAdminListCharacters: () => ({ data: h.adminCharacters }),
  getAdminListCharactersQueryKey: () => ["admin-characters"],
  getListRentListingsQueryKey: () => ["rent-listings"],
  getGetListingHistoryQueryKey: (id: number) => ["listing-history", id],
  getListMyCustomRequestsQueryKey: () => ["my-custom-requests"],
}));

import CatalogRent from "./CatalogRent";

const LISTING = {
  id: 7,
  name: "Megabuilding H10 #42",
  district: "Watson",
  tier: "Housing Tier 2",
  monthlyRent: 1500,
  kind: "residential" as const,
  occupied: false,
};

function makeMe(over: Partial<Me> = {}): Me {
  return {
    id: "u1",
    discordId: "d1",
    username: "tester",
    globalName: null,
    avatarUrl: null,
    roles: [],
    isAdmin: false,
    isFixer: false,
    isArchivist: false,
    isCsApprover: false,
    isRipperdoc: false,
    isStoreOwner: false,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <CatalogRent />
    </QueryClientProvider>,
  );
  return { ...utils, invalidate };
}

beforeEach(() => {
  h.me = makeMe();
  h.realIsAdmin = false;
  h.viewAs = null;
  h.leaseMutate.mockReset();
  h.leaseOnSuccess = undefined;
  h.history = { listing: LISTING, currentTenant: null, payments: [], timeline: [] };
  h.adminCharacters = [{ id: 99, name: "V", ownerName: "Player One", archived: false }];
  h.listings = [LISTING];
});

describe("CatalogRent — admin assign panel gating", () => {
  it("a real admin (no preview) sees the admin panel after a row-click", async () => {
    h.me = makeMe({ isAdmin: true });
    h.realIsAdmin = true;
    h.viewAs = null;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId(`row-rent-${LISTING.id}`));

    expect(await screen.findByTestId("history-admin-panel")).toBeInTheDocument();
  });

  it("a real admin PREVIEWING a role does NOT see the admin panel (canAdminAssign false)", async () => {
    // realIsAdmin true but a preview override is active → canAdminAssign === false.
    // The effective (downgraded) identity is a fixer, so the modal still opens.
    h.me = makeMe({ isAdmin: false, isFixer: true });
    h.realIsAdmin = true;
    h.viewAs = "fixer"; // still staff (so the modal opens) but previewing
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId(`row-rent-${LISTING.id}`));

    // Modal opened (staff), but the assign/remove panel is gated out.
    expect(await screen.findByText("CURRENT OCCUPANT")).toBeInTheDocument();
    expect(screen.queryByTestId("history-admin-panel")).not.toBeInTheDocument();
  });

  it("a non-staff player cannot open the history modal at all", async () => {
    h.me = makeMe(); // no staff flags
    h.realIsAdmin = false;
    h.viewAs = null;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId(`row-rent-${LISTING.id}`));

    expect(screen.queryByText("CURRENT OCCUPANT")).not.toBeInTheDocument();
    expect(screen.queryByTestId("history-admin-panel")).not.toBeInTheDocument();
  });
});

describe("CatalogRent — admin assign happy path", () => {
  it("assigning a character fires the lease mutation and refreshes the listing", async () => {
    h.me = makeMe({ isAdmin: true });
    h.realIsAdmin = true;
    h.viewAs = null;
    const user = userEvent.setup();
    const { invalidate } = renderPage();

    await user.click(screen.getByTestId(`row-rent-${LISTING.id}`));
    const panel = await screen.findByTestId("history-admin-panel");

    // Search the typeahead, pick a character, then assign.
    await user.type(within(panel).getByTestId("history-select-character"), "V");
    await user.click(await within(panel).findByTestId("history-select-character-option-99"));
    await user.click(within(panel).getByTestId("history-button-assign"));

    await waitFor(() => expect(h.leaseMutate).toHaveBeenCalledTimes(1));
    expect(h.leaseMutate).toHaveBeenCalledWith({
      data: { catalogRentId: LISTING.id, characterId: 99, kind: "residential" },
    });
    // onSuccess → refresh() invalidates both the history and the listings query.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["listing-history", LISTING.id] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["rent-listings"] });
  });
});
