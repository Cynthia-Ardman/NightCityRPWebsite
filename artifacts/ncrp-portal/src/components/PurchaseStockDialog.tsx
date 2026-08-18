import { useState, useMemo } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { formatEddies } from "@/lib/format";
import {
  useListGuns,
  useListCyberware,
  usePurchaseStoreStock,
  usePurchaseRipperdocStock,
  getListGunsQueryKey,
  getListCyberwareQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";

type Props = {
  kind: "store" | "ripperdoc";
  venueId: number;
  balance: number;
  // Fixers/Admins may set a custom (or free) cost; that routes a cost
  // approval to the venue owner when the cost is greater than zero.
  canSetCost?: boolean;
  onClose: () => void;
  onDone: () => void;
};

type CatalogRow = {
  id: number;
  name: string;
  category: string | null;
  price: number;
};

type CostMode = "catalog" | "free" | "custom";

export default function PurchaseStockDialog({
  kind,
  venueId,
  balance,
  canSetCost = false,
  onClose,
  onDone,
}: Props) {
  const isStore = kind === "store";
  const gunsQuery = useListGuns({
    query: { enabled: isStore, queryKey: getListGunsQueryKey() },
  });
  const cyberQuery = useListCyberware({
    query: { enabled: !isStore, queryKey: getListCyberwareQueryKey() },
  });

  const [pending, setPending] = useState(false);
  const handleSuccess = (resp: { pendingApproval?: boolean }) => {
    if (resp?.pendingApproval) {
      setPending(true);
    } else {
      onDone();
    }
  };
  const purchaseStore = usePurchaseStoreStock({ mutation: { onSuccess: handleSuccess } });
  const purchaseDoc = usePurchaseRipperdocStock({ mutation: { onSuccess: handleSuccess } });
  const m = isStore ? purchaseStore : purchaseDoc;

  const [catalogId, setCatalogId] = useState<string>("");
  const [qty, setQty] = useState(1);
  const [retailPrice, setRetailPrice] = useState<number | "">("");
  const [costMode, setCostMode] = useState<CostMode>("catalog");
  const [customCost, setCustomCost] = useState<number | "">("");

  const rows = useMemo<CatalogRow[]>(() => {
    if (isStore) {
      return (gunsQuery.data ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        category: g.category ?? null,
        price: g.price,
      }));
    }
    return (cyberQuery.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      category: c.slot ?? null,
      price: c.price,
    }));
  }, [isStore, gunsQuery.data, cyberQuery.data]);

  const isLoading = isStore ? gunsQuery.isLoading : cyberQuery.isLoading;
  const selected = rows.find((r) => String(r.id) === catalogId);

  const usesOverride = canSetCost && costMode !== "catalog";
  const overrideValue = costMode === "free" ? 0 : customCost === "" ? 0 : Math.max(0, Number(customCost));
  const unitCost = selected ? (usesOverride ? overrideValue : selected.price) : 0;
  const q = Math.max(1, qty || 1);
  const totalCost = unitCost * q;
  // A custom cost greater than zero is routed to the owner for approval, so it
  // does not need to fit within the current balance at submit time.
  const routesApproval = usesOverride && unitCost > 0;
  const insufficient = !!selected && !routesApproval && totalCost > balance;
  const accent = isStore ? "nc-cyan" : "nc-magenta";
  const errMsg = m.error ? apiErrorMessage(m.error, "Purchase failed") : null;

  if (pending) {
    return (
      <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-purchase">
        <Card className={`rounded-none border-${accent} bg-card w-full max-w-lg`}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className={`font-display tracking-widest text-${accent}`}>COST APPROVAL SENT</CardTitle>
            <Button variant="ghost" size="icon" onClick={onDone} data-testid="button-close-purchase">
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4 font-mono text-sm">
            <p className="text-muted-foreground" data-testid="text-purchase-pending">
              This stock has a custom cost, so a request was sent to the venue owner. Once they approve it under
              "My Submissions", the cost is debited from the venue balance and the stock is added.
            </p>
            <Button
              onClick={onDone}
              className={`w-full rounded-none bg-${accent} text-background font-display`}
              data-testid="button-purchase-done"
            >
              DONE
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-purchase">
      <Card className={`rounded-none border-${accent} bg-card w-full max-w-lg`}>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className={`font-display tracking-widest text-${accent}`}>
            BUY STOCK ({isStore ? "STORE" : "CLINIC"}-FUNDED)
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-purchase">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!selected || q < 1 || insufficient) return;
              const data = {
                catalogId: selected.id,
                qty: q,
                retailPrice: retailPrice === "" ? undefined : Number(retailPrice),
                ...(usesOverride ? { unitCost: unitCost } : {}),
              };
              if (isStore) purchaseStore.mutate({ id: venueId, data });
              else purchaseDoc.mutate({ id: venueId, data });
            }}
          >
            <p className="text-muted-foreground text-xs">
              Buys {isStore ? "guns" : "cyberware"} from the catalog into this {isStore ? "store" : "clinic"}'s stock at
              catalog price, debited from the {isStore ? "store" : "clinic"} account.
            </p>
            <div className="flex items-center justify-between border border-border/40 px-3 py-1.5">
              <span className="text-muted-foreground text-xs">ACCOUNT BALANCE</span>
              <span className="text-nc-yellow">{formatEddies(balance)}</span>
            </div>
            <div>
              <Label className="text-xs">CATALOG ITEM</Label>
              <Select value={catalogId} onValueChange={setCatalogId}>
                <SelectTrigger data-testid="select-purchase-item">
                  <SelectValue placeholder={isLoading ? "Loading..." : "Choose an item"} />
                </SelectTrigger>
                <SelectContent>
                  {rows.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name} — {formatEddies(r.price)}
                    </SelectItem>
                  ))}
                  {rows.length === 0 && !isLoading && (
                    <SelectItem value="__none__" disabled>
                      No catalog items available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            {selected && (
              <div className="text-xs text-muted-foreground space-y-1 border border-border/40 p-2">
                {selected.category && <div>Category: <span className="text-foreground">{selected.category}</span></div>}
                <div>Catalog price: <span className="text-nc-yellow">{formatEddies(selected.price)}</span></div>
                <div>Unit cost: <span className="text-nc-yellow">{formatEddies(unitCost)}</span></div>
              </div>
            )}
            {canSetCost && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">COST (FIXER/ADMIN)</Label>
                  <Select value={costMode} onValueChange={(v) => setCostMode(v as CostMode)}>
                    <SelectTrigger data-testid="select-purchase-cost-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="catalog">Catalog price</SelectItem>
                      <SelectItem value="free">Free</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {costMode === "custom" && (
                  <div>
                    <Label className="text-xs">CUSTOM UNIT COST</Label>
                    <Input
                      type="number"
                      min={0}
                      value={customCost}
                      onChange={(e) => setCustomCost(e.target.value === "" ? "" : Number(e.target.value))}
                      data-testid="input-purchase-custom-cost"
                    />
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">QTY</Label>
                <Input
                  type="number"
                  min={1}
                  value={qty || ""}
                  onChange={(e) => setQty(Number(e.target.value))}
                  data-testid="input-purchase-qty"
                />
              </div>
              <div>
                <Label className="text-xs">SALE PRICE (OPTIONAL)</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder="0"
                  value={retailPrice}
                  onChange={(e) => setRetailPrice(e.target.value === "" ? "" : Number(e.target.value))}
                  data-testid="input-purchase-retail"
                />
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border/40 pt-3">
              <span className="text-muted-foreground">Total cost</span>
              <span className="text-nc-yellow text-lg">{formatEddies(totalCost)}</span>
            </div>
            {routesApproval && (
              <p className="text-muted-foreground text-xs" data-testid="text-purchase-routes-approval">
                This custom cost will be sent to the venue owner for approval before any funds move.
              </p>
            )}
            {insufficient && (
              <p className="text-destructive text-xs" data-testid="text-purchase-insufficient">
                Insufficient {isStore ? "store" : "clinic"} balance for this purchase.
              </p>
            )}
            {errMsg && <p className="text-destructive text-xs" data-testid="text-purchase-error">{errMsg}</p>}
            <Button
              type="submit"
              disabled={!selected || q < 1 || insufficient || m.isPending}
              className={`w-full rounded-none bg-${accent} text-background font-display`}
              data-testid="button-submit-purchase"
            >
              {m.isPending ? "PROCESSING..." : routesApproval ? "SEND FOR APPROVAL" : `BUY x${q}`}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
