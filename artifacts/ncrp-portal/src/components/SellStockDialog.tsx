import { useState } from "react";
import { useSellStoreItem, useSellRipperdocItem } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";

type Props = {
  kind: "store" | "ripperdoc";
  venueId: number;
  stock: { id: number; name: string; price: number; quantity: number };
  onClose: () => void;
  onDone: () => void;
};

export default function SellStockDialog({ kind, venueId, stock, onClose, onDone }: Props) {
  const [buyerCharacterId, setBuyerCharacterId] = useState("");
  const [qty, setQty] = useState(1);
  const [memo, setMemo] = useState("");
  const sellStore = useSellStoreItem({ mutation: { onSuccess: onDone } });
  const sellDoc = useSellRipperdocItem({ mutation: { onSuccess: onDone } });
  const m = kind === "store" ? sellStore : sellDoc;
  const errMsg =
    (m.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (m.error ? "Sale failed" : null);
  const total = stock.price * Math.max(1, qty || 1);
  const accent = kind === "store" ? "nc-cyan" : "nc-magenta";
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-sell">
      <Card className={`rounded-none border-${accent} bg-card w-full max-w-md`}>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className={`font-display tracking-widest text-${accent}`}>SELL: {stock.name}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-sell">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const cid = parseInt(buyerCharacterId, 10);
              const q = Math.max(1, qty || 1);
              if (!cid || q > stock.quantity) return;
              const data = { stockId: stock.id, buyerCharacterId: cid, qty: q, memo: memo || undefined };
              if (kind === "store") sellStore.mutate({ id: venueId, data });
              else sellDoc.mutate({ id: venueId, data });
            }}
          >
            <p className="text-muted-foreground">
              Unit price <span className="text-nc-yellow">€${stock.price.toLocaleString()}</span> · In stock {stock.quantity}
            </p>
            <div>
              <Label className="text-xs">BUYER CHARACTER ID</Label>
              <Input
                value={buyerCharacterId}
                onChange={(e) => setBuyerCharacterId(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 142"
                data-testid="input-sell-buyer"
              />
            </div>
            <div>
              <Label className="text-xs">QTY</Label>
              <Input
                type="number"
                min={1}
                max={stock.quantity}
                value={qty || ""}
                onChange={(e) => setQty(Number(e.target.value))}
                data-testid="input-sell-qty"
              />
            </div>
            <div>
              <Label className="text-xs">MEMO (OPTIONAL)</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-sell-memo" />
            </div>
            <div className="flex justify-between border-t border-border/40 pt-2">
              <span>TOTAL</span>
              <span className="text-nc-yellow">€${total.toLocaleString()}</span>
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-sell-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={m.isPending || !buyerCharacterId || qty < 1 || qty > stock.quantity}
              className={`w-full rounded-none bg-${accent} text-background hover:bg-${accent}/80 font-display`}
              data-testid="button-confirm-sell"
            >
              {m.isPending ? "PROCESSING..." : "RING IT UP"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
