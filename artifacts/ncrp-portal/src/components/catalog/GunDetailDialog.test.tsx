import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { updateMutate } = vi.hoisted(() => ({ updateMutate: vi.fn() }));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useUpdateGun: () => ({ mutate: updateMutate, isPending: false }),
  };
});

import GunDetailDialog from "./GunDetailDialog";
import type { Gun } from "./gunTypes";

beforeEach(() => {
  updateMutate.mockReset();
});

function makeGun(overrides: Partial<Gun> = {}): Gun {
  return {
    id: 42,
    name: "Militech Iron",
    category: "ranged",
    manufacturer: "Militech",
    damage: "5d6",
    magSize: 12,
    price: 1500,
    notes: "Reliable sidearm",
    wholesalePrice: 800,
    restriction: "power",
    status: "live",
    powerLevel: "common",
    weaponType: "pistol",
    ...overrides,
  };
}

function renderDialog(gun: Gun, isStaff: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GunDetailDialog gun={gun} isStaff={isStaff} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("GunDetailDialog (read-only for players)", () => {
  it("shows weapon details but no edit button for non-staff", () => {
    renderDialog(makeGun(), false);
    expect(screen.getByText("MILITECH IRON")).toBeTruthy();
    expect(screen.queryByTestId("button-gun-edit")).toBeNull();
  });

  it("does not surface wholesale price to non-staff", () => {
    renderDialog(makeGun({ wholesalePrice: 800 }), false);
    // The "Wholesale" row is staff-only.
    expect(screen.queryByText("Wholesale")).toBeNull();
  });

  it("shows wholesale price and an edit button to staff", () => {
    renderDialog(makeGun({ wholesalePrice: 800 }), true);
    expect(screen.getByText("Wholesale")).toBeTruthy();
    expect(screen.getByTestId("button-gun-edit")).toBeTruthy();
  });
});

describe("GunDetailDialog (staff editing)", () => {
  it("enters edit mode and sends only changed fields", () => {
    renderDialog(makeGun({ name: "Old Name", price: 1500, status: "draft" }), true);

    fireEvent.click(screen.getByTestId("button-gun-edit"));
    fireEvent.change(screen.getByTestId("input-gun-name"), { target: { value: "New Name" } });
    fireEvent.click(screen.getByTestId("toggle-gun-status-live"));
    fireEvent.click(screen.getByTestId("button-gun-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [payload] = updateMutate.mock.calls[0];
    expect(payload.id).toBe(42);
    expect(payload.data.name).toBe("New Name");
    expect(payload.data.status).toBe("live");
    // unchanged fields are omitted from the patch
    expect(payload.data.price).toBeUndefined();
  });

  it("does not call the API when nothing changed", () => {
    renderDialog(makeGun(), true);
    fireEvent.click(screen.getByTestId("button-gun-edit"));
    fireEvent.click(screen.getByTestId("button-gun-save"));
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
