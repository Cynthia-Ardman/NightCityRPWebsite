import { useState } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { formatEddies } from "@/lib/format";
import {
  useRemoveRipperdocCyberware,
  useGetCharacterCyberware,
  getGetCharacterCyberwareQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";

type Props = {
  venueId: number;
  onClose: () => void;
  onDone: () => void;
  // Optional pre-selected patient (e.g. the Ripperdoc Console). With
  // `lockTarget` the picker is read-only. Defaults keep the clinic usage
  // (own picker, no preset) unchanged.
  presetTarget?: CharacterPickerValue;
  lockTarget?: boolean;
};

export default function RemoveCyberwareDialog({ venueId, onClose, onDone, presetTarget, lockTarget }: Props) {
  const [target, setTarget] = useState<CharacterPickerValue>(presetTarget ?? null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [fee, setFee] = useState(0);
  const [memo, setMemo] = useState("");
  const [destination, setDestination] = useState<"patient" | "clinic">("patient");

  const remove = useRemoveRipperdocCyberware({ mutation: { onSuccess: onDone } });
  const { data: cap, isFetching } = useGetCharacterCyberware(venueId, target?.id ?? 0, {
    query: {
      enabled: !!target?.id,
      queryKey: getGetCharacterCyberwareQueryKey(venueId, target?.id ?? 0),
    },
  });

  const errMsg = remove.error ? apiErrorMessage(remove.error, "Removal offer failed") : null;

  const installed = cap?.installed ?? [];

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-remove-cyberware">
      <Card className="rounded-none border-destructive bg-card w-full max-w-md">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-destructive">REMOVE CYBERWARE</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-remove-cyberware">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!target?.id || !itemId) return;
              remove.mutate({
                id: venueId,
                data: { removedItemId: itemId, buyerCharacterId: target.id, fee: fee > 0 ? fee : undefined, memo: memo || undefined, destination },
              });
            }}
          >
            <p className="text-muted-foreground text-xs">
              Uninstalls a piece of chrome so it no longer counts toward the character's CWP. Any fee is charged immediately.
            </p>

            <div>
              <Label className="text-xs">CHARACTER</Label>
              {lockTarget && target ? (
                <div
                  className="border border-border/60 bg-background/40 px-3 py-2 text-foreground"
                  data-testid="text-remove-character-locked"
                >
                  {target.name}
                </div>
              ) : (
                <CharacterPicker
                  value={target}
                  onChange={(v) => {
                    setTarget(v);
                    setItemId(null);
                  }}
                  testId="input-remove-character"
                />
              )}
            </div>

            {target && (
              <div>
                <Label className="text-xs">INSTALLED CYBERWARE</Label>
                {isFetching ? (
                  <div className="text-muted-foreground text-xs py-2 animate-pulse">Loading chrome…</div>
                ) : installed.length === 0 ? (
                  <div className="text-muted-foreground text-xs py-2" data-testid="text-no-installed">No installed cyberware on this character.</div>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto border border-border/60 p-1">
                    {installed.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => setItemId(it.id)}
                        className={`w-full text-left rounded-none border px-2 py-1.5 transition-colors ${
                          itemId === it.id
                            ? "border-destructive bg-destructive/15 text-foreground"
                            : "border-border/50 text-muted-foreground hover:border-destructive/60"
                        }`}
                        data-testid={`button-pick-chrome-${it.id}`}
                      >
                        <div className="flex justify-between">
                          <span className="truncate">{it.name}</span>
                          <span className="text-nc-yellow shrink-0 ml-2">{it.cwp} CWP</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div>
              <Label className="text-xs">REMOVED CHROME GOES TO</Label>
              <div className="grid grid-cols-2 gap-1 mt-1">
                <button
                  type="button"
                  onClick={() => setDestination("patient")}
                  className={`rounded-none border px-2 py-1.5 text-left transition-colors ${
                    destination === "patient"
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-primary/60"
                  }`}
                  data-testid="button-destination-patient"
                >
                  PATIENT
                  <div className="text-[10px] text-muted-foreground">They keep the loose chrome</div>
                </button>
                <button
                  type="button"
                  onClick={() => setDestination("clinic")}
                  className={`rounded-none border px-2 py-1.5 text-left transition-colors ${
                    destination === "clinic"
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-primary/60"
                  }`}
                  data-testid="button-destination-clinic"
                >
                  CLINIC STOCK
                  <div className="text-[10px] text-muted-foreground">Part lands in your inventory</div>
                </button>
              </div>
            </div>
            <div>
              <Label className="text-xs">REMOVAL FEE (OPTIONAL)</Label>
              <Input
                type="number"
                min={0}
                value={fee || ""}
                onChange={(e) => setFee(Math.max(0, Number(e.target.value)))}
                placeholder="0 = free"
                data-testid="input-remove-fee"
              />
            </div>
            <div>
              <Label className="text-xs">MEMO (OPTIONAL)</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-remove-memo" />
            </div>

            <div className="flex justify-between border-t border-border/40 pt-2">
              <span>FEE</span>
              <span className="text-nc-yellow">{fee > 0 ? `${formatEddies(fee)}` : "FREE"}</span>
            </div>

            {errMsg && <div className="text-destructive text-xs" data-testid="text-remove-error">{errMsg}</div>}

            <Button
              type="submit"
              disabled={remove.isPending || !target || !itemId}
              className="w-full rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display"
              data-testid="button-confirm-remove-cyberware"
            >
              {remove.isPending ? "PROCESSING..." : "REMOVE CYBERWARE"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
