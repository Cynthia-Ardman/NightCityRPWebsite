import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mutable shared mock state, set per-test before rendering.
const h = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
  },
}));

// The page reads exactly one hook from the generated client (the public store
// query) plus the auth hook. We mock only what it touches so we never hit the
// network and avoid the fragile manual-mock flake documented for the portal
// vitest suite.
vi.mock("@workspace/api-client-react", () => ({
  useGetStorePublic: () => ({ data: h.state.data, isLoading: false }),
}));

vi.mock("@/hooks/useAuthMe", () => ({
  // Anonymous visitor: not staff. Staff affordances are irrelevant to the
  // staff-list rendering we're guarding here.
  useAuthMe: () => ({ data: undefined }),
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "9" }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import DirectoryStoreDetail from "./DirectoryStoreDetail";

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
});

describe("DirectoryStoreDetail staff list", () => {
  it("renders a row per name from employeeNames", () => {
    h.state.data = makeStore({
      employeeNames: ["Wakako Okada", "Regina Jones"],
    });
    render(<DirectoryStoreDetail />);

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
    render(<DirectoryStoreDetail />);

    expect(screen.getByText("No staff listed.")).toBeInTheDocument();
    expect(screen.queryByTestId("row-employee-0")).toBeNull();
  });

  it("falls back to the empty state when employeeNames is missing", () => {
    h.state.data = makeStore({ employeeNames: undefined });
    render(<DirectoryStoreDetail />);

    expect(screen.getByText("No staff listed.")).toBeInTheDocument();
    expect(screen.queryByTestId("row-employee-0")).toBeNull();
  });
});
