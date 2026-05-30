import { useParams } from "wouter";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRipperdoc,
  useUpdateRipperdoc,
  useAddRipperdocEmployee,
  useUpdateRipperdocEmployee,
  useRemoveRipperdocEmployee,
  useAddRipperdocStock,
  useRemoveRipperdocStock,
  useDepositToRipperdoc,
  useWithdrawFromRipperdoc,
  useGetRipperdocTransactions,
  getGetRipperdocQueryKey,
  getGetRipperdocTransactionsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, DollarSign } from "lucide-react";
import CatalogPicker from "@/components/CatalogPicker";
import SellStockDialog from "@/components/SellStockDialog";
import PurchaseStockDialog from "@/components/PurchaseStockDialog";
import WholesalerRestockDialog from "@/components/WholesalerRestockDialog";
import WholesalerOrdersPanel from "@/components/WholesalerOrdersPanel";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import StaffVenuePanel from "@/components/StaffVenuePanel";
import SingleImageUpload from "@/components/SingleImageUpload";
import VenueWalletPanel from "@/components/VenueWalletPanel";
import { useAuthMe } from "@/hooks/useAuthMe";

export default function MyClinicDetail() {
  const { id } = useParams<{ id: string }>();
  const rid = Number(id);
  const qc = useQueryClient();
  const { data, isLoading } = useGetRipperdoc(rid);
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetRipperdocQueryKey(rid) });
  const update = useUpdateRipperdoc({ mutation: { onSuccess: invalidate } });
  const addEmp = useAddRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const updateEmp = useUpdateRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const removeEmp = useRemoveRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const addStock = useAddRipperdocStock({ mutation: { onSuccess: invalidate } });
  const removeStock = useRemoveRipperdocStock({ mutation: { onSuccess: invalidate } });
  const { data: txns } = useGetRipperdocTransactions(rid);
  const invalidateWallet = () => {
    invalidate();
    qc.invalidateQueries({ queryKey: getGetRipperdocTransactionsQueryKey(rid) });
  };
  const deposit = useDepositToRipperdoc({ mutation: { onSuccess: invalidateWallet } });
  const withdraw = useWithdrawFromRipperdoc({ mutation: { onSuccess: invalidateWallet } });

  const [empChar, setEmpChar] = useState<CharacterPickerValue>(null);
  const [empRole, setEmpRole] = useState("doc");
  const [empCommission, setEmpCommission] = useState(0);
  const [stockName, setStockName] = useState("");
  const [stockCategory, setStockCategory] = useState("");
  const [stockPrice, setStockPrice] = useState(0);
  const [sellTarget, setSellTarget] = useState<{ id: number; name: string; price: number; quantity: number } | null>(null);
  const [restockOpen, setRestockOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const { data: me } = useAuthMe();
  const canRestock = !!me && (me.isFixer || me.isAdmin);

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">NOT FOUND</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-clinic-name">{data.name}</h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EDIT</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input defaultValue={data.name} onBlur={(e) => update.mutate({ id: rid, data: { name: e.target.value } })} data-testid="input-edit-name" />
          <Input defaultValue={data.location ?? ""} placeholder="Location" onBlur={(e) => update.mutate({ id: rid, data: { location: e.target.value } })} data-testid="input-edit-location" />
          <Input className="md:col-span-2" defaultValue={data.purpose ?? ""} placeholder="Purpose (what this clinic is for)" onBlur={(e) => update.mutate({ id: rid, data: { purpose: e.target.value } })} data-testid="input-edit-purpose" />
          <Textarea className="md:col-span-2" defaultValue={data.description ?? ""} placeholder="Description" onBlur={(e) => update.mutate({ id: rid, data: { description: e.target.value } })} data-testid="input-edit-description" />
          <div className="md:col-span-2 space-y-1">
            <p className="font-mono text-xs text-muted-foreground uppercase">Banner</p>
            <SingleImageUpload
              value={data.bannerUrl ?? ""}
              onChange={(url) => update.mutate({ id: rid, data: { bannerUrl: url || null } })}
              testIdPrefix="clinic-banner"
              alt="Clinic banner"
            />
          </div>
        </CardContent>
      </Card>
      {!!me && (me.isAdmin || me.isFixer) && (
        <StaffVenuePanel kind="ripperdoc" venueId={rid} onChanged={invalidate} />
      )}

      <VenueWalletPanel
        balance={data.balance ?? 0}
        transactions={txns ?? []}
        busy={deposit.isPending || withdraw.isPending}
        onDeposit={(amount) => deposit.mutate({ id: rid, data: { amount } })}
        onWithdraw={(amount) => withdraw.mutate({ id: rid, data: { amount } })}
        accent="magenta"
        testIdPrefix="clinic"
      />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">DOCS</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.employees.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 py-2 font-mono text-sm" data-testid={`row-doc-${e.id}`}>
              <span>{e.name} <span className="text-nc-magenta uppercase ml-2">{e.role}</span></span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs uppercase">Commission</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={e.commissionPct}
                  onBlur={(ev) => {
                    const pct = Math.max(0, Math.min(100, Number(ev.target.value)));
                    if (pct !== e.commissionPct) updateEmp.mutate({ id: rid, employeeId: e.id, data: { commissionPct: pct } });
                  }}
                  className="w-20 h-8"
                  data-testid={`input-doc-commission-${e.id}`}
                />
                <span className="text-muted-foreground text-xs">%</span>
                <Button size="icon" variant="ghost" onClick={() => removeEmp.mutate({ id: rid, employeeId: e.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 pt-3">
            <div className="md:col-span-5"><CharacterPicker value={empChar} onChange={setEmpChar} testId="input-add-doc-id" /></div>
            <Input className="md:col-span-3" placeholder="Role" value={empRole} onChange={(e) => setEmpRole(e.target.value)} data-testid="input-add-doc-role" />
            <Input
              className="md:col-span-2"
              type="number"
              min={0}
              max={100}
              placeholder="Comm %"
              value={empCommission || ""}
              onChange={(e) => setEmpCommission(Number(e.target.value))}
              data-testid="input-add-doc-commission"
            />
            <Button
              disabled={!empChar?.id}
              onClick={() => {
                if (!empChar?.id) return;
                addEmp.mutate({ id: rid, data: { characterId: empChar.id, role: empRole, commissionPct: Math.max(0, Math.min(100, empCommission)) } });
                setEmpChar(null);
                setEmpCommission(0);
              }}
              className="md:col-span-2 rounded-none bg-nc-magenta text-background font-display"
              data-testid="button-add-doc"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="font-display tracking-widest">CYBERWARE STOCK</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setPurchaseOpen(true)}
              className="rounded-none bg-nc-cyan text-background font-display"
              data-testid="button-open-purchase"
            >
              <Plus className="w-3 h-3 mr-1" /> BUY STOCK (CLINIC-FUNDED)
            </Button>
            {canRestock && (
              <Button
                size="sm"
                onClick={() => setRestockOpen(true)}
                className="rounded-none bg-nc-magenta text-background font-display"
                data-testid="button-open-restock"
              >
                <Plus className="w-3 h-3 mr-1" /> RESTOCK FROM WHOLESALER
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.stock.map((s) => (
            <div key={s.id} className="flex justify-between items-center border-b border-border/30 py-2 font-mono text-sm">
              <span>{s.name} <span className="text-nc-yellow ml-2">{s.price.toLocaleString()} €$</span> <span className="text-muted-foreground ml-2">x{s.quantity}</span></span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  onClick={() => setSellTarget({ id: s.id, name: s.name, price: s.price, quantity: s.quantity })}
                  disabled={s.quantity <= 0}
                  className="rounded-none bg-nc-magenta text-background font-display text-xs"
                  data-testid={`button-install-${s.id}`}
                >
                  <DollarSign className="w-3 h-3 mr-1" /> INSTALL
                </Button>
                <Button size="icon" variant="ghost" onClick={() => removeStock.mutate({ id: rid, stockId: s.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
          <div className="pt-3 space-y-2">
            <div className="flex justify-end">
              <CatalogPicker
                kind="cyberware"
                triggerClassName="rounded-none font-display border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background"
                onPick={(item) => {
                  setStockName(item.name);
                  setStockCategory(item.category ?? "");
                  setStockPrice(item.price);
                }}
              />
            </div>
            <div className="flex gap-2">
              <Input className="flex-1" placeholder="Cyberware name" value={stockName} onChange={(e) => setStockName(e.target.value)} data-testid="input-add-cyber-name" />
              <Input className="w-32" placeholder="Slot" value={stockCategory} onChange={(e) => setStockCategory(e.target.value)} data-testid="input-add-cyber-slot" />
              <Input className="w-32" type="number" placeholder="Price" value={stockPrice} onChange={(e) => setStockPrice(Number(e.target.value))} data-testid="input-add-cyber-price" />
              <Button
                onClick={() => {
                  if (!stockName) return;
                  addStock.mutate({ id: rid, data: { name: stockName, category: stockCategory || undefined, price: stockPrice, quantity: 1 } });
                  setStockName("");
                  setStockCategory("");
                  setStockPrice(0);
                }}
                className="rounded-none bg-nc-magenta text-background font-display"
                data-testid="button-add-cyber"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <WholesalerOrdersPanel kind="ripperdoc" venueId={rid} />
      {sellTarget && (
        <SellStockDialog
          kind="ripperdoc"
          venueId={rid}
          stock={sellTarget}
          onClose={() => setSellTarget(null)}
          onDone={() => {
            invalidate();
            setSellTarget(null);
          }}
        />
      )}
      {restockOpen && (
        <WholesalerRestockDialog
          kind="ripperdoc"
          venueId={rid}
          onClose={() => setRestockOpen(false)}
          onDone={() => {
            invalidate();
            setRestockOpen(false);
          }}
        />
      )}
      {purchaseOpen && (
        <PurchaseStockDialog
          kind="ripperdoc"
          venueId={rid}
          balance={data.balance ?? 0}
          onClose={() => setPurchaseOpen(false)}
          onDone={() => {
            invalidate();
            setPurchaseOpen(false);
          }}
        />
      )}
    </div>
  );
}
