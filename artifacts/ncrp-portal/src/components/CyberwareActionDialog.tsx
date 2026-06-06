import { useState } from "react";
import {
  useSellRipperdocItem,
  useGiveRipperdocItem,
  useInstallRipperdocCyberware,
  useGetCharacterCyberware,
  getGetCharacterCyberwareQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";

type Action = "sell" | "give" | "install";

type Props = {
  venueId: number;
  stock: { id: number; name: string; price: number; quantity: number };
  onClose: () => void;
  onDone: () => void;
  // Optional pre-selected buyer (e.g. the Ripperdoc Console's current patient).
  // When `lockBuyer` is set the picker is read-only so the doc can't retarget
  // a different character mid-flow. Defaults keep the standalone clinic usage
  // (own picker, no preset) unchanged.
  presetBuyer?: CharacterPickerValue;
  lockBuyer?: boolean;
};

const ACTIONS: { key: Action; label: string }[] = [
  { key: "sell", label: "SELL" },
  { key: "give", label: "GIVE" },
  { key: "install", label: "INSTALL" },
];

export default function CyberwareActionDialog({ venueId, stock, onClose, onDone, presetBuyer, lockBuyer }: Props) {
  const [action, setAction] = useState<Action>("install");
  const [buyer, setBuyer] = useState<CharacterPickerValue>(presetBuyer ?? null);
  const [qty, setQty] = useState(1);
  const [memo, setMemo] = useState("");

  const sell = useSellRipperdocItem({ mutation: { onSuccess: onDone } });
  const give = useGiveRipperdocItem({ mutation: { onSuccess: onDone } });
  const install = useInstallRipperdocCyberware({ mutation: { onSuccess: onDone } });
  const m = action === "sell" ? sell : action === "give" ? give : install;

  // Live capacity preview for the selected buyer (only relevant for installs).
  const { data: cap } = useGetCharacterCyberware(venueId, buyer?.id ?? 0, {
    query: {
      enabled: action === "install" && !!buyer?.id,
      queryKey: getGetCharacterCyberwareQueryKey(venueId, buyer?.id ?? 0),
    },
  });

  // ApiError (custom-fetch) exposes the parsed JSON body on `.data`, NOT
  // `.response.data` — `.response` is the raw Response. Read `.data.error`
  // first, then the formatted `.message`, before any generic fallback so the
  // real backend reason ("at capacity", "insufficient funds", etc.) surfaces.
  const errMsg =
    (m.error as { data?: { error?: string } } | null)?.data?.error ??
    (m.error instanceof Error ? m.error.message : null) ??
    (m.error ? "Offer failed" : null);

  const q = Math.max(1, qty || 1);
  const total = action === "give" ? 0 : stock.price * q;
  const overCapacity =
    action === "install" && cap != null && cap.max != null && cap.available != null
      ? cap.available <= 0
      : false;

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-cyberware-action">
      <Card className="rounded-none border-nc-magenta bg-card w-full max-w-md">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-magenta">{stock.name}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-cyberware-action">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const cid = buyer?.id;
              if (!cid) return;
              if (action === "install") {
                install.mutate({ id: venueId, data: { stockId: stock.id, buyerCharacterId: cid, qty: q, memo: memo || undefined } });
              } else if (action === "give") {
                give.mutate({ id: venueId, data: { stockId: stock.id, buyerCharacterId: cid, qty: q, memo: memo || undefined } });
              } else {
                sell.mutate({ id: venueId, data: { stockId: stock.id, buyerCharacterId: cid, qty: q, memo: memo || undefined } });
              }
            }}
          >
            <div className="flex gap-1">
              {ACTIONS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setAction(a.key)}
                  className={`flex-1 rounded-none border px-2 py-1.5 font-display text-xs tracking-widest transition-colors ${
                    action === a.key
                      ? "border-nc-magenta bg-nc-magenta text-background"
                      : "border-border text-muted-foreground hover:border-nc-magenta/60"
                  }`}
                  data-testid={`button-action-${a.key}`}
                >
                  {a.label}
                </button>
              ))}
            </div>

            <p className="text-muted-foreground">
              Unit price <span className="text-nc-yellow">€${stock.price.toLocaleString()}</span> · In stock {stock.quantity}
            </p>
            <p className="text-muted-foreground text-xs">
              {action === "install"
                ? "Installs the chrome onto the character and counts toward their CWP. Charges the buyer and installs it immediately."
                : action === "give"
                  ? "Hands the item over for free. It lands in their inventory immediately."
                  : "Sells the item uninstalled. Charges the buyer and transfers it immediately."}
            </p>

            <div>
              <Label className="text-xs">BUYER</Label>
              {lockBuyer && buyer ? (
                <div
                  className="border border-border/60 bg-background/40 px-3 py-2 text-foreground"
                  data-testid="text-cyberware-buyer-locked"
                >
                  {buyer.name}
                </div>
              ) : (
                <CharacterPicker value={buyer} onChange={setBuyer} testId="input-cyberware-buyer" />
              )}
            </div>

            {action === "install" && buyer && cap && (
              <div className="border border-border/60 bg-background/40 px-3 py-2 text-xs space-y-0.5" data-testid="text-capacity-preview">
                <div className="flex justify-between">
                  <span className="text-muted-foreground uppercase">CWP Used</span>
                  <span className="text-foreground">{cap.used}{cap.max != null ? ` / ${cap.max}` : ""}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground uppercase">Free</span>
                  <span className={overCapacity ? "text-destructive" : "text-nc-green"}>
                    {cap.available == null ? "Unlimited (NPC)" : `${Math.max(0, cap.available)} CWP`}
                  </span>
                </div>
                {overCapacity && (
                  <div className="text-destructive pt-1">At capacity — remove chrome before installing more.</div>
                )}
              </div>
            )}

            <div>
              <Label className="text-xs">QTY</Label>
              <Input
                type="number"
                min={1}
                max={stock.quantity}
                value={qty || ""}
                onChange={(e) => setQty(Number(e.target.value))}
                data-testid="input-cyberware-qty"
              />
            </div>
            <div>
              <Label className="text-xs">MEMO (OPTIONAL)</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-cyberware-memo" />
            </div>

            <div className="flex justify-between border-t border-border/40 pt-2">
              <span>TOTAL</span>
              <span className="text-nc-yellow">{total > 0 ? `€$${total.toLocaleString()}` : "FREE"}</span>
            </div>

            {errMsg && <div className="text-destructive text-xs" data-testid="text-cyberware-error">{errMsg}</div>}

            <Button
              type="submit"
              disabled={m.isPending || !buyer || q < 1 || q > stock.quantity}
              className="w-full rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display"
              data-testid="button-confirm-cyberware-action"
            >
              {m.isPending ? "PROCESSING..." : ACTIONS.find((a) => a.key === action)!.label}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
