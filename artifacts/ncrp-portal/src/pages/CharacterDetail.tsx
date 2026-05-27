import {
  useGetCharacter,
  useGetWallet,
  useGetWalletTransactions,
  useTransferEddies,
  useGetCharacterInventory,
  useAddInventoryItem,
  useUpdateInventoryItem,
  useRemoveInventoryItem,
  useTransferInventoryItem,
  useGetCharacterHousing,
  useVacateHousing,
  getGetCharacterHousingQueryKey,
  useGetCharacterStatus,
  useUpdateCharacterStatus,
  getGetWalletQueryKey,
  getGetWalletTransactionsQueryKey,
  getGetCharacterInventoryQueryKey,
  getGetCharacterStatusQueryKey,
} from "@workspace/api-client-react";
import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, ShieldAlert, Wallet, Package, Activity, Terminal, Plus, Trash2, AlertTriangle, Send, DollarSign, X, Home } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch as UiSwitch } from "@/components/ui/switch";

export default function CharacterDetail() {
  const { id } = useParams();
  const charId = Number(id);

  const { data: char, isLoading: charLoading } = useGetCharacter(charId);

  if (charLoading) return <div className="p-8 text-nc-cyan font-display text-xl animate-pulse">DECRYPTING_IDENTITY...</div>;
  if (!char) return <div className="p-8 text-destructive font-display text-xl">ERROR: IDENTITY_NOT_FOUND</div>;

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row gap-6 items-start md:items-end border-b border-border pb-6">
        <Avatar className="h-32 w-32 border-2 border-nc-cyan rounded-none shadow-[0_0_20px_rgba(0,255,255,0.2)] bg-card p-1">
          <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ""} className="object-cover rounded-none" />
          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-4xl">
            {char.name.substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground" data-testid="text-char-name">{char.name}</h1>
            {char.approved ? (
              <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none px-2 py-1 flex items-center gap-1 font-mono text-xs">
                <Shield className="w-3 h-3" /> VERIFIED
              </Badge>
            ) : (
              <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none px-2 py-1 flex items-center gap-1 font-mono text-xs animate-pulse">
                <ShieldAlert className="w-3 h-3" /> PENDING_APPROVAL
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm font-mono uppercase tracking-widest text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-foreground">TYPE:</span>
              <span className={char.kind === "pc" ? "text-nc-magenta" : "text-nc-yellow"}>{char.kind}</span>
            </div>
            {char.archetype && (
              <div className="flex items-center gap-2">
                <span className="text-foreground">ARCHETYPE:</span>
                <span className="text-nc-cyan">{char.archetype}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-foreground">STATUS:</span>
              <span className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${char.isActive ? "bg-nc-cyan shadow-[0_0_5px_currentColor]" : "bg-muted"}`} />
                {char.isActive ? "ACTIVE" : "STANDBY"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="bg-card border border-border rounded-none p-0 h-auto flex overflow-x-auto w-full max-w-full no-scrollbar">
          <TabsTrigger value="profile" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-profile">
            <Terminal className="w-4 h-4 mr-2 hidden sm:inline" /> Profile
          </TabsTrigger>
          <TabsTrigger value="wallet" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-wallet">
            <Wallet className="w-4 h-4 mr-2 hidden sm:inline" /> Wallet
          </TabsTrigger>
          <TabsTrigger value="inventory" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-inv">
            <Package className="w-4 h-4 mr-2 hidden sm:inline" /> Inventory
          </TabsTrigger>
          <TabsTrigger value="status" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-status">
            <Activity className="w-4 h-4 mr-2 hidden sm:inline" /> Status
          </TabsTrigger>
        </TabsList>

        <div className="mt-8">
          <TabsContent value="profile" className="space-y-6 outline-none focus:ring-0">
            <SheetSections sections={(char.sheetData as { sections?: Record<string, string> } | null | undefined)?.sections} background={char.background} />
            <HousingCard characterId={char.id} />
            <ImageGallery title="PORTRAITS" urls={char.portraitUrls ?? []} />
            <ImageGallery title="STATS / SHEET IMAGES" urls={char.statsImageUrls ?? []} />
          </TabsContent>

          <TabsContent value="wallet" className="outline-none focus:ring-0">
            <WalletTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="inventory" className="outline-none focus:ring-0">
            <InventoryTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="status" className="outline-none focus:ring-0">
            <StatusTab characterId={char.id} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function WalletTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: wallet, isLoading, error } = useGetWallet(characterId);
  const { data: txs } = useGetWalletTransactions(characterId);
  const transfer = useTransferEddies({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetWalletQueryKey(characterId) });
        qc.invalidateQueries({ queryKey: getGetWalletTransactionsQueryKey(characterId) });
        setTo("");
        setAmount(0);
        setMemo("");
      },
    },
  });
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState(0);
  const [memo, setMemo] = useState("");

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Fetching UB ledger...</div>;
  if (error || !wallet) {
    return (
      <Card className="rounded-none border-destructive bg-card/50" data-testid="card-wallet-unavailable">
        <CardContent className="py-6 flex items-center gap-3 text-destructive font-mono">
          <AlertTriangle className="w-5 h-5" /> Wallet provider unavailable. UnbelievaBoat must be reachable to view balance.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan">BALANCE</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono">
          <Stat label="CASH" value={wallet.cash ?? 0} />
          <Stat label="BANK" value={wallet.bank ?? 0} />
          <Stat label="TOTAL" value={wallet.balance} highlight />
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">TRANSFER EDDIES</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const toCharacterId = parseInt(to, 10);
              if (!toCharacterId || amount <= 0) return;
              transfer.mutate({ id: characterId, data: { toCharacterId, amount, memo: memo || undefined } });
            }}
          >
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">TO CHARACTER ID</Label>
              <Input value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" data-testid="input-transfer-to" />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">AMOUNT (€$)</Label>
              <Input type="number" min={1} value={amount || ""} onChange={(e) => setAmount(Number(e.target.value))} data-testid="input-transfer-amount" />
            </div>
            <div className="sm:col-span-4">
              <Label className="text-xs font-mono">MEMO</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-transfer-memo" />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={transfer.isPending || !to || amount <= 0} className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-transfer">
                {transfer.isPending ? "SENDING..." : "SEND"}
              </Button>
            </div>
          </form>
          {transfer.error && (
            <div className="mt-3 text-destructive font-mono text-sm" data-testid="text-transfer-error">
              Transfer failed. Check funds or try again.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">LEDGER</CardTitle>
        </CardHeader>
        <CardContent>
          {!txs || txs.length === 0 ? (
            <div className="text-muted-foreground font-mono italic">No transactions yet.</div>
          ) : (
            <div className="space-y-1 font-mono text-sm" data-testid="list-wallet-txs">
              {txs.map((t) => (
                <div key={t.id} className="grid grid-cols-12 gap-2 border-b border-border/30 py-2 items-center">
                  <span className="col-span-3 text-muted-foreground">{new Date(t.createdAt).toLocaleString()}</span>
                  <span className="col-span-2 uppercase text-nc-cyan">{t.kind}</span>
                  <span className={`col-span-2 text-right ${t.amount < 0 ? "text-destructive" : "text-nc-green"}`}>
                    {t.amount < 0 ? "-" : "+"}€${Math.abs(t.amount)}
                  </span>
                  <span className="col-span-5 truncate text-muted-foreground">{t.counterpartyName ? `${t.counterpartyName} · ` : ""}{t.memo ?? ""}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`border ${highlight ? "border-nc-cyan" : "border-border"} p-4`}>
      <div className="text-xs uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`text-3xl font-display ${highlight ? "text-nc-cyan" : "text-foreground"}`}>€${value}</div>
    </div>
  );
}

function InventoryTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: items, isLoading } = useGetCharacterInventory(characterId);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) });
    qc.invalidateQueries({ queryKey: getGetWalletQueryKey(characterId) });
    qc.invalidateQueries({ queryKey: getGetWalletTransactionsQueryKey(characterId) });
  };
  const addItem = useAddInventoryItem({ mutation: { onSuccess: invalidate } });
  const updateItem = useUpdateInventoryItem({ mutation: { onSuccess: invalidate } });
  const deleteItem = useRemoveInventoryItem({ mutation: { onSuccess: invalidate } });
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [transferItemId, setTransferItemId] = useState<number | null>(null);

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Scanning personal stash...</div>;

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest">ADD ITEM</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              addItem.mutate({
                id: characterId,
                data: { name: name.trim(), category: category || undefined, quantity: Math.max(1, quantity), notes: notes || undefined },
              });
              setName("");
              setCategory("");
              setQuantity(1);
              setNotes("");
            }}
          >
            <div className="sm:col-span-4">
              <Label className="text-xs font-mono">NAME</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-item-name" />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">CATEGORY</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} data-testid="input-item-category" />
            </div>
            <div className="sm:col-span-1">
              <Label className="text-xs font-mono">QTY</Label>
              <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} data-testid="input-item-qty" />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">NOTES</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-item-notes" />
            </div>
            <div className="sm:col-span-1">
              <Button type="submit" disabled={addItem.isPending || !name.trim()} className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-item">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">STASH ({items?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!items || items.length === 0 ? (
            <div className="text-muted-foreground font-mono italic">Empty.</div>
          ) : (
            <div className="space-y-2 font-mono text-sm" data-testid="list-inventory">
              {items.map((it) => (
                <div key={it.id} className="grid grid-cols-12 gap-2 border border-border/40 p-2 items-center" data-testid={`row-item-${it.id}`}>
                  <span className="col-span-3 text-foreground">{it.name}</span>
                  <span className="col-span-2 text-nc-cyan uppercase truncate">{it.category ?? "—"}</span>
                  <span className="col-span-1 text-right">x{it.quantity}</span>
                  <span className="col-span-2 truncate text-muted-foreground">{it.notes ?? ""}</span>
                  <label className="col-span-1 flex items-center gap-1 text-xs">
                    <UiSwitch
                      checked={!!it.equipped}
                      onCheckedChange={(v) => updateItem.mutate({ id: characterId, itemId: it.id, data: { equipped: v } })}
                      data-testid={`switch-equip-${it.id}`}
                    />
                    EQ
                  </label>
                  <div className="col-span-3 flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-nc-cyan h-8 px-2"
                      onClick={() => setTransferItemId(it.id)}
                      data-testid={`button-transfer-item-${it.id}`}
                    >
                      <Send className="w-3 h-3 mr-1" /> MOVE
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive h-8 w-8"
                      onClick={() => deleteItem.mutate({ id: characterId, itemId: it.id })}
                      data-testid={`button-delete-item-${it.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {transferItemId !== null && (
        <TransferItemDialog
          characterId={characterId}
          item={items?.find((i) => i.id === transferItemId) ?? null}
          onClose={() => setTransferItemId(null)}
          onDone={() => {
            setTransferItemId(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function TransferItemDialog({
  characterId,
  item,
  onClose,
  onDone,
}: {
  characterId: number;
  item: { id: number; name: string; quantity: number } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"give" | "sell">("give");
  const [toId, setToId] = useState("");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(0);
  const [memo, setMemo] = useState("");
  const transfer = useTransferInventoryItem({ mutation: { onSuccess: onDone } });
  if (!item) return null;
  const errMsg =
    (transfer.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (transfer.error ? "Transfer failed" : null);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-transfer-item">
      <Card className="rounded-none border-nc-cyan bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-cyan">
            MOVE: {item.name}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-transfer">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const toCharacterId = parseInt(toId, 10);
              if (!toCharacterId) return;
              if (mode === "sell" && price <= 0) return;
              transfer.mutate({
                id: characterId,
                itemId: item.id,
                data: {
                  toCharacterId,
                  mode,
                  quantity: qty,
                  ...(mode === "sell" ? { price } : {}),
                  ...(memo ? { memo } : {}),
                },
              });
            }}
          >
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setMode("give")}
                className={`flex-1 rounded-none font-display ${mode === "give" ? "bg-nc-cyan text-background" : "bg-transparent border border-border text-muted-foreground"}`}
                data-testid="button-mode-give"
              >
                <Send className="w-4 h-4 mr-2" /> GIVE
              </Button>
              <Button
                type="button"
                onClick={() => setMode("sell")}
                className={`flex-1 rounded-none font-display ${mode === "sell" ? "bg-nc-magenta text-background" : "bg-transparent border border-border text-muted-foreground"}`}
                data-testid="button-mode-sell"
              >
                <DollarSign className="w-4 h-4 mr-2" /> SELL
              </Button>
            </div>
            <div>
              <Label className="text-xs">TO CHARACTER ID</Label>
              <Input value={toId} onChange={(e) => setToId(e.target.value)} inputMode="numeric" data-testid="input-transfer-target" />
              <p className="text-xs text-muted-foreground mt-1">
                Find the recipient&apos;s ID on their character page URL.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">QUANTITY (max {item.quantity})</Label>
                <Input
                  type="number"
                  min={1}
                  max={item.quantity}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.min(item.quantity, Number(e.target.value))))}
                  data-testid="input-transfer-qty"
                />
              </div>
              {mode === "sell" && (
                <div>
                  <Label className="text-xs">TOTAL PRICE (€$)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={price || ""}
                    onChange={(e) => setPrice(Number(e.target.value))}
                    data-testid="input-transfer-price"
                  />
                </div>
              )}
            </div>
            <div>
              <Label className="text-xs">MEMO (optional)</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-transfer-memo" />
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-transfer-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={transfer.isPending || !toId || (mode === "sell" && price <= 0)}
              className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-confirm-transfer"
            >
              {transfer.isPending ? "MOVING..." : mode === "give" ? "CONFIRM GIVE" : "CONFIRM SALE"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function HousingCard({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: leases, isLoading } = useGetCharacterHousing(characterId);
  const vacate = useVacateHousing({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetCharacterHousingQueryKey(characterId) }),
    },
  });
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-housing">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
          <Home className="w-4 h-4" /> HOUSING
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="font-mono text-muted-foreground animate-pulse">Loading leases...</div>
        ) : !leases || leases.length === 0 ? (
          <p className="font-mono text-muted-foreground italic">
            No active leases. Browse the <a href="/catalog/rent" className="text-nc-cyan underline">housing catalog</a> to sign one.
          </p>
        ) : (
          <ul className="space-y-2 font-mono text-sm">
            {leases.map((l) => {
              const paid = l.paidThrough ? new Date(l.paidThrough) : null;
              return (
                <li
                  key={l.id}
                  className={`flex items-center justify-between gap-3 border p-3 ${l.delinquent ? "border-destructive bg-destructive/10" : "border-border/40"}`}
                  data-testid={`row-lease-${l.id}`}
                >
                  <div>
                    <div className="text-foreground">{l.address}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.tier ? <span className="text-nc-magenta uppercase mr-2">{l.tier}</span> : null}
                      <span className="text-nc-yellow">€${l.monthlyRent.toLocaleString()}/mo</span>
                      {paid ? (
                        <span className={`ml-3 ${l.delinquent ? "text-destructive" : ""}`}>
                          {l.delinquent ? "DELINQUENT — last paid through " : "Paid through "}
                          {paid.toLocaleDateString()}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive font-display"
                    onClick={() => {
                      if (confirm(`Vacate ${l.address}? Rent billing will stop.`)) vacate.mutate({ id: l.id });
                    }}
                    data-testid={`button-vacate-${l.id}`}
                  >
                    <Trash2 className="w-3 h-3 mr-1" /> VACATE
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: status, isLoading } = useGetCharacterStatus(characterId);
  const update = useUpdateCharacterStatus({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetCharacterStatusQueryKey(characterId) }),
    },
  });
  const [message, setMessage] = useState("");
  const [loaReturnsAt, setLoaReturnsAt] = useState("");

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Pinging biometric sensors...</div>;
  if (!status) return <div className="text-muted-foreground font-mono">No status data.</div>;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">STATUS</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        <ToggleRow
          label="LOA (Leave of Absence)"
          checked={status.loa}
          onChange={(v) => update.mutate({ id: characterId, data: { loa: v } })}
          testid="switch-loa"
        />
        <ToggleRow
          label="ATTENDING (events/scenes)"
          checked={status.attending}
          onChange={(v) => update.mutate({ id: characterId, data: { attending: v } })}
          testid="switch-attending"
        />
        <ToggleRow
          label="OPEN SHOP (vendor)"
          checked={status.openShop}
          onChange={(v) => update.mutate({ id: characterId, data: { openShop: v } })}
          testid="switch-openshop"
        />

        {status.loa && (
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-8">
              <Label className="text-xs">LOA RETURNS AT (ISO date/time)</Label>
              <Input
                value={loaReturnsAt || status.loaReturnsAt?.slice(0, 16) || ""}
                onChange={(e) => setLoaReturnsAt(e.target.value)}
                placeholder="2026-06-15T09:00"
                data-testid="input-loa-returns"
              />
            </div>
            <div className="col-span-4">
              <Button
                type="button"
                disabled={!loaReturnsAt}
                onClick={() => update.mutate({ id: characterId, data: { loaReturnsAt } })}
                className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
                data-testid="button-save-loa-date"
              >
                SAVE DATE
              </Button>
            </div>
          </div>
        )}

        <div>
          <Label className="text-xs">STATUS MESSAGE</Label>
          <Textarea
            value={message || status.statusMessage || ""}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="textarea-status-message"
          />
          <Button
            type="button"
            className="mt-2 rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
            onClick={() => update.mutate({ id: characterId, data: { statusMessage: message } })}
            data-testid="button-save-status-message"
          >
            UPDATE MESSAGE
          </Button>
        </div>

        <div className="text-xs text-muted-foreground">
          Last updated: {new Date(status.updatedAt).toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

function SheetSections({
  sections,
  background,
}: {
  sections?: Record<string, string>;
  background?: string | null;
}) {
  const entries = sections ? Object.entries(sections).filter(([, v]) => v && v.trim().length > 0) : [];
  // Strip internal [legacy:<uuid>] anchors stamped by the prod importer —
  // they are mapping IDs, not story content, and must never reach the UI.
  const cleanBg = (background ?? "").replace(/\[legacy:[^\]]+\]/g, "").trim() || null;
  if (entries.length === 0 && !cleanBg) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground font-mono italic">No background data recorded.</div>
        </CardContent>
      </Card>
    );
  }
  if (entries.length === 0) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="prose prose-invert prose-p:font-mono max-w-none prose-headings:font-display whitespace-pre-wrap">
            {cleanBg}
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {entries.map(([heading, body]) => (
        <Card key={heading} className="rounded-none border-border bg-card/50" data-testid={`section-${heading}`}>
          <CardHeader>
            <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{heading.toUpperCase()}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="whitespace-pre-wrap font-mono text-sm text-foreground/90">{body}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ImageGallery({ title, urls }: { title: string; urls: string[] }) {
  if (!urls || urls.length === 0) return null;
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid={`gallery-${title}`}>
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          {urls.map((u, i) => (
            <a
              key={`${u}-${i}`}
              href={u}
              target="_blank"
              rel="noreferrer"
              className="block border border-border bg-background p-1 hover:border-nc-cyan transition"
            >
              <img src={u} alt={`${title} ${i + 1}`} loading="lazy" className="max-h-56 object-contain" />
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ToggleRow({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid: string }) {
  return (
    <div className="flex items-center justify-between border border-border/40 p-3">
      <span className="text-foreground">{label}</span>
      <UiSwitch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  );
}
