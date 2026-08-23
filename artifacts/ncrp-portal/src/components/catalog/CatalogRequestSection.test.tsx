import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// CatalogRequestSection in "choice mode" (typeChoices with 2+ entries) lets a
// player pick what kind of thing they're filing — gun / cyberware / general
// item — from a single entry point. These tests lock that the chosen category
// is what actually gets submitted, since players were filing guns/cyberware
// under the generic "item" type before.

const h = vi.hoisted(() => ({
  submit: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListMyCharacters: () => ({ data: [{ id: 5, name: "V", archived: false }] }),
  useSubmitCustomRequest: () => ({ mutate: h.submit, isPending: false }),
  useListMyCustomRequests: () => ({ data: [] }),
  useListStores: () => ({ data: [] }),
  useListRipperdocs: () => ({ data: [] }),
  getListMyCustomRequestsQueryKey: () => ["my-custom-requests"],
  getListStoresQueryKey: () => ["stores"],
  getListRipperdocsQueryKey: () => ["ripperdocs"],
}));

// SingleImageUpload has its own upload hooks/markup that are irrelevant here.
vi.mock("@/components/SingleImageUpload", () => ({ default: () => null }));

import CatalogRequestSection from "./CatalogRequestSection";

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CatalogRequestSection
        type="item"
        typeChoices={["item", "gun", "cyberware"]}
        presetCharacterId={5}
        buttonLabel="REQUEST CUSTOM ITEM"
        dialogTitle="Request Custom Item"
        dialogDescription="Ask staff to add a gun, cyberware, or general item."
        titleLabel="Item"
        titlePlaceholder="e.g. Med Kit"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.submit.mockReset();
});

describe("CatalogRequestSection — request-type picker", () => {
  it("uses the scalable editor layout with a substantial description area", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByTestId("button-request-item"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-layout", "responsive-editor");
    expect(dialog).toHaveClass("sm:max-w-5xl");
    expect(screen.getByTestId("input-description-item")).toHaveAttribute("rows", "8");
    expect(screen.getByTestId("input-description-item")).toHaveClass("lg:min-h-56");
  });

  it("offers gun / cyberware / general item and defaults to the entry type", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByTestId("button-request-item"));
    await user.click(screen.getByTestId("select-request-type"));

    expect(await screen.findByTestId("request-type-option-item")).toBeInTheDocument();
    expect(screen.getByTestId("request-type-option-gun")).toBeInTheDocument();
    expect(screen.getByTestId("request-type-option-cyberware")).toBeInTheDocument();
  });

  it("submits under the default 'item' type when the picker is untouched", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByTestId("button-request-item"));
    await user.type(screen.getByTestId("input-title-item"), "Encrypted Agent");
    await user.click(screen.getByTestId("button-submit-item"));

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][0].data).toMatchObject({
      type: "item",
      characterId: 5,
      title: "Encrypted Agent",
    });
  });

  it("submits under 'gun' after the player switches the picker", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByTestId("button-request-item"));
    await user.click(screen.getByTestId("select-request-type"));
    await user.click(await screen.findByTestId("request-type-option-gun"));

    // Testids stay stable on the entry type; only the submitted category changes.
    await user.type(screen.getByTestId("input-title-item"), "Lexington");
    await user.click(screen.getByTestId("button-submit-item"));

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][0].data).toMatchObject({
      type: "gun",
      characterId: 5,
      title: "Lexington",
    });
  });
});
