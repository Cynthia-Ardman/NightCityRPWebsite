import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Shared mock state — vi.hoisted lets the vi.mock factories below read these.
const h = vi.hoisted(() => ({
  storeMutate: vi.fn(),
  docMutate: vi.fn(),
  state: {
    storePending: false as boolean,
    docPending: false as boolean,
    storeError: null as unknown,
    docError: null as unknown,
    storeOpts: undefined as
      | undefined
      | { mutation?: { onSuccess?: () => void } },
    docOpts: undefined as
      | undefined
      | { mutation?: { onSuccess?: () => void } },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useSellStoreItem: (opts: { mutation?: { onSuccess?: () => void } }) => {
    h.state.storeOpts = opts;
    return {
      mutate: h.storeMutate,
      isPending: h.state.storePending,
      error: h.state.storeError,
    };
  },
  useSellRipperdocItem: (opts: { mutation?: { onSuccess?: () => void } }) => {
    h.state.docOpts = opts;
    return {
      mutate: h.docMutate,
      isPending: h.state.docPending,
      error: h.state.docError,
    };
  },
}));

// CharacterPicker has its own data dependencies (useListPublicCharacters,
// debounced search input, etc.) that aren't relevant to SellStockDialog's
// behavior. Replace it with a minimal controlled stand-in that simply
// exposes a single "pick" button to set a buyer.
vi.mock("@/components/CharacterPicker", () => ({
  default: ({
    value,
    onChange,
    testId,
  }: {
    value: { id: number; name: string } | null;
    onChange: (v: { id: number; name: string } | null) => void;
    testId?: string;
  }) =>
    value ? (
      <div data-testid={testId}>
        <span>{value.name}</span>
        <button
          type="button"
          onClick={() => onChange(null)}
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          clear
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => onChange({ id: 42, name: "Buyer Smith" })}
        data-testid={testId ? `${testId}-pick` : undefined}
      >
        pick
      </button>
    ),
}));

import SellStockDialog from "./SellStockDialog";

const STOCK = { id: 11, name: "Synth Coffee", price: 25, quantity: 10 };

function renderDialog(
  overrides?: Partial<React.ComponentProps<typeof SellStockDialog>>,
) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const utils = render(
    <SellStockDialog
      kind="store"
      venueId={3}
      stock={STOCK}
      onClose={onClose}
      onDone={onDone}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onDone };
}

describe("SellStockDialog", () => {
  beforeEach(() => {
    h.storeMutate.mockReset();
    h.docMutate.mockReset();
    h.state.storePending = false;
    h.state.docPending = false;
    h.state.storeError = null;
    h.state.docError = null;
    h.state.storeOpts = undefined;
    h.state.docOpts = undefined;
  });

  it("keeps the confirm button disabled until a buyer is selected", () => {
    renderDialog();
    const btn = screen.getByTestId("button-confirm-sell") as HTMLButtonElement;
    // Default qty is 1 (in-range) but no buyer yet — must stay disabled.
    expect(btn).toBeDisabled();

    fireEvent.click(screen.getByTestId("input-sell-buyer-pick"));
    expect(btn).toBeEnabled();
  });

  it("disables the confirm button on qty=0 or qty above available stock", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("input-sell-buyer-pick"));
    const btn = screen.getByTestId("button-confirm-sell") as HTMLButtonElement;
    const qty = screen.getByTestId("input-sell-qty") as HTMLInputElement;

    fireEvent.change(qty, { target: { value: "0" } });
    expect(btn).toBeDisabled();

    fireEvent.change(qty, { target: { value: "100" } });
    expect(btn).toBeDisabled();

    // Back to an in-range qty unlocks the sell again.
    fireEvent.change(qty, { target: { value: "5" } });
    expect(btn).toBeEnabled();
  });

  it("submits the store-sale mutation with the right payload", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("input-sell-buyer-pick"));
    fireEvent.change(screen.getByTestId("input-sell-qty"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByTestId("input-sell-memo"), {
      target: { value: "happy hour" },
    });

    fireEvent.click(screen.getByTestId("button-confirm-sell"));

    expect(h.storeMutate).toHaveBeenCalledTimes(1);
    expect(h.storeMutate).toHaveBeenCalledWith({
      id: 3,
      data: {
        stockId: STOCK.id,
        buyerCharacterId: 42,
        qty: 3,
        memo: "happy hour",
      },
    });
    // The other (ripperdoc) mutation must NOT be touched for kind=store.
    expect(h.docMutate).not.toHaveBeenCalled();
  });

  it("routes to the ripperdoc-sale mutation when kind=ripperdoc", () => {
    renderDialog({ kind: "ripperdoc" });
    fireEvent.click(screen.getByTestId("input-sell-buyer-pick"));
    fireEvent.click(screen.getByTestId("button-confirm-sell"));

    expect(h.docMutate).toHaveBeenCalledTimes(1);
    expect(h.docMutate).toHaveBeenCalledWith({
      id: 3,
      data: {
        stockId: STOCK.id,
        buyerCharacterId: 42,
        qty: 1,
        // No memo typed -> omitted from the payload (undefined).
        memo: undefined,
      },
    });
    expect(h.storeMutate).not.toHaveBeenCalled();
  });

  it("does NOT fire the mutation while the button is disabled (no buyer)", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("button-confirm-sell"));
    expect(h.storeMutate).not.toHaveBeenCalled();
    expect(h.docMutate).not.toHaveBeenCalled();
  });

  it("invokes the parent's onDone callback when the mutation succeeds", () => {
    const { onDone } = renderDialog();
    expect(h.state.storeOpts?.mutation?.onSuccess).toBeTypeOf("function");

    h.state.storeOpts!.mutation!.onSuccess!();

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("clicking the close (X) button calls onClose", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByTestId("button-close-sell"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces the API error message when the mutation fails", () => {
    h.state.storeError = {
      response: { data: { error: "Out of stock, choomba" } },
    };
    renderDialog();
    expect(screen.getByTestId("text-sell-error")).toHaveTextContent(
      "Out of stock, choomba",
    );
  });
});
