import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// GunRow itself is pure UI, but importing it pulls in the whole NewSheet
// module, which imports the generated hooks + wouter — stub those out.
vi.mock("@workspace/api-client-react", () => ({
  useSubmitSheet: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSheet: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSubmitDraftSheet: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSheet: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useGetSheet: () => ({ data: undefined, isLoading: false }),
  useListCyberware: () => ({ data: [] }),
  useListGuns: () => ({ data: [] }),
  useListGuidebook: () => ({ data: { sections: [] } }),
  useListTagOptions: () => ({ data: [] }),
  getListTagOptionsQueryKey: () => ["tag-options"],
  useGetMe: () => ({ data: { id: 1 }, isLoading: false }),
  getGetMeQueryKey: () => ["me"],
  getListMySheetsQueryKey: () => ["sheets", "mine"],
  getGetSheetQueryKey: (id: number) => ["sheets", id],
}));
vi.mock("wouter", () => ({
  useParams: () => ({}),
  useLocation: () => ["/sheets/new", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { GunRow } from "./NewSheet";

const CATALOG = ["Militech M-10AF Lexington", "Malorian Arms 3516", "Tsunami Nue"];

function renderRow(value: string, onChange = vi.fn()) {
  render(
    <GunRow index={0} value={value} catalogNames={CATALOG} onChange={onChange} onRemove={vi.fn()} />,
  );
  return onChange;
}

describe("GunRow", () => {
  it("labels a catalog pick CATALOG (loose match, punctuation-insensitive)", () => {
    renderRow("militech m10af lexington");
    expect(screen.getByTestId("badge-gun-kind-0").textContent).toBe("CATALOG");
    // No did-you-mean nudge and no custom input for catalog entries.
    expect(screen.queryByTestId("text-gun-suggestion-0")).toBeNull();
    expect(screen.queryByTestId("input-gun-0")).toBeNull();
  });

  it("labels a non-catalog name CUSTOM and keeps the free-text input visible", () => {
    renderRow("Frankengun Mk0");
    expect(screen.getByTestId("badge-gun-kind-0").textContent).toBe("CUSTOM");
    expect(screen.getByTestId("input-gun-0")).toBeInTheDocument();
    expect(screen.queryByTestId("text-gun-suggestion-0")).toBeNull();
  });

  it("nudges near-misses to the catalog and adopts on click", () => {
    const onChange = renderRow("Malorian Arms 3517");
    expect(screen.getByTestId("text-gun-suggestion-0").textContent).toContain("Malorian Arms 3516");
    fireEvent.click(screen.getByTestId("button-gun-adopt-0"));
    expect(onChange).toHaveBeenCalledWith("Malorian Arms 3516");
  });

  it("suggests the full catalog entry for a partial name", () => {
    renderRow("Lexington");
    expect(screen.getByTestId("text-gun-suggestion-0").textContent).toContain(
      "Militech M-10AF Lexington",
    );
  });

  it("shows the catalog picker as the primary control on an empty row", () => {
    renderRow("");
    expect(screen.getByTestId("button-gun-picker-0").textContent).toContain("SELECT FROM CATALOG");
    expect(screen.queryByTestId("badge-gun-kind-0")).toBeNull();
    expect(screen.queryByTestId("input-gun-0")).toBeNull();
  });
});
