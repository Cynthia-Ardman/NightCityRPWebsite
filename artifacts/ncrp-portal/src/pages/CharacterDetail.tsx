import {
  useGetCharacter,
  useGetWallet,
  useGetWalletTransactions,
  useTransferEddies,
  useGetCharacterInventory,
  useAddInventoryItem,
  useUpdateInventoryItem,
  useRemoveInventoryItem,
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
import { Shield, ShieldAlert, Wallet, Package, Activity, Terminal, Plus, Trash2, AlertTriangle } from "lucide-react";
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
          <AvatarImage src={char.portraitUrl || ""} className="object-cover rounded-none" />
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
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader>
                <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
              </CardHeader>
              <CardContent>
                {char.background ? (
                  <div className="prose prose-invert prose-p:font-mono max-w-none prose-headings:font-display whitespace-pre-wrap">
                    {char.background}
                  </div>
                ) : (
                  <div className="text-muted-foreground font-mono italic">No background data recorded.</div>
                )}
              </CardContent>
            </Card>
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
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) });
  const addItem = useAddInventoryItem({ mutation: { onSuccess: invalidate } });
  const updateItem = useUpdateInventoryItem({ mutation: { onSuccess: invalidate } });
  const deleteItem = useRemoveInventoryItem({ mutation: { onSuccess: invalidate } });
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

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
                  <span className="col-span-4 text-foreground">{it.name}</span>
                  <span className="col-span-2 text-nc-cyan uppercase">{it.category ?? "—"}</span>
                  <span className="col-span-1 text-right">x{it.quantity}</span>
                  <span className="col-span-3 truncate text-muted-foreground">{it.notes ?? ""}</span>
                  <label className="col-span-1 flex items-center gap-1 text-xs">
                    <UiSwitch
                      checked={!!it.equipped}
                      onCheckedChange={(v) => updateItem.mutate({ id: characterId, itemId: it.id, data: { equipped: v } })}
                      data-testid={`switch-equip-${it.id}`}
                    />
                    EQ
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="col-span-1 text-destructive justify-self-end"
                    onClick={() => deleteItem.mutate({ id: characterId, itemId: it.id })}
                    data-testid={`button-delete-item-${it.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
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

function ToggleRow({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid: string }) {
  return (
    <div className="flex items-center justify-between border border-border/40 p-3">
      <span className="text-foreground">{label}</span>
      <UiSwitch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  );
}
