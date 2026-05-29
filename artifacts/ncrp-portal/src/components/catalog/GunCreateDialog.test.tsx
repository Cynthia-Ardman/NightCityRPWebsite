import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { createMutate } = vi.hoisted(() => ({ createMutate: vi.fn() }));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useCreateGun: () => ({ mutate: createMutate, isPending: false }),
  };
});

import GunCreateDialog from "./GunCreateDialog";

beforeEach(() => {
  createMutate.mockReset();
});

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GunCreateDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("GunCreateDialog", () => {
  it("does not submit when the name is blank", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("button-gun-create-save"));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("sends the entered fields in the create payload", () => {
    renderDialog();

    fireEvent.change(screen.getByTestId("input-gun-name"), {
      target: { value: "Prototype Rifle" },
    });
    fireEvent.change(screen.getByTestId("input-gun-price"), {
      target: { value: "2500" },
    });
    fireEvent.click(screen.getByTestId("button-gun-create-save"));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [payload] = createMutate.mock.calls[0];
    expect(payload.data.name).toBe("Prototype Rifle");
    expect(payload.data.price).toBe(2500);
  });
});
