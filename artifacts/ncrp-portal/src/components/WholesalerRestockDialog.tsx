import { useState, useMemo } from "react";
import {
  useListWholesalerItems,
  useWholesalerRestock,
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
  onClose: () => void;
  onDone: () => void;
};

export default function WholesalerRestockDialog({ kind, venueId, onClose, onDone }: Props) {
  const { data: items, isLoading } = useListWholesalerItems();
  const restock = useWholesalerRestock({ mutation: { onSuccess: onDone } });
  const [itemId, setItemId] = useState<string>("");
  const [qty, setQty] = useState(1);

  const eligible = useMemo(
    () => (items ?? []).filter((i) => !i.archived && i.tier === kind),
    [items, kind],
  );
  const selected = eligible.find((i) => String(i.id) === itemId);
  const total = (selected?.wholesalePrice ?? 0) * Math.max(1, qty || 1);
  const remaining = selected?.unitsRemaining;
  const overCap = remaining != null && qty > remaining;
  const accent = kind === "store" ? "nc-cyan" : "nc-magenta";
  const errMsg =
    (restock.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (restock.error ? "Restock failed" : null);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-restock">
      <Card className={`rounded-none border-${accent} bg-card w-full max-w-lg`}>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className={`font-display tracking-widest text-${accent}`}>
            WHOLESALER RESTOCK
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-restock">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!selected || qty < 1 || overCap) return;
              restock.mutate({
                data: {
                  wholesalerItemId: selected.id,
                  quantity: Math.max(1, qty || 1),
                  targetKind: kind,
                  targetStoreId: venueId,
                },
              });
            }}
          >
            <p className="text-muted-foreground">
              Purchases units from the wholesaler and adds them to this {kind === "store" ? "store" : "clinic"}'s stock.
              The cost is debited from <span className="text-nc-yellow">your</span> wallet.
            </p>
            <div>
              <Label className="text-xs">ITEM</Label>
              <Select value={itemId} onValueChange={setItemId}>
                <SelectTrigger data-testid="select-restock-item">
                  <SelectValue placeholder={isLoading ? "Loading..." : "Choose an item"} />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((i) => (
                    <SelectItem key={i.id} value={String(i.id)}>
                      {i.name} — €${i.wholesalePrice.toLocaleString()}
                      {i.unitsRemaining != null ? ` · ${i.unitsRemaining} left` : ""}
                    </SelectItem>
                  ))}
                  {eligible.length === 0 && !isLoading && (
                    <SelectItem value="__none__" disabled>
                      No wholesaler items for this tier
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            {selected && (
              <div className="text-xs text-muted-foreground space-y-1 border border-border/40 p-2">
                {selected.category && <div>Category: <span className="text-foreground">{selected.category}</span></div>}
                {selected.suggestedRetailPrice != null && (
                  <div>Suggested retail: <span className="text-nc-yellow">€${selected.suggestedRetailPrice.toLocaleString()}</span></div>
                )}
                {selected.notes && <div className="italic">{selected.notes}</div>}
                {selected.cap != null && (
                  <div>
                    Wholesaler cap: {selected.unitsOrdered}/{selected.cap}
                    {selected.unitsRemaining === 0 && <span className="text-destructive ml-2">SOLD OUT</span>}
                  </div>
                )}
              </div>
            )}
            <div>
              <Label className="text-xs">QTY</Label>
              <Input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                data-testid="input-restock-qty"
              />
            </div>
            <div className="flex items-center justify-between border-t border-border/40 pt-3">
              <span className="text-muted-foreground">Total</span>
              <span className="text-nc-yellow text-lg">€${total.toLocaleString()}</span>
            </div>
            {overCap && (
              <p className="text-destructive text-xs">
                Cap exceeded — only {remaining} unit{remaining === 1 ? "" : "s"} left from the wholesaler.
              </p>
            )}
            {errMsg && <p className="text-destructive text-xs" data-testid="text-restock-error">{errMsg}</p>}
            <Button
              type="submit"
              disabled={!selected || qty < 1 || overCap || restock.isPending}
              className={`w-full rounded-none bg-${accent} text-background font-display`}
              data-testid="button-submit-restock"
            >
              {restock.isPending ? "PROCESSING..." : `PURCHASE x${qty}`}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
