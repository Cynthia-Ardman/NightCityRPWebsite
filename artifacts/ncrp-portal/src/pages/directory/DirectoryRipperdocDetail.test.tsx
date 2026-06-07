import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mutable shared mock state, set per-test before rendering.
const h = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
  },
}));

// The page reads exactly two hooks from the generated client (the public
// ripperdoc query) and the auth hook. We mock only what it touches so we never
// hit the network and avoid the fragile manual-mock flake documented for the
// portal vitest suite.
vi.mock("@workspace/api-client-react", () => ({
  useGetRipperdocPublic: () => ({ data: h.state.data, isLoading: false }),
}));

vi.mock("@/hooks/useAuthMe", () => ({
  // Anonymous visitor: not staff, not owner. Staff/owner affordances are
  // irrelevant to the staff-list rendering we're guarding here.
  useAuthMe: () => ({ data: undefined }),
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "5" }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import DirectoryRipperdocDetail from "./DirectoryRipperdocDetail";

function makeClinic(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: "Test Clinic",
    location: "Watson",
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

describe("DirectoryRipperdocDetail staff list", () => {
  it("renders a row per name from employeeNames", () => {
    h.state.data = makeClinic({
      employeeNames: ["Vik Vektor", "Misty Olszewski"],
    });
    render(<DirectoryRipperdocDetail />);

    expect(screen.getByTestId("row-employee-0")).toHaveTextContent("Vik Vektor");
    expect(screen.getByTestId("row-employee-1")).toHaveTextContent(
      "Misty Olszewski",
    );
    // The empty-state fallback must NOT appear when staff exist.
    expect(screen.queryByText("No staff listed.")).toBeNull();
  });

  it("shows the empty-state fallback only when employeeNames is empty", () => {
    h.state.data = makeClinic({ employeeNames: [] });
    render(<DirectoryRipperdocDetail />);

    expect(screen.getByText("No staff listed.")).toBeInTheDocument();
    expect(screen.queryByTestId("row-employee-0")).toBeNull();
  });

  it("falls back to the empty state when employeeNames is missing", () => {
    h.state.data = makeClinic({ employeeNames: undefined });
    render(<DirectoryRipperdocDetail />);

    expect(screen.getByText("No staff listed.")).toBeInTheDocument();
    expect(screen.queryByTestId("row-employee-0")).toBeNull();
  });
});
