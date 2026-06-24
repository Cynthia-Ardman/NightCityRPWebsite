import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mutable shared mock state, set per-test before rendering.
const h = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
    me: undefined as unknown,
    myStores: [] as Array<{ id: number }>,
  },
}));

// The page reads the public store query plus the give-to-store mutation from the
// generated client, the effective-me hook, and a toast. We mock only what it
// touches so we never hit the network and avoid the fragile manual-mock flake
// documented for the portal vitest suite.
vi.mock("@workspace/api-client-react", () => ({
  useGetStorePublic: () => ({ data: h.state.data, isLoading: false }),
  useGiveToStore: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useListMyStores: () => ({ data: h.state.myStores ?? [] }),
  getGetStorePublicQueryKey: (id: number) => ["getStorePublic", id],
}));

vi.mock("@/contexts/ViewAsContext", () => ({
  // Anonymous visitor by default: no `me`, so the "Give eddies" card is hidden.
  // Individual tests can flip h.state.me to exercise the logged-in branch.
  useEffectiveMe: () => ({ data: h.state.me }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "9" }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import DirectoryStoreDetail from "./DirectoryStoreDetail";

// useQueryClient (used for cache invalidation) needs a provider in scope.
function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DirectoryStoreDetail />
    </QueryClientProvider>,
  );
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    name: "Test Store",
    location: "Kabuki",
    kind: "weapons",
    ownerId: null,
    ownerName: null,
    purpose: null,
    description: null,
    bannerUrl: null,
    employeeNames: [],
    ...overrides,
  };
}

beforeEach(() => {
  h.state.data = undefined;
  h.state.me = undefined;
  h.state.myStores = [];
});

describe("DirectoryStoreDetail manage button", () => {
  it("hides MANAGE when the store is not one the viewer owns or works at", () => {
    h.state.data = makeStore({ id: 9 });
    h.state.myStores = [{ id: 1 }];
    renderPage();
    expect(screen.queryByTestId("button-manage-store")).toBeNull();
  });

  it("shows MANAGE when the store is in the viewer's owned/employed list", () => {
    h.state.data = makeStore({ id: 9 });
    h.state.myStores = [{ id: 9 }];
    renderPage();
    expect(screen.getByTestId("button-manage-store")).toBeInTheDocument();
  });
});

describe("DirectoryStoreDetail staff list", () => {
  it("renders a row per name from employeeNames", () => {
    h.state.data = makeStore({
      employeeNames: ["Wakako Okada", "Regina Jones"],
    });
    renderPage();

    expect(screen.getByTestId("row-employee-0")).toHaveTextContent(
      "Wakako Okada",
    );
    expect(screen.getByTestId("row-employee-1")).toHaveTextContent(
      "Regina Jones",
    );
    // The empty-state fallback must NOT appear when staff exist.
    expect(screen.queryByText("No staff listed.")).toBeNull();
  });

  it("shows the empty-state fallback only when employeeNames is empty", () => {
    h.state.data = makeStore({ employeeNames: [] });
    renderPage();

    expect(screen.getByText("No staff listed.")).toBeInTheDocument();
    expect(screen.queryByTestId("row-employee-0")).toBeNull();
  });

  it("falls back to the empty state when employeeNames is missing", () => {
    h.state.data = makeStore({ employeeNames: undefined });
    renderPage();

    expect(screen.getByText("No staff listed.")).toBeInTheDocument();
    expect(screen.queryByTestId("row-employee-0")).toBeNull();
  });
});
