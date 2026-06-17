import { useParams, Redirect, useLocation } from "wouter";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStore,
  useUpdateStore,
  useDeleteStore,
  useAddStoreEmployee,
  useUpdateStoreEmployee,
  useRemoveStoreEmployee,
  useAddStoreStock,
  useUpdateStoreStock,
  useRemoveStoreStock,
  useDepositToStore,
  useWithdrawFromStore,
  useGetStoreTransactions,
  useListStoreOffers,
  useRequestStoreStock,
  getGetStoreQueryKey,
  getGetStoreTransactionsQueryKey,
  getListStoreOffersQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, DollarSign, PackagePlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import CatalogPicker from "@/components/CatalogPicker";
import SellStockDialog from "@/components/SellStockDialog";
import PurchaseStockDialog from "@/components/PurchaseStockDialog";
import VenueOffersPanel from "@/components/VenueOffersPanel";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import StaffVenuePanel from "@/components/StaffVenuePanel";
import SingleImageUpload from "@/components/SingleImageUpload";
import VenueWalletPanel from "@/components/VenueWalletPanel";
import SelectOrCustom from "@/components/SelectOrCustom";
import {
  GUN_CATEGORIES,
  GUN_POWER_LEVELS,
  GUN_POWER_LEVEL_ALIASES,
} from "@/components/catalog/gunTypes";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

const STORE_KINDS = ["guns", "gear", "clothing", "mixed", "other"] as const;

// A gun-store stock field (category / power level) edited inline on an existing
// row. Holds local state seeded from the row so typing a custom value doesn't
// fire a save per keystroke; SelectOrCustom commits on a preset pick or on blur
// of the custom input via onCommit.
function StockRowField({
  className,
  initial,
  options,
  aliases,
  allowEmpty,
  placeholder,
  emptyLabel,
  testId,
  onCommit,
}: {
  className?: string;
  initial: string;
  options: readonly string[];
  aliases?: Record<string, string>;
  allowEmpty?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  testId?: string;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    setV(initial);
  }, [initial]);
  return (
    <SelectOrCustom
      className={className}
      value={v}
      onChange={setV}
      onCommit={onCommit}
      options={options}
      aliases={aliases}
      allowEmpty={allowEmpty}
      placeholder={placeholder}
      emptyLabel={emptyLabel}
      testId={testId}
    />
  );
}

export default function MyStoreDetail() {
  const { id } = useParams<{ id: string }>();
  const storeId = Number(id);
  const qc = useQueryClient();
  const { data: store, isLoading } = useGetStore(storeId);
  const { toast } = useToast();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetStoreQueryKey(storeId) });
  const update = useUpdateStore({ mutation: { onSuccess: invalidate } });
  const addEmp = useAddStoreEmployee({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({
          title: "Invitation sent",
          description: "The employee will see it in My Requests and must accept before they're hired.",
        });
      },
      onError: (err) => {
        toast({
          title: "Could not invite",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const requestStock = useRequestStoreStock({
    mutation: {
      onSuccess: () => {
        toast({ title: "Stock request submitted", description: "A fixer will set its cost for you to approve." });
        setStockReqOpen(false);
        setStockReqName("");
        setStockReqCategory("");
        setStockReqDescription("");
      },
      onError: (err) => {
        toast({
          title: "Could not submit request",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const updateEmp = useUpdateStoreEmployee({ mutation: { onSuccess: invalidate } });
  const removeEmp = useRemoveStoreEmployee({ mutation: { onSuccess: invalidate } });
  const addStock = useAddStoreStock({ mutation: { onSuccess: invalidate } });
  const updateStock = useUpdateStoreStock({ mutation: { onSuccess: invalidate } });
  const removeStock = useRemoveStoreStock({ mutation: { onSuccess: invalidate } });
  const { data: txns } = useGetStoreTransactions(storeId);
  const { data: offers } = useListStoreOffers(storeId);
  const invalidateWallet = () => {
    invalidate();
    qc.invalidateQueries({ queryKey: getGetStoreTransactionsQueryKey(storeId) });
  };
  const deposit = useDepositToStore({ mutation: { onSuccess: invalidateWallet } });
  const withdraw = useWithdrawFromStore({ mutation: { onSuccess: invalidateWallet } });

  const [empChar, setEmpChar] = useState<CharacterPickerValue>(null);
  const [empRole, setEmpRole] = useState("clerk");
  const [empCommission, setEmpCommission] = useState(0);
  const [stockName, setStockName] = useState("");
  const [stockCategory, setStockCategory] = useState("");
  const [stockDescription, setStockDescription] = useState("");
  const [stockPrice, setStockPrice] = useState(0);
  const [stockQty, setStockQty] = useState(1);
  const [stockPowerLevel, setStockPowerLevel] = useState("");
  const [stockCyberReq, setStockCyberReq] = useState("");
  const [sellTarget, setSellTarget] = useState<{ id: number; name: string; price: number; quantity: number } | null>(null);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [stockReqOpen, setStockReqOpen] = useState(false);
  const [stockReqName, setStockReqName] = useState("");
  const [stockReqCategory, setStockReqCategory] = useState("");
  const [stockReqDescription, setStockReqDescription] = useState("");
  // Buffered profile edits — staff change name/kind/location/purpose/description
  // freely, then commit with SAVE (no autosave-on-blur). Seeded from the loaded
  // store and re-seeded whenever a different store loads. Banner stays immediate.
  const [edit, setEdit] = useState<{
    name: string;
    kind: (typeof STORE_KINDS)[number];
    location: string;
    purpose: string;
    description: string;
  }>({ name: "", kind: "other", location: "", purpose: "", description: "" });
  useEffect(() => {
    if (!store) return;
    setEdit({
      name: store.name ?? "",
      kind: (STORE_KINDS as readonly string[]).includes(store.kind)
        ? (store.kind as (typeof STORE_KINDS)[number])
        : "other",
      location: store.location ?? "",
      purpose: store.purpose ?? "",
      description: store.description ?? "",
    });
    // Re-seed only when the underlying store identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.id]);
  const [, navigate] = useLocation();
  const deleteStore = useDeleteStore();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { data: me, viewAs } = useEffectiveMe();
  const canSetCost = !!me && (me.isFixer || me.isAdmin);
  // "Add from catalog" is an admin-only convenience for seeding stock from the
  // master gun catalog; owners/employees use the custom-stock + buy-stock flows.
  const isAdmin = !!me && me.isAdmin;
  const isStaff = !!me && (me.isAdmin || me.isFixer);
  // The store's owner can delete their own venue (backend permits owner-or-staff).
  // Staff get delete via StaffVenuePanel below, so this owner-only card is hidden
  // for staff to avoid two delete controls.
  const isOwner = !!me && !!store && store.ownerId === me.id;
  // Gun stores carry a regulated catalog: their OWNERS may only VIEW stock —
  // all editing (add/edit/delete + power level) is staff-only. This mirrors the
  // server gate in routes/stores.ts; the UI just avoids dead 403 controls.
  const isGunStore = store?.kind === "guns";
  const canEditStock = !isGunStore || isStaff;
  // Power level is a gun-store-only field, and only staff edit it.
  const showPowerLevel = isGunStore;

  // When an admin previews the app as a lower-privilege role, the management
  // view must hide just like it would for that role. Send them to the public
  // storefront instead of leaking the manage UI.
  if (viewAs && !(me?.isAdmin || me?.isFixer)) {
    return <Redirect to={`/directory/stores/${storeId}`} />;
  }

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!store) return <div className="font-display text-destructive">NOT FOUND</div>;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-store-name">{store.name}</h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="font-display tracking-widest">EDIT</CardTitle>
          <Button
            size="sm"
            disabled={update.isPending || !edit.name.trim()}
            onClick={() =>
              update.mutate(
                {
                  id: storeId,
                  data: {
                    name: edit.name.trim(),
                    kind: edit.kind,
                    location: edit.location.trim() || null,
                    purpose: edit.purpose.trim() || null,
                    description: edit.description.trim() || null,
                  },
                },
                {
                  onSuccess: () => toast({ title: "Saved", description: "Store details updated." }),
                  onError: (err) =>
                    toast({
                      title: "Could not save",
                      description: err instanceof Error ? err.message : "Please try again.",
                      variant: "destructive",
                    }),
                },
              )
            }
            className="rounded-none bg-nc-cyan text-background font-display"
            data-testid="button-save-store"
          >
            {update.isPending ? "SAVING..." : "SAVE"}
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input value={edit.name} onChange={(e) => setEdit((p) => ({ ...p, name: e.target.value }))} placeholder="Name" data-testid="input-edit-name" />
          <select
            value={edit.kind}
            onChange={(e) => setEdit((p) => ({ ...p, kind: e.target.value as (typeof STORE_KINDS)[number] }))}
            className="rounded-none border border-input bg-background px-3 py-2 font-mono text-sm uppercase"
            data-testid="select-edit-kind"
          >
            {STORE_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <Input value={edit.location} onChange={(e) => setEdit((p) => ({ ...p, location: e.target.value }))} placeholder="Location" data-testid="input-edit-location" />
          <Input value={edit.purpose} onChange={(e) => setEdit((p) => ({ ...p, purpose: e.target.value }))} placeholder="Purpose (what this store is for)" data-testid="input-edit-purpose" />
          <Textarea className="md:col-span-2" value={edit.description} onChange={(e) => setEdit((p) => ({ ...p, description: e.target.value }))} placeholder="Description" data-testid="input-edit-description" />
          <div className="md:col-span-2 space-y-1">
            <p className="font-mono text-xs text-muted-foreground uppercase">Banner</p>
            <SingleImageUpload
              value={store.bannerUrl ?? ""}
              onChange={(url) => update.mutate({ id: storeId, data: { bannerUrl: url || null } })}
              testIdPrefix="store-banner"
              alt="Store banner"
            />
          </div>
        </CardContent>
      </Card>

      <VenueWalletPanel
        balance={store.balance ?? 0}
        transactions={txns ?? []}
        busy={deposit.isPending || withdraw.isPending}
        onDeposit={(amount) => deposit.mutateAsync({ id: storeId, data: { amount, idempotencyKey: crypto.randomUUID() } })}
        onWithdraw={(amount) => withdraw.mutateAsync({ id: storeId, data: { amount, idempotencyKey: crypto.randomUUID() } })}
        accent="cyan"
        testIdPrefix="store"
      />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EMPLOYEES</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {store.employees.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 py-2 font-mono text-sm" data-testid={`row-employee-${e.id}`}>
              <span>{e.name} <span className="text-nc-cyan uppercase ml-2">{e.role}</span></span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs uppercase">Commission</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={e.commissionPct}
                  onBlur={(ev) => {
                    const pct = Math.max(0, Math.min(100, Number(ev.target.value)));
                    if (pct !== e.commissionPct) updateEmp.mutate({ id: storeId, employeeId: e.id, data: { commissionPct: pct } });
                  }}
                  className="w-20 h-8"
                  data-testid={`input-employee-commission-${e.id}`}
                />
                <span className="text-muted-foreground text-xs">%</span>
                <Button size="icon" variant="ghost" onClick={() => removeEmp.mutate({ id: storeId, employeeId: e.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 pt-3">
            <div className="md:col-span-5"><CharacterPicker value={empChar} onChange={setEmpChar} testId="input-add-employee-id" /></div>
            <Input className="md:col-span-3" placeholder="Role" value={empRole} onChange={(e) => setEmpRole(e.target.value)} data-testid="input-add-employee-role" />
            <Input
              className="md:col-span-2"
              type="number"
              min={0}
              max={100}
              placeholder="Comm %"
              value={empCommission || ""}
              onChange={(e) => setEmpCommission(Number(e.target.value))}
              data-testid="input-add-employee-commission"
            />
            <Button
              disabled={!empChar?.id}
              onClick={() => {
                if (!empChar?.id) return;
                addEmp.mutate({ id: storeId, data: { characterId: empChar.id, role: empRole, commissionPct: Math.max(0, Math.min(100, empCommission)) } });
                setEmpChar(null);
                setEmpCommission(0);
              }}
              className="md:col-span-2 rounded-none bg-nc-cyan text-background font-display"
              data-testid="button-add-employee"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="font-display tracking-widest">STOCK</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStockReqOpen(true)}
              className="rounded-none font-display"
              data-testid="button-open-stock-request"
            >
              <PackagePlus className="w-3 h-3 mr-1" /> REQUEST CUSTOM STOCK
            </Button>
            {canEditStock && (
              <Button
                size="sm"
                onClick={() => setPurchaseOpen(true)}
                className="rounded-none bg-nc-cyan text-background font-display"
                data-testid="button-open-purchase"
              >
                <Plus className="w-3 h-3 mr-1" /> BUY STOCK (STORE-FUNDED)
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {!canEditStock && (
            <p className="font-mono text-xs text-muted-foreground" data-testid="text-stock-readonly-note">
              Gun-store stock is managed by staff. You can view it and sell to customers, but item details and power levels are set by an admin or fixer.
            </p>
          )}
          {store.stock.map((s) => {
          if (canEditStock) {
            return (
            <div key={s.id} className="space-y-1 border-b border-border/30 py-2" data-testid={`row-stock-${s.id}`}>
              <div className="grid grid-cols-12 gap-2 items-center">
                <Input className="col-span-4" defaultValue={s.name} onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { name: e.target.value } })} />
                <Input className="col-span-2" type="number" defaultValue={s.price} onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { price: Number(e.target.value) } })} />
                <Input className="col-span-2" type="number" defaultValue={s.quantity} onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { quantity: Number(e.target.value) } })} />
                {isGunStore ? (
                  <StockRowField
                    className="col-span-2"
                    initial={s.category ?? ""}
                    options={GUN_CATEGORIES}
                    placeholder="Category"
                    emptyLabel="— Category —"
                    testId={`select-stock-category-${s.id}`}
                    onCommit={(v) => updateStock.mutate({ id: storeId, stockId: s.id, data: { category: v } })}
                  />
                ) : (
                  <Input className="col-span-2" defaultValue={s.category ?? ""} placeholder="Category" onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { category: e.target.value } })} />
                )}
                <Button
                  size="sm"
                  onClick={() => setSellTarget({ id: s.id, name: s.name, price: s.price, quantity: s.quantity })}
                  disabled={s.quantity <= 0}
                  className="col-span-1 rounded-none bg-nc-cyan text-background font-display text-xs"
                  data-testid={`button-sell-${s.id}`}
                >
                  <DollarSign className="w-3 h-3" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => removeStock.mutate({ id: storeId, stockId: s.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
              <div className="grid grid-cols-12 gap-2">
                <Input
                  className={`${showPowerLevel ? "col-span-8" : "col-span-12"} font-mono text-xs`}
                  defaultValue={s.description ?? ""}
                  placeholder="Description"
                  onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { description: e.target.value } })}
                  data-testid={`input-stock-description-${s.id}`}
                />
                {showPowerLevel && (
                  <StockRowField
                    className="col-span-4 font-mono text-xs"
                    initial={s.powerLevel ?? ""}
                    options={GUN_POWER_LEVELS}
                    aliases={GUN_POWER_LEVEL_ALIASES}
                    placeholder="Power level"
                    emptyLabel="— Power level —"
                    testId={`input-stock-power-${s.id}`}
                    onCommit={(v) => updateStock.mutate({ id: storeId, stockId: s.id, data: { powerLevel: v } })}
                  />
                )}
              </div>
              {showPowerLevel && (
                <div className="grid grid-cols-12 gap-2">
                  <Input
                    className="col-span-12 font-mono text-xs"
                    defaultValue={s.cyberwareReq ?? ""}
                    placeholder="Required cyberware to operate (optional)"
                    onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { cyberwareReq: e.target.value } })}
                    data-testid={`input-stock-cyberreq-${s.id}`}
                  />
                </div>
              )}
            </div>
            );
          }

          return (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 py-2 font-mono text-sm"
              data-testid={`row-stock-${s.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-bold" data-testid={`text-stock-name-${s.id}`}>{s.name}</span>
                {s.category && <span className="text-nc-cyan uppercase text-xs">{s.category}</span>}
                {showPowerLevel && s.powerLevel && (
                  <span className="text-nc-yellow uppercase text-xs" data-testid={`text-stock-power-${s.id}`}>PWR: {s.powerLevel}</span>
                )}
                {showPowerLevel && s.cyberwareReq && (
                  <span className="text-nc-magenta uppercase text-xs" data-testid={`text-stock-cyberreq-${s.id}`}>REQ: {s.cyberwareReq}</span>
                )}
                <span className="text-muted-foreground text-xs">Qty {s.quantity}</span>
                {s.description && <span className="text-muted-foreground text-xs">{s.description}</span>}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-nc-yellow">{s.price.toLocaleString()} €$</span>
                <Button
                  size="sm"
                  onClick={() => setSellTarget({ id: s.id, name: s.name, price: s.price, quantity: s.quantity })}
                  disabled={s.quantity <= 0}
                  className="rounded-none bg-nc-cyan text-background font-display text-xs"
                  data-testid={`button-sell-${s.id}`}
                >
                  <DollarSign className="w-3 h-3" />
                </Button>
              </div>
            </div>
          );
          })}
          {canEditStock && (
            <div className="pt-3 space-y-2">
              {isAdmin && (
                <div className="flex justify-end">
                  <CatalogPicker
                    kind="guns"
                    triggerLabel="ADD FROM CATALOG (ADMIN)"
                    onPick={(item) => {
                      setStockName(item.name);
                      setStockCategory(item.category ?? "");
                      setStockPrice(item.price);
                      setStockPowerLevel(item.powerLevel ?? "");
                      setStockCyberReq(item.cyberwareReq ?? "");
                      if (stockQty < 1) setStockQty(1);
                    }}
                  />
                </div>
              )}
              <div className="grid grid-cols-12 gap-2">
                <Input className="col-span-4" placeholder="Item name" value={stockName} onChange={(e) => setStockName(e.target.value)} data-testid="input-add-stock-name" />
                {isGunStore ? (
                  <SelectOrCustom
                    className="col-span-3"
                    value={stockCategory}
                    onChange={setStockCategory}
                    options={GUN_CATEGORIES}
                    placeholder="Category"
                    emptyLabel="— Category —"
                    testId="input-add-stock-category"
                  />
                ) : (
                  <Input className="col-span-3" placeholder="Category / type" value={stockCategory} onChange={(e) => setStockCategory(e.target.value)} data-testid="input-add-stock-category" />
                )}
                <Input className="col-span-2" type="number" placeholder="Price" value={stockPrice} onChange={(e) => setStockPrice(Number(e.target.value))} data-testid="input-add-stock-price" />
                <Input className="col-span-1" type="number" placeholder="Qty" value={stockQty} onChange={(e) => setStockQty(Number(e.target.value))} data-testid="input-add-stock-qty" />
                <Button
                  className="col-span-2 rounded-none bg-nc-cyan text-background font-display"
                  disabled={!stockName.trim() || stockPrice < 0 || addStock.isPending}
                  onClick={() => {
                    if (!stockName.trim()) return;
                    addStock.mutate({
                      id: storeId,
                      data: {
                        name: stockName.trim(),
                        category: stockCategory || undefined,
                        description: stockDescription || undefined,
                        price: stockPrice,
                        quantity: stockQty,
                        ...(showPowerLevel && stockPowerLevel.trim() ? { powerLevel: stockPowerLevel.trim() } : {}),
                        ...(showPowerLevel && stockCyberReq.trim() ? { cyberwareReq: stockCyberReq.trim() } : {}),
                      },
                    });
                    setStockName("");
                    setStockCategory("");
                    setStockDescription("");
                    setStockPrice(0);
                    setStockQty(1);
                    setStockPowerLevel("");
                    setStockCyberReq("");
                  }}
                  data-testid="button-add-stock"
                >
                  <Plus className="w-4 h-4 mr-1" /> ADD
                </Button>
                <Input
                  className={`${showPowerLevel ? "col-span-8" : "col-span-12"} font-mono text-xs`}
                  placeholder="Description (optional)"
                  value={stockDescription}
                  onChange={(e) => setStockDescription(e.target.value)}
                  data-testid="input-add-stock-description"
                />
                {showPowerLevel && (
                  <SelectOrCustom
                    className="col-span-4 font-mono text-xs"
                    value={stockPowerLevel}
                    onChange={setStockPowerLevel}
                    options={GUN_POWER_LEVELS}
                    aliases={GUN_POWER_LEVEL_ALIASES}
                    placeholder="Power level (optional)"
                    emptyLabel="— Power level —"
                    testId="input-add-stock-power"
                  />
                )}
                {showPowerLevel && (
                  <Input
                    className="col-span-12 font-mono text-xs"
                    placeholder="Required cyberware to operate (optional)"
                    value={stockCyberReq}
                    onChange={(e) => setStockCyberReq(e.target.value)}
                    data-testid="input-add-stock-cyberreq"
                  />
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <VenueOffersPanel offers={offers ?? []} />
      {isOwner && !isStaff && (
        <Card className="rounded-none border-destructive/40 bg-card/50" data-testid="panel-owner-danger">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-destructive flex items-center gap-2">
              <Trash2 className="w-4 h-4" /> DANGER ZONE
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!confirmingDelete ? (
              <Button
                variant="ghost"
                onClick={() => setConfirmingDelete(true)}
                className="text-destructive rounded-none"
                data-testid="button-delete-store"
              >
                <Trash2 className="w-4 h-4 mr-2" /> DELETE STORE
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-destructive">
                  Permanently delete this store and all its stock &amp; staff?
                </span>
                <Button
                  variant="destructive"
                  disabled={deleteStore.isPending}
                  onClick={() =>
                    deleteStore.mutate(
                      { id: storeId },
                      {
                        onSuccess: () => {
                          toast({ title: "Store deleted" });
                          navigate("/stores");
                        },
                        onError: () =>
                          toast({ title: "Delete failed", description: "Could not delete store.", variant: "destructive" }),
                      },
                    )
                  }
                  className="rounded-none"
                  data-testid="button-confirm-delete-store"
                >
                  {deleteStore.isPending ? "DELETING..." : "CONFIRM DELETE"}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)} className="rounded-none">
                  CANCEL
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {!!me && (me.isAdmin || me.isFixer) && (
        <StaffVenuePanel
          kind="store"
          venueId={storeId}
          currentHousingId={store?.housingId ?? null}
          currentLeaseLabel={store?.lease ? store.lease.address : null}
          onChanged={invalidate}
        />
      )}
      {sellTarget && (
        <SellStockDialog
          kind="store"
          venueId={storeId}
          stock={sellTarget}
          onClose={() => setSellTarget(null)}
          onDone={() => {
            invalidate();
            qc.invalidateQueries({ queryKey: getListStoreOffersQueryKey(storeId) });
            setSellTarget(null);
          }}
        />
      )}
      {purchaseOpen && (
        <PurchaseStockDialog
          kind="store"
          venueId={storeId}
          balance={store.balance ?? 0}
          canSetCost={canSetCost}
          onClose={() => setPurchaseOpen(false)}
          onDone={() => {
            invalidate();
            setPurchaseOpen(false);
          }}
        />
      )}
      <Dialog open={stockReqOpen} onOpenChange={setStockReqOpen}>
        <DialogContent className="rounded-none border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">Request Custom Stock</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Ask a fixer to price a custom item for this store. Once they set a cost, you approve it from My Requests and pay to stock it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Item</Label>
              <Input
                value={stockReqName}
                onChange={(e) => setStockReqName(e.target.value)}
                placeholder="e.g. Custom Tsunami Nue"
                className="rounded-none font-mono"
                data-testid="input-stock-request-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Category (optional)</Label>
              <Input
                value={stockReqCategory}
                onChange={(e) => setStockReqCategory(e.target.value)}
                placeholder="e.g. guns"
                className="rounded-none font-mono"
                data-testid="input-stock-request-category"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                value={stockReqDescription}
                onChange={(e) => setStockReqDescription(e.target.value)}
                placeholder="Tell the fixer what you want and any details."
                className="rounded-none font-mono min-h-[100px]"
                data-testid="input-stock-request-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="rounded-none font-display" onClick={() => setStockReqOpen(false)}>
              CANCEL
            </Button>
            <Button
              className="rounded-none font-display tracking-widest bg-nc-cyan text-background hover:bg-nc-cyan/80"
              disabled={!stockReqName.trim() || requestStock.isPending}
              onClick={() =>
                requestStock.mutate({
                  id: storeId,
                  data: {
                    name: stockReqName.trim(),
                    category: stockReqCategory.trim() || undefined,
                    description: stockReqDescription.trim() || undefined,
                  },
                })
              }
              data-testid="button-submit-stock-request"
            >
              {requestStock.isPending ? "SUBMITTING..." : "SUBMIT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
